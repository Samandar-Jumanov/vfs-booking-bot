import axios from 'axios';
import { env } from '@config/env';

const SCRAPER_API_ENDPOINT = 'https://api.scraperapi.com/';
const ONE_HOUR_MS = 60 * 60 * 1000;
const requestTimestamps: number[] = [];

export interface ScraperApiRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  cookies?: string;
  renderJs?: boolean;
}

export interface ScraperApiResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

function checkHourlyLimit(): void {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= ONE_HOUR_MS) {
    requestTimestamps.shift();
  }

  const max = env.SCRAPER_API_MAX_REQUESTS_PER_HOUR;
  if (requestTimestamps.length >= max) {
    const message = `[ScraperAPI] Hourly request limit reached (${requestTimestamps.length}/${max})`;
    console.warn(message);
    throw new Error(message);
  }

  requestTimestamps.push(now);
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]),
  );
}

export async function fetchViaScraperApi(req: ScraperApiRequest): Promise<ScraperApiResponse> {
  if (!env.SCRAPER_API) {
    throw new Error('SCRAPER_API is not configured');
  }

  checkHourlyLimit();

  const targetMethod = req.method ?? 'GET';
  const scraperUrl = new URL(SCRAPER_API_ENDPOINT);
  scraperUrl.searchParams.set('api_key', env.SCRAPER_API);
  scraperUrl.searchParams.set('url', req.url);
  scraperUrl.searchParams.set('premium', String(env.SCRAPER_API_PREMIUM));
  scraperUrl.searchParams.set('country_code', env.SCRAPER_API_COUNTRY);
  scraperUrl.searchParams.set('keep_headers', 'true');
  if (targetMethod === 'POST') scraperUrl.searchParams.set('method', 'POST');
  if (req.renderJs) scraperUrl.searchParams.set('render', 'true');

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.cookies) headers.Cookie = req.cookies;

  const response = await axios.request<string>({
    url: scraperUrl.toString(),
    method: targetMethod,
    headers,
    data: req.body,
    responseType: 'text',
    timeout: 180_000,
    validateStatus: () => true,
  });

  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  return {
    status: response.status,
    body,
    headers: normalizeHeaders(response.headers as Record<string, unknown>),
  };
}

export function isScraperApiEnabled(): boolean {
  return Boolean(process.env.SCRAPER_API);
}
