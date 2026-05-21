import { runE2e, assert } from './common';

function extractConfirmationNumber(text: string): string {
  const match = text.match(/(?:booking\s+reference|confirmation\s+(?:number|no\.?|#)|appointment\s+(?:id|number)|reference|confirmation|booking)[^\w]*([A-Z0-9-]{6,30})/i);
  return match?.[1] ?? '';
}

runE2e('6. Booking confirmation extraction', async () => {
  const cases = [
    ['Your appointment is confirmed. Confirmation number: VFSUZB8A19QZ. Please save it.', 'VFSUZB8A19QZ'],
    ['Booking Reference: LVA-26-AB19QZ', 'LVA-26-AB19QZ'],
    ['Appointment ID VFS12345678', 'VFS12345678'],
  ] as const;

  for (const [bodyText, expected] of cases) {
    const confirmationNumber = extractConfirmationNumber(bodyText);
    assert(confirmationNumber === expected, `confirmation regex extracted "${confirmationNumber}" from "${bodyText}"`);
  }
});
