// Verify the BrightData proxy actually exits in Uzbekistan. Run with:
//   railway run --service backend node scripts/verify-proxy-exit.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // diagnostic only — BrightData CONNECT cert
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');

const base = (process.env.PROXY_USERNAME || '').replace(/-session-[^-]*$/, '');
const user = encodeURIComponent(base + '-session-verify' + Date.now());
const pass = encodeURIComponent(process.env.PROXY_PASSWORD || '');
const url = 'http://' + user + ':' + pass + '@' + process.env.PROXY_HOST + ':' + process.env.PROXY_PORT;

const agent = new HttpsProxyAgent(url, { rejectUnauthorized: false });
axios
  .get('https://ipinfo.io/json', { httpsAgent: agent, proxy: false, timeout: 25000 })
  .then((r) => console.log('EXIT:', JSON.stringify({ ip: r.data.ip, country: r.data.country, city: r.data.city, org: r.data.org })))
  .catch((e) => console.log('ERR:', e.message));
