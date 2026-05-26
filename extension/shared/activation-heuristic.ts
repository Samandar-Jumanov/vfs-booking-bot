/**
 * Pure success-heuristic for the "open the VFS activation link in a real Chrome
 * tab" flow (BG_VISIT_ACTIVATION_LINK → runActivationVisit). Kept free of any
 * `chrome` / DOM dependency so it can be unit-tested without a browser.
 *
 * After opening the activation link we read the landed tab's final URL plus the
 * first ~400 chars of body text. The activation counts as a real success only
 * when the page positively indicates an activated / verified / sign-in state
 * AND shows none of the failure markers (page-not-found / error / expired /
 * invalid / not found). This replaces the old BrightData HTTP visit that
 * returned status=0 and falsely marked accounts ACTIVE.
 */
export interface ActivationVisitProbe {
  href: string;
  bodyText: string;
}

export interface ActivationVisitVerdict {
  success: boolean;
  reason: string;
}

const SUCCESS_RE = /activat|verified|success|sign ?in|log ?in|account.*active/i;
const FAILURE_BODY_RE = /error|expired|invalid|not found/i;

export function evaluateActivationVisit(probe: ActivationVisitProbe): ActivationVisitVerdict {
  const href = probe.href ?? '';
  const bodyText = probe.bodyText ?? '';

  if (href.includes('page-not-found')) {
    return { success: false, reason: 'PAGE_NOT_FOUND' };
  }
  if (FAILURE_BODY_RE.test(bodyText)) {
    return { success: false, reason: 'FAILURE_MARKER_IN_BODY' };
  }
  if (SUCCESS_RE.test(bodyText) || SUCCESS_RE.test(href)) {
    return { success: true, reason: 'ACTIVATION_MARKER_FOUND' };
  }
  return { success: false, reason: 'NO_ACTIVATION_MARKER' };
}
