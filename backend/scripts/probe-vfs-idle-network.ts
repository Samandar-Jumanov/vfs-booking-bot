/**
 * Probe VFS idle network behavior from a real headed Chrome session.
 *
 * Purpose:
 *   Find whether the logged-in appointment/calendar page has WebSockets, SSE,
 *   long-polling, background refresh timers, or DOM mutations while idle.
 *
 * This script does not automate slot checking. It records what the browser does
 * while the operator logs in/navigates normally, then waits on the parked page.
 *
 * Run from backend:
 *   $env:VFS_PROBE_PREP_SEC="180"
 *   $env:VFS_PROBE_IDLE_SEC="600"
 *   npx.cmd tsx scripts/probe-vfs-idle-network.ts
 */
import fs from 'fs';
import path from 'path';
import { chromium, Page, Request, Response, WebSocket } from 'rebrowser-playwright';

interface NetworkEvent {
  at: string;
  phase: 'prep' | 'idle';
  kind: 'request' | 'response' | 'requestfailed' | 'websocket' | 'websocket_frame_sent' | 'websocket_frame_received' | 'console';
  url?: string;
  method?: string;
  resourceType?: string;
  status?: number;
  contentType?: string;
  durationMs?: number;
  message?: string;
}

interface DomMutation {
  t: string;
  count: number;
  text: string;
}

interface ResourceEntry {
  name: string;
  initiatorType: string;
  startTime: number;
  duration: number;
}

const HELP = process.argv.includes('--help') || process.argv.includes('-h');

const START_URL = process.env.VFS_PROBE_URL || 'https://visa.vfsglobal.com/uzb/en/lva/login';
const PREP_SEC = Number(process.env.VFS_PROBE_PREP_SEC || 180);
const IDLE_SEC = Number(process.env.VFS_PROBE_IDLE_SEC || 600);
const PROFILE_NAME = process.env.VFS_PROBE_PROFILE || 'vfs-idle-probe';
const OUT_DIR = path.resolve(process.env.VFS_PROBE_OUT_DIR || path.join(process.cwd(), '..', 'ops'));
const HEADLESS = process.env.VFS_PROBE_HEADLESS === '1';

function chromePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined,
    process.platform === 'win32' ? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/chromium-browser' : undefined,
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function stampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function compactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.search.length > 180) u.search = `${u.search.slice(0, 180)}...`;
    return u.toString();
  } catch {
    return url.length > 260 ? `${url.slice(0, 260)}...` : url;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function phase(idleStartedAt: number | null): 'prep' | 'idle' {
  return idleStartedAt && Date.now() >= idleStartedAt ? 'idle' : 'prep';
}

function isInterestingUrl(url = '') {
  const lower = url.toLowerCase();
  return (
    lower.includes('vfsglobal') ||
    lower.includes('lift-api') ||
    lower.includes('visaservice') ||
    lower.startsWith('wss://') ||
    lower.includes('checkisslotavailable') ||
    lower.includes('slot')
  );
}

function summarize(events: NetworkEvent[], resources: ResourceEntry[], mutations: DomMutation[]) {
  const idleEvents = events.filter((event) => event.phase === 'idle');
  const responses = events.filter((event) => event.kind === 'response');
  const idleResponses = responses.filter((event) => event.phase === 'idle');
  const websockets = events.filter((event) => event.kind === 'websocket');
  const sse = responses.filter((event) => /text\/event-stream/i.test(event.contentType || ''));
  const longPolls = responses.filter((event) => (event.durationMs || 0) >= 15_000);
  const slotChecks = events.filter((event) => /checkisslotavailable/i.test(event.url || ''));
  const idleSlotChecks = slotChecks.filter((event) => event.phase === 'idle');
  const idleInterestingRequests = idleEvents.filter((event) => event.kind === 'request' && isInterestingUrl(event.url));
  const idleResources = resources.filter((entry) => isInterestingUrl(entry.name));

  return {
    websocketCount: websockets.length,
    sseResponseCount: sse.length,
    longPollResponseCount: longPolls.length,
    checkIsSlotAvailableEvents: slotChecks.length,
    idleCheckIsSlotAvailableEvents: idleSlotChecks.length,
    idleInterestingRequestCount: idleInterestingRequests.length,
    idleResourceEntryCount: idleResources.length,
    domMutationCount: mutations.length,
    verdict: {
      possiblePushSignal: websockets.length > 0 || sse.length > 0,
      possibleLongPollSignal: longPolls.length > 0,
      pagePollsWhileIdle: idleInterestingRequests.length > 0 || idleSlotChecks.length > 0,
      domChangesWhileIdle: mutations.length > 0,
    },
  };
}

function markdownReport(report: any): string {
  const s = report.summary;
  return [
    '# VFS Idle Network Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Start URL: ${report.startUrl}`,
    `Final URL: ${report.finalPage?.url || '-'}`,
    `Prep seconds: ${report.config.prepSeconds}`,
    `Idle seconds: ${report.config.idleSeconds}`,
    '',
    '## Summary',
    '',
    `- WebSockets: ${s.websocketCount}`,
    `- SSE responses: ${s.sseResponseCount}`,
    `- Long-poll responses >=15s: ${s.longPollResponseCount}`,
    `- CheckIsSlotAvailable events: ${s.checkIsSlotAvailableEvents}`,
    `- Idle CheckIsSlotAvailable events: ${s.idleCheckIsSlotAvailableEvents}`,
    `- Idle interesting requests: ${s.idleInterestingRequestCount}`,
    `- Idle resource entries: ${s.idleResourceEntryCount}`,
    `- DOM mutations recorded on final page: ${s.domMutationCount}`,
    '',
    '## Verdict',
    '',
    `- Possible push signal: ${s.verdict.possiblePushSignal}`,
    `- Possible long-poll signal: ${s.verdict.possibleLongPollSignal}`,
    `- Page polls while idle: ${s.verdict.pagePollsWhileIdle}`,
    `- DOM changes while idle: ${s.verdict.domChangesWhileIdle}`,
    '',
    'Interpretation:',
    '',
    '- If WebSockets or SSE are present, inspect the JSON report before adding polling.',
    '- If only CheckIsSlotAvailable appears after manual clicks, VFS is request-driven and needs staggered polling.',
    '- If idle interesting requests appear, the existing page may already poll and can be observed instead of forced.',
    '- If DOM mutations appear without useful network activity, confirm they are real calendar/slot changes, not timers/tracking.',
    '',
  ].join('\n');
}

async function installMutationObserver(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    if (w.__vfsIdleProbeInstalled) return;
    w.__vfsIdleProbeInstalled = true;
    w.__vfsIdleProbeMutations = [];
    const install = () => {
      if (!document.body || w.__vfsIdleProbeObserver) return;
      w.__vfsIdleProbeObserver = new MutationObserver((mutations) => {
        const rows = w.__vfsIdleProbeMutations as Array<{ t: string; count: number; text: string }>;
        rows.push({
          t: new Date().toISOString(),
          count: mutations.length,
          text: (document.body.innerText || '').slice(0, 800),
        });
        if (rows.length > 500) rows.splice(0, rows.length - 500);
        console.log('[VFS_IDLE_PROBE_DOM_MUTATION]', rows[rows.length - 1].t, mutations.length);
      });
      w.__vfsIdleProbeObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      install();
    }
  });
}

async function readFinalPage(page: Page): Promise<{ url: string; title: string; bodyText: string; mutations: DomMutation[]; resources: ResourceEntry[] }> {
  return page.evaluate(() => {
    const w = window as any;
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 2000),
      mutations: (w.__vfsIdleProbeMutations || []).slice(-500),
      resources: performance.getEntriesByType('resource').map((entry: any) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        startTime: Math.round(entry.startTime),
        duration: Math.round(entry.duration),
      })),
    };
  });
}

