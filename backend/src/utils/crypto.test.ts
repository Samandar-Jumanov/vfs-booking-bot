// Set up required env var before importing crypto module
process.env.PROFILE_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-32ch';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-32ch';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = 'redis://localhost:6379';

import { encrypt, decrypt, randomInt } from './crypto';

describe('crypto utils', () => {
  it('encrypts and decrypts round-trip', () => {
    const plaintext = 'AB123456';
    const ciphertext = encrypt(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same-value';
    const c1 = encrypt(plaintext);
    const c2 = encrypt(plaintext);
    expect(c1).not.toBe(c2);
    // But both decrypt to same value
    expect(decrypt(c1)).toBe(plaintext);
    expect(decrypt(c2)).toBe(plaintext);
  });

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('secret');
    const buf = Buffer.from(ciphertext, 'base64');
    // Flip a byte in the ciphertext portion
    buf[30] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('randomInt returns value in range', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomInt(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });
});
