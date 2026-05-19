// Tiny content script that runs on the operator's dashboard origin and
// responds to PING_EXTENSION messages so the dashboard can show
// "Installed: Detected" instead of "Waiting" forever.
//
// The dashboard sends:
//   window.postMessage({ source: 'vfs-dashboard', type: 'PING_EXTENSION' })
// We respond with:
//   window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' })

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as { source?: string; type?: string } | undefined;
  if (!data || data.source !== 'vfs-dashboard' || data.type !== 'PING_EXTENSION') return;
  window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
});

// Announce presence on injection so the dashboard doesn't have to wait for
// its first ping.
window.postMessage({ source: 'vfs-booking-extension', type: 'EXTENSION_PRESENT' }, window.location.origin);
