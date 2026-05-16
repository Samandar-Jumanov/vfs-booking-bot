# VFS Booking Bot Chrome Extension

Manifest V3 extension that lets the customer run VFS polling and booking from their own authenticated Chrome session.

## Development

```powershell
cd extension
npm install
npm run build
```

Load `extension/dist` from `chrome://extensions` with Developer Mode enabled.

## Pairing

1. Open the web app setup page at `/extension-setup`.
2. Generate the 6-digit setup code.
3. Open the extension options page.
4. Paste the backend URL and setup code.
5. Click **Save and connect**.

The extension exchanges the one-time code for a 30-day customer-scoped JWT and then connects to `wss://<backend>/extension`.

## Privacy

The extension only runs on `*.vfsglobal.com` pages and only forwards VFS booking-flow status, slot results, session status, and booking confirmation data to the configured backend.
