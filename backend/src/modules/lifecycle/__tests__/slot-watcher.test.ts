import { SlotWatcher } from '../slot-watcher';

describe('SlotWatcher', () => {
  it('fires onSlotDetected when new slot appears that was not in previous result', () => {
    const detected: string[] = [];
    const watcher = new SlotWatcher({ onSlotDetected: (slot) => detected.push(slot.date) });

    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]);
    expect(detected).toHaveLength(0); // first observation is baseline

    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]);
    expect(detected).toHaveLength(0); // same slot, no change

    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }, { date: '2026-06-02', time: '10:00' }]);
    expect(detected).toHaveLength(1); // new slot appeared
    expect(detected[0]).toBe('2026-06-02');
  });

  it('does NOT fire when slots disappear (not a positive diff)', () => {
    const detected: string[] = [];
    const watcher = new SlotWatcher({ onSlotDetected: (s) => detected.push(s.date) });
    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]);
    watcher.recordPollResult([]); // slot vanished
    expect(detected).toHaveLength(0);
  });

  it('fires onSlotDetected for each brand-new slot in a batch', () => {
    const detected: string[] = [];
    const watcher = new SlotWatcher({ onSlotDetected: (s) => detected.push(s.date) });
    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]);
    watcher.recordPollResult([
      { date: '2026-06-01', time: '09:00' },
      { date: '2026-06-03', time: '11:00' },
      { date: '2026-06-04', time: '12:00' },
    ]);
    expect(detected).toEqual(['2026-06-03', '2026-06-04']);
  });

  it('after reset, next result is treated as baseline again', () => {
    const detected: string[] = [];
    const watcher = new SlotWatcher({ onSlotDetected: (s) => detected.push(s.date) });
    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]);
    watcher.reset();
    watcher.recordPollResult([{ date: '2026-06-01', time: '09:00' }]); // baseline again
    expect(detected).toHaveLength(0);
  });
});
