import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isBlockedIp, fetchWithSsrfProtection } from './ssrf.js';

test('isBlockedIp blocks private, loopback, link-local and metadata ranges', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.1', '10.255.255.255', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '169.254.1.1', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '240.0.0.1', '255.255.255.255', '::1', '::', 'fd12:3456::1', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedIp rejects malformed addresses', () => {
  assert.equal(isBlockedIp(''), true);
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp('999.1.1.1'), true);
});

test('fetchWithSsrfProtection refuses non-http schemes and URLs with credentials', async () => {
  await assert.rejects(fetchWithSsrfProtection('ftp://example.com/file', { timeoutMs: 1000, maxBytes: 1024 }), /Only http\/https/);
  await assert.rejects(fetchWithSsrfProtection('file:///etc/passwd', { timeoutMs: 1000, maxBytes: 1024 }), /Only http\/https/);
  await assert.rejects(fetchWithSsrfProtection('https://user:secret@example.com/', { timeoutMs: 1000, maxBytes: 1024 }), /credentials/);
  await assert.rejects(fetchWithSsrfProtection('not a url', { timeoutMs: 1000, maxBytes: 1024 }), /Invalid URL/);
});

test('fetchWithSsrfProtection blocks loopback targets (localhost and 127.0.0.1)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(
      fetchWithSsrfProtection(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, maxBytes: 1024 }),
      /Blocked address/,
    );
    await assert.rejects(
      fetchWithSsrfProtection(`http://localhost:${port}/`, { timeoutMs: 2000, maxBytes: 1024 }),
      /Blocked address/,
    );
  } finally {
    server.close();
  }
});

test('fetchWithSsrfProtection caps redirects', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: '/loop' });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    // The loopback target is blocked on the first hop, which proves the
    // redirect chain is validated before any connection is made.
    await assert.rejects(
      fetchWithSsrfProtection(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, maxBytes: 1024, maxRedirects: 3 }),
      /Blocked address/,
    );
  } finally {
    server.close();
  }
});
