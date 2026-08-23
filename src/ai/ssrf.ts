// SSRF-safe fetching for the AI web_fetch tool.
// The IP allow/deny decision happens inside undici's connect-time DNS lookup
// (not before the fetch), so a DNS rebinding attack cannot swap a validated
// public IP for a private one between check and connect.

import { Agent, fetch as undiciFetch } from 'undici';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

const DEFAULT_MAX_REDIRECTS = 5;

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIpv4(num: number): boolean {
  return (
    (num <= 0x00ffffff) ||                         // 0.0.0.0/8
    (num >= 0x0a000000 && num <= 0x0affffff) ||    // 10.0.0.0/8
    (num >= 0x64400000 && num <= 0x647fffff) ||    // 100.64.0.0/10 (CGNAT)
    (num >= 0x7f000000 && num <= 0x7fffffff) ||    // 127.0.0.0/8
    (num >= 0xa9fe0000 && num <= 0xa9feffff) ||    // 169.254.0.0/16 (link-local, cloud metadata)
    (num >= 0xac100000 && num <= 0xac1fffff) ||    // 172.16.0.0/12
    (num >= 0xc0000000 && num <= 0xc00000ff) ||    // 192.0.0.0/24
    (num >= 0xc0000200 && num <= 0xc00002ff) ||    // 192.0.2.0/24 (documentation)
    (num >= 0xc6120000 && num <= 0xc613ffff) ||    // 198.18.0.0/15 (benchmarking)
    (num >= 0xc6336400 && num <= 0xc63364ff) ||    // 198.51.100.0/24 (documentation)
    (num >= 0xcb007100 && num <= 0xcb0071ff) ||    // 203.0.113.0/24 (documentation)
    (num >= 0xc0a80000 && num <= 0xc0a8ffff) ||    // 192.168.0.0/16
    num >= 0xe0000000                             // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, broadcast
  );
}

function isBlockedIpv6(ip: string): boolean {
  if (!ip.includes(':')) return true; // not an IPv6 address at all
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;  // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true;                        // fe80::/10 link-local
  if (ip.startsWith('ff')) return true;                         // ff00::/8 multicast
  if (ip.startsWith('2001:db8')) return true;                   // documentation
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = ipv4ToNumber(normalized.slice(7));
    return ipv4 === null || isBlockedIpv4(ipv4);
  }
  if (normalized.includes('.')) {
    const ipv4 = ipv4ToNumber(normalized);
    return ipv4 === null || isBlockedIpv4(ipv4);
  }
  return isBlockedIpv6(normalized);
}

function parseUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('URLs with credentials are not allowed');
  }
  if (!url.hostname) {
    throw new Error('URL has no host');
  }
  if (isIP(url.hostname) && isBlockedIp(url.hostname)) {
    throw new Error(`Blocked address ${url.hostname}`);
  }
  return url;
}

// Connect-time DNS lookup used by undici: resolves all addresses and rejects
// the connection when ANY of them is blocked, then hands undici the first
// non-blocked address.
function safeLookup(
  hostname: string,
  _options: unknown,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const list = (addresses ?? []) as LookupAddress[];
    if (list.length === 0) {
      callback(new Error(`No addresses for ${hostname}`), '');
      return;
    }
    if (list.some(entry => isBlockedIp(entry.address))) {
      callback(new Error(`Blocked address for ${hostname}`), '');
      return;
    }
    const first = list[0];
    callback(null, first.address, first.family);
  });
}

async function readBodyCapped(
  body: { getReader(): any } | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read() as { done: boolean; value?: Uint8Array };
    if (done || !value) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    const slice = value.subarray(0, remaining);
    chunks.push(slice);
    total += slice.length;
    if (value.length > remaining) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(buffer), truncated };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WebFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface WebFetchResult {
  status: number;
  finalUrl: string;
  text: string;
  truncated: boolean;
}

export async function fetchWithSsrfProtection(rawUrl: string, options: WebFetchOptions): Promise<WebFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = parseUrl(currentUrl);
    const agent = new Agent({ connect: { lookup: safeLookup } });
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    const timedOut = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeout = setTimeout(timedOut, options.timeoutMs);
    try {
      const response = await undiciFetch(url.toString(), {
        dispatcher: agent,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'crash-report-server-ai/1.0',
          accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error('Redirect without a location header');
        currentUrl = new URL(location, url).toString();
        continue;
      }
      const { text, truncated } = await readBodyCapped(response.body, options.maxBytes);
      const contentType = response.headers.get('content-type') ?? '';
      const finalText = contentType.includes('text/html') || contentType.includes('application/xhtml') ? stripHtml(text) : text;
      return { status: response.status, finalUrl: url.toString(), text: finalText, truncated };
    } catch (error) {
      if (options.signal?.aborted) throw new Error('Web fetch was stopped');
      if (controller.signal.aborted && !options.signal?.aborted) throw new Error('Web fetch timed out');
      // undici wraps connect-time failures (our lookup rejections included)
      // as "fetch failed" with the real message on `cause`.
      const chain: unknown[] = [error];
      let cursor: unknown = error;
      let depth = 0;
      while (cursor instanceof Error && (cursor as Error & { cause?: unknown }).cause && depth < 4) {
        cursor = (cursor as Error & { cause?: unknown }).cause;
        chain.push(cursor);
        depth++;
      }
      const messages = chain
        .filter((entry): entry is Error => entry instanceof Error)
        .map(entry => entry.message)
        .join(' | ');
      if (messages.includes('Blocked address')) {
        throw new Error(`Blocked address for ${url.hostname}`);
      }
      throw error instanceof Error ? new Error(`Web fetch failed: ${error.message}`) : new Error('Web fetch failed');
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', abortFromCaller);
      await agent.close().catch(() => {});
    }
  }
  throw new Error('Too many redirects');
}