async function main() {
  if (HELP) {
    console.log(`VFS idle network probe

Env:
  VFS_PROBE_URL        default ${START_URL}
  VFS_PROBE_PREP_SEC   seconds to log in/navigate before idle capture, default ${PREP_SEC}
  VFS_PROBE_IDLE_SEC   seconds to sit idle on calendar/page, default ${IDLE_SEC}
  VFS_PROBE_PROFILE    persistent Chrome profile name, default ${PROFILE_NAME}
  VFS_PROBE_OUT_DIR    report folder, default ${OUT_DIR}
  CHROME_PATH          optional Chrome executable path

Run:
  npx.cmd tsx scripts/probe-vfs-idle-network.ts
`);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = Date.now();
  let idleStartedAt: number | null = null;
  const events: NetworkEvent[] = [];
  const requestStart = new Map<Request, number>();

  const profileDir = path.resolve(process.cwd(), '.browser-profiles', PROFILE_NAME);
  fs.mkdirSync(profileDir, { recursive: true });

  console.log('[VFS-PROBE] opening headed Chrome');
  console.log('[VFS-PROBE] profile:', profileDir);
  console.log('[VFS-PROBE] start URL:', START_URL);
  console.log(`[VFS-PROBE] prep=${PREP_SEC}s idle=${IDLE_SEC}s`);
  console.log('[VFS-PROBE] log in and navigate to the appointment/calendar page during prep time.');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    executablePath: chromePath(),
    viewport: { width: 1365, height: 768 },
    locale: 'uz-UZ',
    timezoneId: 'Asia/Tashkent',
    ignoreHTTPSErrors: true,
    args: [
      '--disable-notifications',
      '--window-size=1365,768',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await installMutationObserver(page);

  const addEvent = (event: Omit<NetworkEvent, 'at' | 'phase'>) => {
    const row: NetworkEvent = {
      at: new Date().toISOString(),
      phase: phase(idleStartedAt),
      ...event,
    };
    events.push(row);
    if (events.length > 10_000) events.splice(0, events.length - 10_000);
    if (event.url && isInterestingUrl(event.url)) {
      console.log(`[VFS-PROBE] ${row.phase} ${event.kind} ${event.status ?? ''} ${event.method ?? ''} ${event.resourceType ?? ''} ${compactUrl(event.url)}`);
    }
  };

  page.on('request', (request) => {
    requestStart.set(request, Date.now());
    addEvent({
      kind: 'request',
      method: request.method(),
      resourceType: request.resourceType(),
      url: compactUrl(request.url()),
    });
  });

  page.on('response', (response: Response) => {
    const request = response.request();
    const started = requestStart.get(request);
    addEvent({
      kind: 'response',
      method: request.method(),
      resourceType: request.resourceType(),
      url: compactUrl(response.url()),
      status: response.status(),
      contentType: response.headers()['content-type'] || '',
      durationMs: started ? Date.now() - started : undefined,
    });
  });

  page.on('requestfailed', (request) => {
    addEvent({
      kind: 'requestfailed',
      method: request.method(),
      resourceType: request.resourceType(),
      url: compactUrl(request.url()),
      message: request.failure()?.errorText,
    });
  });

  page.on('websocket', (ws: WebSocket) => {
    addEvent({ kind: 'websocket', url: compactUrl(ws.url()) });
    ws.on('framesent', (frame) => addEvent({ kind: 'websocket_frame_sent', url: compactUrl(ws.url()), message: String(frame.payload).slice(0, 300) }));
    ws.on('framereceived', (frame) => addEvent({ kind: 'websocket_frame_received', url: compactUrl(ws.url()), message: String(frame.payload).slice(0, 300) }));
  });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('VFS_IDLE_PROBE')) {
      addEvent({ kind: 'console', message: text });
    }
  });

  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
    console.warn('[VFS-PROBE] initial goto failed, continuing with open browser:', (err as Error).message);
  });

  await sleep(Math.max(0, PREP_SEC) * 1000);
  idleStartedAt = Date.now();
  console.log('[VFS-PROBE] idle capture started. Do not click or refresh unless testing a specific user action.');
  await sleep(Math.max(1, IDLE_SEC) * 1000);

  const finalPage = await readFinalPage(page).catch((err) => ({
    url: page.url(),
    title: '',
    bodyText: `readFinalPage failed: ${(err as Error).message}`,
    mutations: [],
    resources: [],
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      startUrl: START_URL,
      prepSeconds: PREP_SEC,
      idleSeconds: IDLE_SEC,
      profileName: PROFILE_NAME,
      profileDir,
      headless: HEADLESS,
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
    },
    startUrl: START_URL,
    finalPage,
    summary: summarize(events, finalPage.resources || [], finalPage.mutations || []),
    events,
  };

  const base = path.join(OUT_DIR, `vfs-idle-network-report-${stampForFile()}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(`${base}.md`, markdownReport(report), 'utf8');
  console.log('[VFS-PROBE] wrote:', `${base}.json`);
  console.log('[VFS-PROBE] wrote:', `${base}.md`);
  console.log('[VFS-PROBE] summary:', JSON.stringify(report.summary, null, 2));

  await context.close();
}

main().catch((err) => {
  console.error('[VFS-PROBE] failed:', err);
  process.exitCode = 1;
});
