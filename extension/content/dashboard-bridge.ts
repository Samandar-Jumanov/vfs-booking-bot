// Bridge between the dashboard and the extension's service worker.
// Handles two flows:
//
// 1. EXTENSION_PRESENT ping/pong — the dashboard sends PING_EXTENSION,
//    we reply with EXTENSION_PRESENT so the dashboard can flip the
//    "Installed: Detected" badge.
//
// 2. AUTO_PAIR — the dashboard mints an extension token (already
//    authenticated via cookies) and pipes it directly to us, no
//    6-digit code typing required. We forward to the service worker,
//    which stores it and starts the cookie-sync loop.

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string; extensionToken?: string; customerEmail?: string; backendUrl?: string } | undefined;
  if (!data || data.source !== 'vfs-dashboard') return;

  if (data.type === 'PING_EXTENSION') {
    window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
    return;
  }

  if (data.type === 'AUTO_PAIR' && data.extensionToken) {
    console.log('[VFS-DASH-BRIDGE] AUTO_PAIR received, forwarding to SW');
    chrome.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        backendUrl: data.backendUrl,
        extensionToken: data.extensionToken,
        customerEmail: data.customerEmail,
      },
    }).then(() => {
      window.postMessage({ source: 'vfs-booking-extension', type: 'AUTO_PAIRED' }, window.location.origin);
    }).catch((e) => {
      console.error('[VFS-DASH-BRIDGE] SAVE_SETTINGS failed', e);
      window.postMessage({ source: 'vfs-booking-extension', type: 'AUTO_PAIR_FAILED', reason: String(e?.message ?? e) }, window.location.origin);
    });
    return;
  }
});

// Announce presence on injection so the dashboard doesn't have to wait for
// its first ping.
window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
