import { Telegraf, Context } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { env } from '@config/env';
import { getMonitorStatus, stopMonitor } from '@modules/monitor/monitor.service';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { registerTelegramCommands } from './telegram.commands';

const escapeHTML = (str: string) => {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

let bot: Telegraf | null = null;
let isBotActive = false;

/**
 * Resiliently send a reply to Telegram, retrying up to 3 times on network failure.
 */
async function resilientReply(ctx: Context, text: string, options: any = {}) {
    let attempts = 0;
    while (attempts < 3) {
        try {
            await ctx.reply(text, options);
            return;
        } catch (err: any) {
            attempts++;
            if (attempts === 3) throw err;
            await new Promise(r => setTimeout(r, 2000)); // Wait for proxy rotation
        }
    }
}

export function initTelegramBot(): Telegraf | null {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set — bot interface disabled');
    return null;
  }

  const agent: any = env.TELEGRAM_PROXY ? new HttpsProxyAgent(env.TELEGRAM_PROXY) : undefined;

  bot = new Telegraf(env.TELEGRAM_BOT_TOKEN, {
    telegram: { agent }
  });

  // Global Error Handler
  bot.catch((err: any, ctx: Context) => {
    // Access update_id safely
    const updateId = (ctx.update as any)?.update_id;
    // Silence common proxy socket errors
    if (err.message?.includes('socket') || err.code === 'ECONNRESET') return;
    console.warn(`⚠️ Telegram error (U:${updateId}):`, err.message);
  });

  bot.use(async (ctx: Context, next: () => Promise<void>) => {
    const chatId = ctx.chat?.id.toString();
    if (chatId !== env.TELEGRAM_CHAT_ID) return;
    
    // Log incoming commands immediately so user sees bot is alive in CLI
    if (ctx.message && 'text' in ctx.message) {
        console.info(`📩 Telegram Command Received: ${ctx.message.text}`);
    }

    try {
        await next();
    } catch (err) {
        // Handled by global catch
    }
  });

  bot.start(async (ctx: Context) => {
    try {
        await resilientReply(ctx, 
          '🤖 <b>VFS Booking Bot Online</b>\n\n' +
          'Commands:\n' +
          '/status - Check active monitors\n' +
          '/stop_all - Stop all active monitors',
          { parse_mode: 'HTML' }
        );
    } catch {}
  });

  bot.command('status', async (ctx: Context) => {
    try {
        const statuses = getMonitorStatus();
        if (statuses.length === 0) return await resilientReply(ctx, '📭 No active monitors.');

        const message = statuses
          .map((s: any) => {
            let statusText = '🔴 <b>Offline</b>';
            if (s.isRunning) statusText = '🟢 <b>Active & Searching...</b>';
            else if (s.isCoolingDown) {
               const minutes = s.lastHttpStatus === 403 ? '10m' : '5m';
               const reason = s.lastHttpStatus === 403 ? 'IP Protect' : 'Server Rest';
               statusText = `⏳ <b>Cooldown - ${reason} (${minutes})</b>`;
            }

            return `📍 <b>[${escapeHTML((s.sourceCountry || 'usa').toUpperCase())} → ${escapeHTML(s.destination?.toUpperCase())}]</b>\n` +
            `   Category: <code>${escapeHTML(s.visaType)}</code>\n` +
            `   State: ${statusText}\n` +
            `   VFS Record: ${s.slotDetectedCount} Slots\n` +
            `   Last Log: ${s.lastCheckedAt ? new Date(s.lastCheckedAt).toLocaleTimeString() : 'Awaiting Heartbeat...'}`;
          })
          .join('\n\n');

        await resilientReply(ctx, `📊 <b>Current Status</b>\n\n${message}`, { parse_mode: 'HTML' });
    } catch (err) {
        // Handled by global catch
    }
  });

  bot.command('stop_all', async (ctx: Context) => {
    try {
        const statuses = getMonitorStatus();
        for (const monitor of statuses) {
           try { stopMonitor(monitor.id); } catch {}
        }
        await resilientReply(ctx, '🔒 <b>All monitors stopped.</b>', { parse_mode: 'HTML' });
        logEvent('warn', EventType.MONITOR_STOPPED, 'All monitors stopped via Telegram');
    } catch {}
  });

  registerTelegramCommands(bot);

  const launchBot = async () => {
    try {
      await bot?.launch();
      if (!isBotActive) {
          console.info('✅ Telegram bot connected successfully');
          isBotActive = true;
      }
    } catch (err: any) {
      setTimeout(launchBot, 5000);
    }
  };

  launchBot();

  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));

  return bot;
}

export function getBotInstance(): Telegraf | null {
  return bot;
}

export async function sendTelegram(message: string, options: Record<string, unknown> = {}): Promise<void> {
  if (!bot || !env.TELEGRAM_CHAT_ID) throw new Error('Telegram bot is not configured');
  await bot.telegram.sendMessage(env.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML', ...options });
}

/**
 * Send to a specific chat ID (per-customer routing) with fallback to the
 * operator's TELEGRAM_CHAT_ID. Pass undefined chatId to use operator chat.
 */
export async function sendTelegramTo(chatId: string | undefined | null, message: string, options: Record<string, unknown> = {}): Promise<void> {
  if (!bot) throw new Error('Telegram bot is not configured');
  const target = chatId || env.TELEGRAM_CHAT_ID;
  if (!target) throw new Error('No Telegram chat target available');
  await bot.telegram.sendMessage(target, message, { parse_mode: 'HTML', ...options });
}
