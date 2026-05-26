import { solveTurnstile as _solveTurnstile } from '@modules/captcha/twoCaptcha';

/**
 * Thin wrapper around existing 2Captcha Turnstile solver.
 * Used by ExtensionDriver as fallback when the widget yields no token.
 * Returns null if solving fails so the caller can handle TURNSTILE_FAILED.
 */
export async function solveTurnstile(sitekey: string, pageUrl: string): Promise<string | null> {
  try {
    return await _solveTurnstile(sitekey, pageUrl);
  } catch {
    return null;
  }
}
