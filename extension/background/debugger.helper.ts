// chrome.debugger helper — sends OS-level trusted input events to a tab.
// Used to bypass Angular Material MDC's `event.isTrusted` check, which
// rejects clicks dispatched from content scripts.
//
// Usage:
//   await debuggerAttach(tabId);
//   await debuggerClickAt(tabId, x, y);
//   await debuggerDetach(tabId);
//
// IMPORTANT: chrome.debugger.attach shows a yellow "Chrome is being
// controlled by automated test software" banner across the top of the
// tab. For our use case (operator-controlled bot Chrome) this is
// acceptable — operator sees it and ignores it.

const DEBUGGER_PROTOCOL_VERSION = '1.3';
const attachedTabs = new Set<number>();

function lastError(): string | undefined {
  return chrome.runtime.lastError?.message;
}

function debuggerAttachBlockedMessage(detail: string): string {
  return `debugger.attach ${detail}. DevTools may be open on this VFS tab. Close DevTools on this tab and retry Auto-create. Open DevTools on a different tab (for example the dashboard) instead.`;
}

export function debuggerAttach(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) {
      resolve();
      return;
    }
    // Common failure modes: DevTools open on the same tab (Chrome only allows
    // one debugger per target). Use a hard timeout so this never hangs the
    // bot if the attach callback never fires.
    let settled = false;
    const timeout = self.setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = debuggerAttachBlockedMessage('timed out after 5000ms');
      console.warn(`[VFS-SW] ${message}`);
      reject(new Error(message));
    }, 5000);
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      if (settled) return;
      settled = true;
      self.clearTimeout(timeout);
      const err = lastError();
      if (err && !/already attached/i.test(err)) {
        const message = debuggerAttachBlockedMessage(`failed: ${err}`);
        console.warn(`[VFS-SW] ${message}`);
        reject(new Error(message));
        return;
      }
      attachedTabs.add(tabId);
      // Enable Input domain — required before dispatching events.
      chrome.debugger.sendCommand({ tabId }, 'Input.setIgnoreInputEvents', { ignore: false }, () => {
        resolve();
      });
    });
  });
}

export function debuggerDetach(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) {
      resolve();
      return;
    }
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      // Ignore errors on detach — tab might already be closed.
      resolve();
    });
  });
}

interface MouseEventParams {
  type: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
  x: number;
  y: number;
  button: 'none' | 'left' | 'middle' | 'right';
  clickCount: number;
  buttons?: number;
}

function sendCommand(tabId: number, method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = lastError();
      if (err) {
        reject(new Error(`${method} failed: ${err}`));
        return;
      }
      resolve(result);
    });
  });
}

export async function debuggerClickAt(tabId: number, x: number, y: number): Promise<void> {
  await debuggerAttach(tabId);
  // Move to the position first (some sites listen for mouseover/mousemove).
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', clickCount: 0,
  } satisfies MouseEventParams);
  // Press.
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  } satisfies MouseEventParams);
  // Release.
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  } satisfies MouseEventParams);
}

export async function debuggerKeyPress(tabId: number, key: string): Promise<void> {
  await debuggerAttach(tabId);
  const keyMap: Record<string, { windowsVirtualKeyCode: number; code: string; text?: string }> = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter' },
    Space: { windowsVirtualKeyCode: 32, code: 'Space', text: ' ' },
    ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab' },
  };
  const mapped = keyMap[key] ?? { windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, code: key };
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapped.windowsVirtualKeyCode,
    text: mapped.text,
    unmodifiedText: mapped.text,
  });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    nativeVirtualKeyCode: mapped.windowsVirtualKeyCode,
  });
}

export async function debuggerTypeText(tabId: number, text: string): Promise<void> {
  await debuggerAttach(tabId);
  // Use Input.insertText: it inserts the literal string reliably for EVERY
  // character (uppercase, symbols, unicode) and fires real beforeinput/input
  // events the page's framework listens to. The previous per-char
  // dispatchKeyEvent loop (text-only, no key/code/virtualKeyCode) dropped
  // shift-modified characters — e.g. "VFSbot2026!" landed as 9 chars, causing
  // wrong-password submits. insertText is the canonical fix for that.
  await sendCommand(tabId, 'Input.insertText', { text });
}

// Auto-detach when the tab closes so we don't leak attachments.
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
  });
}
if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attachedTabs.delete(source.tabId);
  });
}
