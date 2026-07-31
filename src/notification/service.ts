import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { CrashGroup, CrashReport } from '../model.js';

let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (!_transporter && config.smtpHost) {
    _transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    });
  }
  return _transporter;
}

/**
 * Test SMTP connectivity by sending a verification email.
 * Called at server startup and via the test-smtp endpoint.
 */
export async function testSmtpConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!config.smtpHost) {
    console.log('[smtp] Not configured — SMTP_HOST is empty. Emails will use console fallback.');
    return { ok: false, error: 'SMTP_HOST not set' };
  }
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'Failed to create SMTP transport' };
  }
  try {
    await transporter.verify();
    console.log(`[smtp] Connected to ${config.smtpHost}:${config.smtpPort} as ${config.smtpUser || '(anonymous)'} — ready`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[smtp] Connection to ${config.smtpHost}:${config.smtpPort} failed: ${message}`);
    return { ok: false, error: message };
  }
}

export interface SendResult {
  ok: boolean;
  method: 'smtp' | 'console';
  error?: string;
}

/**
 * Send an email verification code to the user.
 * Falls back to console log if SMTP is not configured or fails.
 */
export async function sendVerificationEmail(to: string, code: string): Promise<SendResult> {
  const transporter = getTransporter();
  if (!transporter || !config.alertEmailFrom) {
    console.log(`[email] Verification code for ${to}: ${code} (SMTP not configured — check console)`);
    return { ok: false, method: 'console', error: 'SMTP not configured' };
  }
  try {
    await transporter.sendMail({
      from: config.alertEmailFrom,
      to,
      subject: `[Crash Reporter] Email Verification Code: ${code}`,
      text: `Your email verification code is: ${code}\n\nThis code expires in 15 minutes.\n\nIf you did not request this, please ignore this email.`,
    });
    console.log(`[email] Verification code sent to ${to}`);
    return { ok: true, method: 'smtp' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] Failed to send verification to ${to}:`, message);
    console.log(`[email] Verification code for ${to}: ${code} (email failed — check console)`);
    return { ok: false, method: 'console', error: message };
  }
}

export interface AlertPayload {
  type: 'new_group' | 'threshold_reached';
  group: CrashGroup;
  report: CrashReport;
  symbolicatedMethod?: string;
}

export async function notifyAlert(payload: AlertPayload): Promise<void> {
  await Promise.allSettled([sendWebhook(payload), sendEmail(payload)]);
}

async function sendWebhook(payload: AlertPayload): Promise<void> {
  if (!config.webhookUrl) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.webhookTimeoutMs);
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: payload.type,
        group: payload.group,
        report: {
          id: payload.report.id,
          exception_type: payload.report.exception_type,
          exception_message: payload.report.exception_message,
          runtime: payload.report.runtime,
          platform: payload.report.platform,
          build_guid: payload.report.build_guid,
          symbolication_status: payload.report.symbolication_status,
        },
        symbolicated_method: payload.symbolicatedMethod,
        dashboard_url: `/web/crashes/${payload.group.id}`,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
  } catch (err) {
    console.error('[notification] Webhook failed:', err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendEmail(payload: AlertPayload): Promise<void> {
  if (!config.smtpHost || !config.alertEmailFrom || !config.alertEmailTo) return;
  const transporter = getTransporter();
  if (!transporter) return;
  try {
    const title = payload.type === 'new_group' ? 'New crash group' : 'Crash threshold reached';
    await transporter.sendMail({
      from: config.alertEmailFrom,
      to: config.alertEmailTo,
      subject: `[Crash Reporter] ${title}: ${payload.group.exception_type}`,
      text: [
        `${title}: #${payload.group.id}`,
        `Exception: ${payload.group.exception_type}`,
        `Message: ${payload.group.exception_message || '-'}`,
        `Runtime: ${payload.report.runtime || 'other'}`,
        `Count: ${payload.group.total_count}`,
        `Symbolicated method: ${payload.symbolicatedMethod || '-'}`,
        `Platform: ${payload.report.platform || '-'}`,
        `Build GUID: ${payload.report.build_guid || '-'}`,
        `Dashboard: /web/crashes/${payload.group.id}`,
      ].join('\n'),
    });
  } catch (err) {
    console.error('[notification] Email failed:', err instanceof Error ? err.message : err);
  }
}
