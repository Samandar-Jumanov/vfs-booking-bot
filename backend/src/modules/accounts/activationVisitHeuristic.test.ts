/**
 * Unit test for the pure activation-visit success-heuristic that the extension
 * uses to decide whether opening a VFS activation link genuinely activated the
 * account (replacing the BrightData status=0 fake-activation bug). The helper
 * lives in the extension package but is pure (no chrome/DOM deps), so we can
 * exercise it directly here.
 */
import { evaluateActivationVisit } from '../../../../extension/shared/activation-heuristic';

describe('evaluateActivationVisit', () => {
  it('succeeds on an activation/sign-in landing page', () => {
    expect(evaluateActivationVisit({
      href: 'https://visa.vfsglobal.com/uzb/en/lva/login',
      bodyText: 'Your account has been activated. Please sign in to continue.',
    })).toEqual({ success: true, reason: 'ACTIVATION_MARKER_FOUND' });
  });

  it('succeeds when the marker appears only in the href', () => {
    expect(evaluateActivationVisit({
      href: 'https://visa.vfsglobal.com/uzb/en/lva/account-activated',
      bodyText: 'Welcome',
    })).toEqual({ success: true, reason: 'ACTIVATION_MARKER_FOUND' });
  });

  it('fails on a page-not-found redirect', () => {
    expect(evaluateActivationVisit({
      href: 'https://visa.vfsglobal.com/page-not-found',
      bodyText: 'Account activated successfully',
    })).toEqual({ success: false, reason: 'PAGE_NOT_FOUND' });
  });

  it('fails when the body shows an expired/invalid error even with a success word', () => {
    expect(evaluateActivationVisit({
      href: 'https://visa.vfsglobal.com/uzb/en/lva/login',
      bodyText: 'Activation link has expired. Please request a new one.',
    })).toEqual({ success: false, reason: 'FAILURE_MARKER_IN_BODY' });
  });

  it('fails when no activation marker is present', () => {
    expect(evaluateActivationVisit({
      href: 'https://visa.vfsglobal.com/uzb/en/lva/',
      bodyText: 'Loading…',
    })).toEqual({ success: false, reason: 'NO_ACTIVATION_MARKER' });
  });

  it('handles an empty probe (executeScript returned nothing)', () => {
    expect(evaluateActivationVisit({ href: '', bodyText: '' })).toEqual({
      success: false,
      reason: 'NO_ACTIVATION_MARKER',
    });
  });
});
