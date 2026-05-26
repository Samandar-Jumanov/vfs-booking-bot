export interface SlotInfo {
  date: string;
  time: string;
}

export interface SlotWatcherOptions {
  onSlotDetected: (slot: SlotInfo) => void;
}

/**
 * Maintains a set of previously-seen slots. On each poll result, fires
 * onSlotDetected for each slot that did NOT exist in the previous result.
 * First observation is always treated as baseline (no event).
 */
export class SlotWatcher {
  private lastSeen: Set<string> | null = null;

  constructor(private readonly opts: SlotWatcherOptions) {}

  recordPollResult(slots: SlotInfo[]): void {
    const keys = new Set(slots.map((s) => `${s.date}|${s.time}`));

    if (this.lastSeen === null) {
      this.lastSeen = keys;
      return;
    }

    for (const slot of slots) {
      const key = `${slot.date}|${slot.time}`;
      if (!this.lastSeen.has(key)) {
        this.opts.onSlotDetected(slot);
      }
    }
    this.lastSeen = keys;
  }

  reset(): void {
    this.lastSeen = null;
  }
}
