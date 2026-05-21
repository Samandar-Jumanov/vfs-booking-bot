import { runE2e, assert } from './common';

runE2e('6. Booking confirmation extraction', async () => {
  const bodyText = 'Your appointment is confirmed. Confirmation number: VFSUZB8A19QZ. Please save it.';
  const confirmationNumber = bodyText.match(/[A-Z0-9]{8,}/)?.[0] ?? '';
  assert(confirmationNumber === 'VFSUZB8A19QZ', `confirmation regex extracted "${confirmationNumber}"`);
});
