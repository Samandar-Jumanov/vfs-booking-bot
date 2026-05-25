import { getSetting } from '@modules/settings/settings.service';
import { prisma } from '@config/database';
import { env } from '@config/env';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { sendTelegram } from './telegram.bot';
import { sendEmail } from './email';
import { sendPushToAll } from './webPush';

export type AlertEvent =
  | 'SLOT_DETECTED'
  | 'BOOKING_SUCCESS'
  | 'BOOKING_FAILED'
  | 'CAPTCHA_MANUAL_NEEDED'
  | 'COOKIE_EXPIRING_SOON'
  | 'MONITOR_CRASHED'
  | 'MONITOR_DEAD';

interface NotificationPayload {
  event: AlertEvent;
  profileId?: string;
  profileName?: string;
  sourceCountry?: string;
  destination?: string;
  visaType?: string;
  confirmationNo?: string;
  accountEmail?: string;
  slotDate?: string;
  errorMessage?: string;
  reason?: string;
  minutesRemaining?: number;
  monitorId?: string;
  attempt?: number;
}

const VISA_NAMES: Record<string, string> = {
  SCH: 'Schengen Short-Stay',
  TRV: 'Tourist Visa',
  VIS: 'Visitor Visa',
  BUS: 'Business Visa',
  STU: 'Student Visa',
  WRK: 'Work Visa',
  SEA: 'Seasonal Work',
  JOB: 'Job Seeker',
  DNV: 'Digital Nomad',
  D7: 'D7 Passive Income',
  GLD: 'Golden Visa',
  FAM: 'Family Reunification',
  MED: 'Medical Treatment',
  TRN: 'Airport Transit',
};

function getVisaLabel(code?: string): string {
  if (!code) return 'N/A';
  return VISA_NAMES[code] || code;
}

function dashboardUrl(path = ''): string {
  return `${env.FRONTEND_URL.replace(/\/$/, '')}${path}`;
}

type InlineButton = { text: string; callback_data?: string; url?: string };

function alertCallback(action: string, p: NotificationPayload): string {
  return [action, p.monitorId ?? '', p.destination ?? ''].join(':').slice(0, 64);
}

function isLocalhostFrontendUrl(): boolean {
  return env.FRONTEND_URL.startsWith('http://localhost')
    || env.FRONTEND_URL.startsWith('http://127.')
    || env.FRONTEND_URL.startsWith('http://[::1]');
}

function dashboardButton(): InlineButton {
  if (isLocalhostFrontendUrl()) {
    return { text: '📊 Dashboard', callback_data: 'dashboard:open' };
  }
  return { text: '📊 Dashboard', url: dashboardUrl('/dashboard') };
}

function alertButtons(p: NotificationPayload): { reply_markup?: { inline_keyboard: InlineButton[][] } } {
  switch (p.event) {
    case 'SLOT_DETECTED':
      return {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎯 Book now', callback_data: alertCallback('book_now', p) },
              dashboardButton(),
            ],
            [{ text: '⏸ Pause monitor', callback_data: alertCallback('pause_monitor', p) }],
          ],
        },
      };
    case 'BOOKING_SUCCESS':
      return {
        reply_markup: {
          inline_keyboard: [[
            { text: '📥 Confirmation', callback_data: alertCallback('download_confirmation', p) },
            dashboardButton(),
          ]],
        },
      };
    case 'BOOKING_FAILED':
      return {
        reply_markup: {
          inline_keyboard: [[
            dashboardButton(),
            { text: '🔁 Retry once', callback_data: alertCallback('retry_once', p) },
          ]],
        },
      };
    case 'CAPTCHA_MANUAL_NEEDED':
      return {
        reply_markup: {
          inline_keyboard: [[
            { text: '🤖 Solve', callback_data: alertCallback('solve_captcha', p) },
            dashboardButton(),
          ]],
        },
      };
    case 'COOKIE_EXPIRING_SOON':
      return {
        reply_markup: {
          inline_keyboard: [[
            { text: '🍪 Warm cookies', callback_data: alertCallback('warm_cookies', p) },
            dashboardButton(),
          ]],
        },
      };
    case 'MONITOR_CRASHED':
    case 'MONITOR_DEAD':
      return {
        reply_markup: {
          inline_keyboard: [[dashboardButton()]],
        },
      };
  }
}

