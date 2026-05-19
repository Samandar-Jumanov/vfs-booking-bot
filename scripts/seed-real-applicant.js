#!/usr/bin/env node
// Creates a Profile from the real passport data the operator pasted.
// Run: node scripts/seed-real-applicant.js
const https = require('node:https');

const BACKEND = 'https://backend-production-24c3.up.railway.app';
const EMAIL = 'jumanovsamandar005@gmail.com';
const PW = 'VFSbot2026!';

function req(method, path, body, headers = {}) {
  const url = new URL(BACKEND + path);
  return new Promise((resolve, reject) => {
    const buf = body ? JSON.stringify(body) : undefined;
    const r = https.request({
      method, hostname: url.hostname, port: 443, path: url.pathname,
      headers: { ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(buf) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (buf) r.write(buf);
    r.end();
  });
}

(async () => {
  console.log('[1] login...');
  const login = JSON.parse((await req('POST', '/api/auth/login', { email: EMAIL, password: PW })).body);
  const auth = { Authorization: 'Bearer ' + login.accessToken };

  console.log('[2] creating Profile from passports/image.png data...');
  // Passport 1 — OLIMOV ELBEK ELMUROD UGLI
  const passport1 = {
    fullName: 'OLIMOV ELBEK ELMUROD UGLI',
    passportNumber: 'FA8308090',
    dob: '2004-10-07',
    passportExpiry: '2028-08-23',
    nationality: 'Uzbekistan',
    email: 'jumanovsamandar005@gmail.com',
    phone: '+998881230520',
    gender: 'MALE',
    passportIssueDate: '2023-08-24',
    vfsPassword: process.env.VFS_PASSWORD || '@lockVFS1',
    priority: 'NORMAL',
  };

  const r = await req('POST', '/api/profiles', passport1, auth);
  console.log('    HTTP', r.status);
  if (r.status >= 400) { console.error('    body:', r.body); process.exit(1); }
  const profile = JSON.parse(r.body);
  console.log('    Profile id:', profile.id || profile.profile?.id);
  console.log('    Name:', passport1.fullName);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
