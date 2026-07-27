import nodemailer from 'nodemailer';
import { config } from '../config.js';
import type { CrashGroup, CrashReport } from '../model.js';

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
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword } : undefined,
    });
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