function escapeTelegramHtml(value?: string): string {
  return (value ?? 'N/A')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramMessage(p: NotificationPayload & { profileName?: string }): string {
  switch (p.event) {
    case 'SLOT_DETECTED':
      return [
        'Slot available',
        `Destination: <b>${escapeTelegramHtml(p.destination ?? 'VFS')}</b>`,
        `Date: <b>${escapeTelegramHtml(p.slotDate)}</b>`,
        `Account: <code>${escapeTelegramHtml(p.accountEmail)}</code>`,
      ].join('\n');
    case 'BOOKING_SUCCESS':
      return `✅ Booked — *${p.profileName ?? 'Unknown'}* → ${p.destination ?? 'VFS'} on ${p.slotDate ?? 'N/A'}\nConf #: \`${p.confirmationNo ?? 'N/A'}\``;
    case 'BOOKING_FAILED':
      return `❌ Booking failed — ${p.reason ?? p.errorMessage ?? 'Unknown error'}\nManual review needed.`;
    case 'CAPTCHA_MANUAL_NEEDED':
      return '🤖 Captcha needed — open the dashboard to solve';
    case 'COOKIE_EXPIRING_SOON':
      return `🍪 Cookies expire in ${p.minutesRemaining ?? '?'} min — warm them up`;
    case 'MONITOR_CRASHED':
      return `⚠️ Monitor \`${p.monitorId ?? 'unknown'}\` crashed, restarted (attempt ${p.attempt ?? 1}/3)`;
    case 'MONITOR_DEAD':
      return `🚨 Monitor \`${p.monitorId ?? 'unknown'}\` DEAD after 3 restarts. Manual intervention.`;
  }
}

function formatEmailHtml(p: NotificationPayload & { profileName?: string }): { subject: string; html: string } {
  switch (p.event) {
    case 'SLOT_DETECTED':
      return {
        subject: `VFS Slot Available — ${p.destination}`,
        html: `<h2>Appointment Slot Detected</h2><p>Destination: ${p.destination}<br>Visa: ${getVisaLabel(p.visaType)}<br>Date: ${p.slotDate ?? 'N/A'}</p>`,
      };
    case 'BOOKING_SUCCESS':
      return {
        subject: `Booking Confirmed — ${p.confirmationNo}`,
        html: `<h2>Appointment Booked Successfully</h2><p>Applicant: ${p.profileName}<br>Destination: ${p.destination}<br>Confirmation: <strong>${p.confirmationNo}</strong></p>`,
      };
    case 'BOOKING_FAILED':
      return {
        subject: `Booking Failed — ${p.destination}`,
        html: `<h2>Booking Failed</h2><p>Applicant: ${p.profileName}<br>Destination: ${p.destination}<br>Error: ${p.errorMessage}</p>`,
      };
    default:
      return {
        subject: `VFS Alert — ${p.event}`,
        html: `<h2>${p.event}</h2><p>${formatTelegramMessage(p)}</p>`,
      };
  }
}

export async function dispatchNotification(payload: NotificationPayload): Promise<void> {
  // Mute booking-failure alerts while we're still validating the flow — every
  // failed/aborted test fire would otherwise spam the operator (and any client)
  // Telegram channel. Success (BOOKING_SUCCESS) and slot alerts always go out.
  // Set NOTIFY_BOOKING_FAILURES=true in production to re-enable failure alerts.
  if (payload.event === 'BOOKING_FAILED' && !env.NOTIFY_BOOKING_FAILURES) {
    logEvent('warn', EventType.BOOKING_FAILED, `[notify] failure alert suppressed (NOTIFY_BOOKING_FAILURES off): ${payload.reason ?? ''}`, {
      channel: 'telegram',
      destination: payload.destination,
    });
    return;
  }

  let profileName = payload.profileName;
  let customerChatId: string | null = null;
  if (payload.profileId) {
    const profile = await prisma.profile.findUnique({
      where: { id: payload.profileId },
      select: { fullName: true, email: true, telegramChatId: true },
    });
    if (!profileName) profileName = profile?.fullName;
    customerChatId = profile?.telegramChatId ?? null;
  }

  const enriched = { ...payload, profileName };

  await Promise.all([
    (async () => {
      try {
        const enabled = await getSetting<boolean>('notifications.telegram.enabled');
        if (enabled || env.TELEGRAM_BOT_TOKEN) {
          const msg = formatTelegramMessage(enriched);
          // Always send to operator (env.TELEGRAM_CHAT_ID).
          await sendTelegram(msg, { ...alertButtons(enriched) });
          // Additionally send to the customer's own chat if configured.
          if (customerChatId && customerChatId !== env.TELEGRAM_CHAT_ID) {
            const { sendTelegramTo } = await import('./telegram.bot');
            await sendTelegramTo(customerChatId, msg).catch((err: any) => {
              logEvent('warn', EventType.BOOKING_FAILED, `Customer telegram send failed: ${err?.message ?? err}`, {
                channel: 'telegram',
                profileId: payload.profileId,
                customerChatId,
              });
            });
          }
        }
      } catch (err: any) {
        logEvent('error', EventType.BOOKING_FAILED, `Telegram notification failed: ${err.message ?? String(err)}`, {
          channel: 'telegram',
          event: enriched.event,
          destination: enriched.destination,
        });
      }
    })(),
    (async () => {
      try {
        const enabled = await getSetting<boolean>('notifications.email.enabled');
        if (enabled) {
          const { subject, html } = formatEmailHtml(enriched);
          const adminEmail = await getSetting<string>('notifications.email.recipient');
          if (adminEmail) await sendEmail(adminEmail, subject, html);
        }
      } catch (err: any) {
        logEvent('error', EventType.BOOKING_FAILED, `Email notification failed: ${err.message ?? String(err)}`, {
          channel: 'email',
          event: enriched.event,
          destination: enriched.destination,
        });
      }
    })(),
    (async () => {
      try {
        const enabled = await getSetting<boolean>('notifications.push.enabled');
        if (enabled) await sendPushToAll(enriched);
      } catch (err: any) {
        logEvent('error', EventType.BOOKING_FAILED, `Push notification failed: ${err.message ?? String(err)}`, {
          channel: 'push',
          event: enriched.event,
          destination: enriched.destination,
        });
      }
    })(),
  ]);
}
