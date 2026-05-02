import { SlotInfo } from '@t/index';

// Extract and test the pure slot-diffing logic
function slotKey(slot: SlotInfo): string {
  return `${slot.date}:${slot.time}`;
}

function diffSlots(prev: Set<string>, current: SlotInfo[]): SlotInfo[] {
  return current.filter((slot) => !prev.has(slotKey(slot)));
}

const makeSlot = (date: string, time: string): SlotInfo => ({
  date, time, destination: 'brazil', visaType: 'tourist',
});

describe('monitor slot diffing', () => {
  it('returns all slots when prev is empty', () => {
    const slots = [makeSlot('2024-06-01', '09:00'), makeSlot('2024-06-01', '10:00')];
    const result = diffSlots(new Set(), slots);
    expect(result).toHaveLength(2);
  });

  it('returns only new slots', () => {
    const existing = new Set(['2024-06-01:09:00']);
    const slots = [makeSlot('2024-06-01', '09:00'), makeSlot('2024-06-01', '10:00')];
    const result = diffSlots(existing, slots);
    expect(result).toHaveLength(1);
    expect(result[0].time).toBe('10:00');
  });

  it('returns empty array when no new slots', () => {
    const slots = [makeSlot('2024-06-01', '09:00')];
    const existing = new Set(slots.map(slotKey));
    const result = diffSlots(existing, slots);
    expect(result).toHaveLength(0);
  });

  it('handles empty current slots', () => {
    const existing = new Set(['2024-06-01:09:00']);
    const result = diffSlots(existing, []);
    expect(result).toHaveLength(0);
  });
});
