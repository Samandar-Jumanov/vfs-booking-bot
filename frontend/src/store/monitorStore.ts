import { create } from 'zustand';

export interface SlotInfo {
  date: string;
  time: string;
  destination: string;
  visaType: string;
}

export interface LogEntry {
  id?: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  eventType: string;
  message: string;
  destination?: string;
}

interface MonitorStatus {
  id: string;
  destination: string;
  visaType: string;
  isRunning: boolean;
  lastCheckedAt: string | null;
  slotDetectedCount: number;
  mode: string;
  interval: number;
}


interface MonitorStore {
  monitors: MonitorStatus[];
  latestSlots: SlotInfo[];
  liveLogFeed: LogEntry[];
  setMonitors: (monitors: MonitorStatus[]) => void;
  addSlot: (slot: SlotInfo) => void;
  addLogEntry: (entry: LogEntry) => void;
  clearLogs: () => void;
}

export const useMonitorStore = create<MonitorStore>((set) => ({
  monitors: [],
  latestSlots: [],
  liveLogFeed: [],
  setMonitors: (monitors) => set({ monitors }),
  addSlot: (slot) =>
    set((state) => ({ latestSlots: [slot, ...state.latestSlots].slice(0, 50) })),
  addLogEntry: (entry) =>
    set((state) => ({ liveLogFeed: [entry, ...state.liveLogFeed].slice(0, 500) })),
  clearLogs: () => set({ liveLogFeed: [] }),
}));
