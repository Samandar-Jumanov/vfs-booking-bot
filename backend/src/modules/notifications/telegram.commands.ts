import axios from 'axios';
import { Telegraf } from 'telegraf';
import { Role } from '@prisma/client';
import { env } from '@config/env';
import { signAccessToken } from '@utils/jwt';
import { enqueueBooking } from '@modules/booking/booking.service';
import { getMonitor } from '@modules/monitor/monitor.service';

function backendUrl(path: string): string {
  return `http://127.0.0.1:${env.PORT}${path}`;
}

function botToken(): string {
  return signAccessToken({
    sub: 'telegram-operator',
    email: 'telegram-operator@local',
    role: Role.ADMIN,
  });
}

async function postInternal(path: string, body: unknown = {}): Promise<void> {
  await axios.post(backendUrl(path), body, {
    timeout: 10_000,
    headers: { Authorization: `Bearer ${botToken()}` },
  });
}

export function registerTelegramCommands(bot: Telegraf): void {
  bot.on('callback_query', async (ctx) => {
    const query = ctx.callbackQuery;
    const data = 'data' in query ? query.data : undefined;
    if (!data) {
      await ctx.answerCbQuery('Unsupported action');
      return;
    }
    if (data === 'dashboard:open') {
      await ctx.answerCbQuery('Dashboard runs on operator localhost — open it manually');
      return;
    }

    const [action, monitorId, destination] = data.split(':');

    try {
      switch (action) {
        case 'book_now': {
          const monitor = monitorId ? getMonitor(monitorId) : undefined;
          if (!monitor || monitor.profileIds.length === 0) {
            await ctx.answerCbQuery('No active monitor/profile to book');
            return;
          }
          await enqueueBooking({
            profileId: monitor.profileIds[0],
            sourceCountry: monitor.sourceCountry,
            destination: monitor.destination,
            visaType: monitor.visaType,
            slot: {
              date: new Date().toISOString(),
              time: '',
              destination: monitor.destination,
              visaType: monitor.visaType,
            },
          });
          await ctx.answerCbQuery('Booking queued');
          return;
        }
        case 'pause_monitor':
          if (!monitorId) {
            await ctx.answerCbQuery('Monitor id missing');
            return;
          }
          await postInternal(`/api/monitor/stop/${encodeURIComponent(monitorId)}`);
          await ctx.answerCbQuery('Monitor paused');
          return;
        case 'warm_cookies':
          await postInternal('/api/monitor/start', {
            id: monitorId || undefined,
            sourceCountry: 'uzbekistan',
            destination: destination || 'lva',
            visaType: getMonitor(monitorId)?.visaType ?? 'SCH',
            profileIds: getMonitor(monitorId)?.profileIds ?? [],
            mode: 'manual',
          });
          await ctx.answerCbQuery('Cookie warm-up started');
          return;
        case 'solve_captcha':
          await ctx.answerCbQuery(`Open ${env.FRONTEND_URL.replace(/\/$/, '')}/dashboard`, { show_alert: true });
          return;
        case 'open_dashboard':
          await ctx.answerCbQuery(`Open ${env.FRONTEND_URL.replace(/\/$/, '')}/dashboard`, { show_alert: true });
          return;
        case 'download_confirmation':
        case 'retry_once':
          await ctx.answerCbQuery('Not implemented yet', { show_alert: true });
          return;
        default:
          await ctx.answerCbQuery('Unknown action');
      }
    } catch (err: any) {
      await ctx.answerCbQuery(err.message || 'Action failed', { show_alert: true });
    }
  });
}
