// Does the BrightData UZ IP actually reach the VFS login page, or is it
// flagged (Datadome / session-invalid)? Tells us IP-vs-account.
//   railway run --service backend node scripts/verify-vfs-reachable.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');

const base = (process.env.PROXY_USERNAME || '').replace(/-session-[^-]*$/, '');
const user = encodeURIComponent(base + '-session-vfschk' + Date.now());
const pass = encodeURIComponent(process.env.PROXY_PASSWORD || '');
const url = 'http://' + user + ':' + pass + '@' + process.env.PROXY_HOST + ':' + process.env.PROXY_PORT;
const agent = new HttpsProxyAgent(url, { rejectUnauthorized: false });

const target = 'https://visa.vfsglobal.com/uzb/en/lva/login';

axios
  .get(target, {
    httpsAgent: agent,
    proxy: false,
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  .then((r) => {
    const html = String(r.data || '');
    const has = (s) => html.toLowerCase().includes(s);
    console.log('status      :', r.status);
    console.log('final url   :', r.request?.res?.responseUrl || '(n/a)');
    console.log('len         :', html.length);
    console.log('login form? :', has('password') || has('formcontrolname'));
    console.log('page-not-fnd:', has('page-not-found') || has('not found'));
    console.log('session-exp?:', has('session expired') || has('session has expired'));
    console.log('datadome?   :', has('datadome') || has('captcha-delivery') || r.status === 403);
    console.log('dd headers  :', JSON.stringify({ xdd: r.headers['x-dd-b'], cf: r.headers['cf-mitigated'], srv: r.headers['server'] }));
  })
  .catch((e) => console.log('ERR:', e.message));
