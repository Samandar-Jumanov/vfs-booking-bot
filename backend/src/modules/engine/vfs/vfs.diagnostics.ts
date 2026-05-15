import { Page } from 'rebrowser-playwright';
import * as fs from 'fs';
import * as path from 'path';

interface ResponseSnapshot {
  url: string;
  status: number;
  headers: Record<string, string>;
  timestamp: number;
}

const lastMainFrameResponse = new WeakMap<Page, ResponseSnapshot>();

export function attachDiagnostics(page: Page): void {
  page.on('response', (resp) => {
    try {
      if (resp.frame() === page.mainFrame()) {
        lastMainFrameResponse.set(page, {
          url: resp.url(),
          status: resp.status(),
          headers: resp.headers(),
          timestamp: Date.now(),
        });
      }
    } catch {
      // listener must never throw — ignore
    }
  });
}

export async function dumpBlockDiagnostics(
  page: Page,
  reason: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const ts = Date.now();
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const dir = path.join('recordings', `block_${safeSession}_${ts}`);
    fs.mkdirSync(dir, { recursive: true });

    const lastResp = lastMainFrameResponse.get(page);
    const headers = lastResp?.headers ?? {};
    const manifest = {
      reason,
      sessionId,
      timestamp: new Date(ts).toISOString(),
      currentUrl: page.url(),
      lastMainFrameResponse: lastResp ?? null,
      vendorSignals: {
        datadome: headers['x-dd-b'] ?? headers['x-datadome-cid'] ?? null,
        cloudflare: headers['cf-mitigated'] ?? headers['cf-ray'] ?? null,
        server: headers['server'] ?? null,
      },
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true }).catch(() => {});

    try {
      const html = await page.content();
      fs.writeFileSync(path.join(dir, 'page.html'), html.slice(0, 2048));
    } catch {
      // page may have already closed
    }

    return dir;
  } catch {
    return null;
  }
}

function redactHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) return null;
  return '[redacted]';
}

export async function dumpLoginFailureDiagnostics(
  page: Page,
  reason: string,
  correlationId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const ts = Date.now();
    fs.mkdirSync('recordings', { recursive: true });
    const screenshotPath = path.join('recordings', `login_failure_${ts}.png`);
    const htmlPath = path.join('recordings', `login_failure_${ts}.html`);
    const manifestPath = path.join('recordings', `login_failure_${ts}.json`);

    const lastResp = lastMainFrameResponse.get(page);
    const headers = lastResp?.headers ?? {};
    const selectedHeaders = {
      'x-dd-b': redactHeaderValue(headers['x-dd-b']),
      'cf-mitigated': redactHeaderValue(headers['cf-mitigated']),
      server: headers.server ?? null,
      'set-cookie': redactHeaderValue(headers['set-cookie']),
    };

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

    let htmlPreview = '';
    try {
      htmlPreview = (await page.content()).slice(0, 2048);
      fs.writeFileSync(htmlPath, htmlPreview);
    } catch {
      // page may have already closed
    }

    const manifest = {
      reason,
      correlationId,
      timestamp: new Date(ts).toISOString(),
      finalUrl: page.url(),
      response: lastResp ? { url: lastResp.url, status: lastResp.status, headers: selectedHeaders } : null,
      screenshotPath,
      htmlPath,
      htmlPreview,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return manifest;
  } catch {
    return null;
  }
}
