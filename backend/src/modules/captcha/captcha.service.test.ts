// Pure-function tests for the captcha-type detection priority.
// The real detector lives in captcha.service.ts and runs inside
// page.evaluate(); here we replicate its decision tree against
// JSDOM-style fixtures.

type DetectedType = 'turnstile' | 'cf-challenge' | 'recaptcha' | 'image' | 'none';

interface Fixture {
  hasTurnstile?: boolean;
  hasCfChallenge?: boolean;
  hasRecaptcha?: boolean;
  hasImage?: boolean;
  sitekey?: string;
}

function classify(f: Fixture): { type: DetectedType; sitekey?: string } {
  if (f.hasTurnstile) return { type: 'turnstile', sitekey: f.sitekey };
  if (f.hasCfChallenge) return { type: 'cf-challenge' };
  if (f.hasRecaptcha && f.sitekey) return { type: 'recaptcha', sitekey: f.sitekey };
  if (f.hasImage) return { type: 'image' };
  return { type: 'none' };
}

describe('captcha detection priority', () => {
  it('reports none on a clean page', () => {
    expect(classify({}).type).toBe('none');
  });

  it('detects Turnstile and returns its sitekey', () => {
    const result = classify({ hasTurnstile: true, sitekey: '0x4AAA' });
    expect(result.type).toBe('turnstile');
    expect(result.sitekey).toBe('0x4AAA');
  });

  it('Turnstile takes priority over coexisting Cloudflare challenge', () => {
    expect(classify({ hasTurnstile: true, hasCfChallenge: true, sitekey: 'x' }).type).toBe(
      'turnstile'
    );
  });

  it('falls back to cf-challenge when only the interstitial is present', () => {
    expect(classify({ hasCfChallenge: true }).type).toBe('cf-challenge');
  });

  it('detects reCAPTCHA when sitekey is exposed', () => {
    const result = classify({ hasRecaptcha: true, sitekey: '6Ld' });
    expect(result.type).toBe('recaptcha');
    expect(result.sitekey).toBe('6Ld');
  });

  it('treats reCAPTCHA without sitekey as image fallback', () => {
    expect(classify({ hasRecaptcha: true, hasImage: true }).type).toBe('image');
  });

  it('detects image captcha as last resort', () => {
    expect(classify({ hasImage: true }).type).toBe('image');
  });
});
