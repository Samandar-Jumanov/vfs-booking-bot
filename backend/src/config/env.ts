import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  PROFILE_ENCRYPTION_KEY: z.string().length(64, 'PROFILE_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)'),

  TWOCAPTCHA_API_KEY: z.string().optional(),
  CAPMONSTER_KEY: z.string().optional(),
  CAPTCHA_SOLVER: z.enum(['twocaptcha', 'manual']).default('manual'),

  SMS_ACTIVATE_API_KEY: z.string().optional(),
  SMS_PROVIDER: z.enum(['smsactivate', 'vaksms', 'onlinesim']).default('smsactivate'),
  ONLINESIM_API_KEY: z.string().optional(),
  VAKSMS_API_KEY: z.string().optional(),
  VAKSMS_COUNTRY: z.string().default('uz'),

  // Orchestrator auto-pilot — OFF by default. When false it only logs the plan
  // each tick (never touches VFS); set true ONLY after live flows are verified
  // and you're on distributed UZ IPs, or it will trigger VFS rate bans.
  ORCHESTRATOR_ENABLED: z.coerce.boolean().default(false),

  // 6-hourly mass-login refresh cron — OFF by default. It logs in every stale
  // account at once, a prime trigger for VFS 429001 "Access Restricted". Enable
  // only with per-account throttling / fresh-IP rotation in place.
  LOGIN_CRON_ENABLED: z.coerce.boolean().default(false),

  // Hands-off account lifecycle tick (register/activate/login paced pipeline).
  // OFF by default — turning this ON runs VFS-touching actions automatically.
  // Enable only after ExtensionDriver is wired and operator confirms a test cycle.
  LIFECYCLE_ENABLED: z.coerce.boolean().default(false),

  // OFF by default — when ON, a logged-in VFS tab (detected via EXT_SESSION_SYNC)
  // auto-triggers booking for that account's linked profile. Books REAL
  // appointments with no confirmation pause, so enable only after login + the
  // booking flow are validated live. Tabs are staggered to avoid a 429 burst.
  AUTO_BOOK_ON_TAB_ENABLED: z.coerce.boolean().default(false),
  // Base delay (ms) between staggered parallel bookings + random jitter on top.
  AUTO_BOOK_STAGGER_MS: z.coerce.number().default(8000),
  // Gap (ms) between slot re-checks while monitoring an account (no full-wizard
  // hammering → protects against VFS 429). Default 3 min + jitter.
  AUTO_BOOK_MONITOR_INTERVAL_MS: z.coerce.number().default(180000),

  // Telegram/email BOOKING_FAILED alerts — OFF by default so dev test fires and
  // EXT_SESSION_LOST events don't spam the operator/client channel. Failures are
  // still logged. Set true in production once the booking flow is validated.
  NOTIFY_BOOKING_FAILURES: z.coerce.boolean().default(false),

  PROXY_DEFAULT_PROVIDER: z.string().default('brightdata'),
  PROXY_HOST: z.string().optional(),
  PROXY_PORT: z.coerce.number().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
  CDP_ENDPOINT: z.string().optional(),
  BRIGHTDATA_WS: z.string().optional(),
  SCRAPER_API: z.string().optional(),
  SCRAPER_API_PREMIUM: z.string().transform((v) => v !== 'false').default('true'),
  SCRAPER_API_COUNTRY: z.string().default('uz'),
  SCRAPER_API_MAX_REQUESTS_PER_HOUR: z.coerce.number().default(200),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_PROXY: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().transform((v) => v === 'true').default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('"VFS Bot" <noreply@example.com>'),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),

  VFS_EMAIL: z.string().optional(),
  VFS_PASSWORD: z.string().optional(),

  MAILSAC_API_KEY: z.string().optional(),
  EMAIL_DOMAIN: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['mailsac', 'custom']).default('mailsac'),
  CUSTOM_EMAIL_DOMAIN: z.string().optional(),
  EMAIL_WEBHOOK_SECRET: z.string().optional(),

  BOOKING_CONCURRENCY: z.coerce.number().default(3),
  BOOKING_DRY_RUN: z.string().transform((v) => v !== 'false').default('true'),
  // Default 5s — speed-pack floor. Per-account polling; sharding spreads load
  // across the pool so effective slot detection lag is interval/N.
  MONITOR_DEFAULT_INTERVAL_MS: z.coerce.number().default(5000),
  // Minimum gap between polls hitting the SAME VFS account (anti-Datadome).
  // VFS rate-limits ~3-5 req/sec; we stay well below.
  MONITOR_MIN_INTERVAL_MS: z.coerce.number().default(5000),
  // Captcha token pool: keep N pre-solved Turnstile tokens ready.
  CAPTCHA_TOKEN_POOL_SIZE: z.coerce.number().default(3),
  // Drop a captcha token when this old; 2Captcha tokens are valid ~120s.
  CAPTCHA_TOKEN_MAX_AGE_MS: z.coerce.number().default(90_000),
  SESSION_DIR: z.string().default('/app/sessions'),
  BOOKING_MAX_RETRIES: z.coerce.number().default(3),
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
