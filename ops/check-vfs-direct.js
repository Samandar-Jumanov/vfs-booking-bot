// check-vfs-direct.js — DIRECT (no-proxy) VFS reachability go/no-go for a UZ VPS.
//
// The existing backend/scripts/verify-vfs-reachable.js routes through the
// BrightData proxy (PROXY_* env). On a native-UZ VPS we go DIRECT — no proxy —
// so this companion script hits VFS straight from the box's own IP.
//
// RUN (on the VPS, repo root):
//   node ops/check-vfs-direct.js
//
// It prints GO or NO-GO. IMPORTANT: a plain HTTP GET is only a FIRST signal.
// Datadome often only challenges a REAL browser, so the authoritative check is
// still: open Chrome on the VPS → visit the login URL → does the form render?
// (See ops/DEPLOY_VPS.md Step 1.) Treat a scripted GO as "promising", a scripted
// NO-GO as "almost certainly blocked".

const https = require('https');

const target = process.env.VFS_LOGIN_URL || 'https://visa.vfsglobal.com/uzb/en/lva/login';

const req = https.get(
  target,
  {
    timeout: 30000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  (res) => {
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > 200000) req.destroy(); });
    res.on('end', () => {
      const status = res.statusCode || 0;
      // Node core https.get does NOT auto-follow redirects; a block often shows
      // as a 3xx whose Location points at /page-not-found. Inspect BOTH the body
      // and the Location header.
      const location = res.headers.location || '';
      const haystack = (body + ' ' + location).toLowerCase();

      const blockedSignals = [
        ['page-not-found', /page-not-found|page not found/i],
        ['access-denied', /access denied|access restricted/i],
        ['datadome', /datadome/i],
        ['cloudflare-challenge', /just a moment|cf-browser-verification|attention required/i],
        ['429', /\b429\b|too many requests/i],
      ];
      const hit = blockedSignals.find(([, re]) => re.test(haystack));
      const looksLikeApp = /vfsglobal|<app-root|ng-version|visa\.vfsglobal/i.test(body);

      console.log('target   :', target);
      console.log('status   :', status);
      console.log('location :', location || '(none)');
      console.log('body len :', body.length);
      console.log('app shell:', looksLikeApp ? 'yes' : 'no');

      let verdict;
      if (hit) {
        verdict = `NO-GO (blocked signal: ${hit[0]})`;
      } else if (status >= 200 && status < 400 && looksLikeApp) {
        verdict = 'GO (app shell served — confirm with the real-Chrome check)';
      } else if (status >= 200 && status < 400) {
        verdict = 'UNCLEAR (2xx/3xx but no app shell) — confirm with the real-Chrome check';
      } else {
        verdict = `NO-GO (HTTP ${status})`;
      }
      console.log('---');
      console.log('VERDICT  :', verdict);
      // Non-zero exit on a clear NO-GO so the runbook/automation can branch on it.
      process.exit(verdict.startsWith('NO-GO') ? 2 : 0);
    });
  },
);

req.on('timeout', () => { req.destroy(); console.log('VERDICT  : NO-GO (timeout — no response in 30s)'); process.exit(2); });
req.on('error', (e) => { console.log('ERR      :', e.message); console.log('VERDICT  : NO-GO (connection error)'); process.exit(2); });
