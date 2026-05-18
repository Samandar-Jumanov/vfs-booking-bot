/**
 * Request signing for VFS mobile API.
 *
 * STATUS: SCAFFOLDING — actual signing algorithm + secret extraction TBD
 * after Phase 2 capture sprint.
 *
 * Most mobile apps use one of these patterns:
 *
 *  PATTERN A — HMAC-SHA256 of body + timestamp + path:
 *      sig = HMAC-SHA256(secret, `${method}\n${path}\n${timestamp}\n${body}`)
 *      Header: X-Sign: <hex>
 *      Header: X-Timestamp: <epoch ms>
 *
 *  PATTERN B — Body + secret + timestamp:
 *      sig = SHA256(body + secret + timestamp)
 *
 *  PATTERN C — JWT-style with HS256:
 *      payload = { body, ts, nonce }
 *      sig = JWT.sign(payload, secret)
 *
 * The secret is usually extracted from the decompiled APK (look for
 * Cipher.getInstance("HmacSHA256") + a String constant near it). It may
 * be obfuscated with one of:
 *   - Simple XOR with another constant
 *   - Base64-encoded in strings.xml
 *   - Native (.so) library — would need Frida hooks to extract at runtime
 */

import * as crypto from 'crypto';

/**
 * Placeholder. Replace once we know the algorithm.
 *
 * @param method  HTTP method
 * @param path    request path
 * @param body    JSON-stringified request body (or empty string)
 * @param secret  signing secret extracted from APK
 * @returns       { sign, timestamp } headers to attach
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  secret: string,
): { sign: string; timestamp: string } {
  const timestamp = String(Date.now());

  // PLACEHOLDER: HMAC-SHA256(secret, METHOD\nPATH\nTIMESTAMP\nBODY)
  // Replace this once capture confirms actual scheme.
  const message = `${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`;
  const sign = crypto.createHmac('sha256', secret).update(message).digest('hex');

  return { sign, timestamp };
}

/**
 * If the app uses XOR-obfuscated secrets (common pattern), this helper
 * de-obfuscates them. Pattern: secret = XOR(stringConst, keyConst).
 */
export function deobfuscateXor(input: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ key[i % key.length];
  }
  return out;
}

/**
 * Get the signing secret. Order of precedence:
 *  1. VFS_MOBILE_SIGNING_SECRET env var (set by user after extraction)
 *  2. Throws — refuses to sign without it
 */
export function getSigningSecret(): string {
  const secret = process.env.VFS_MOBILE_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      'VFS_MOBILE_SIGNING_SECRET not configured. Extract it from the VFS Android APK ' +
        '(see MOBILE_API_FINDINGS.md once Phase 2 capture is done) and add to backend/.env.',
    );
  }
  return secret;
}
