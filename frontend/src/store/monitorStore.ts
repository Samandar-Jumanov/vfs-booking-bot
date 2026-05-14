import { create } from 'zustand';
import type { LogEntryPayload, MonitorStatusPayload, SlotInfo as WsSlotInfo } from '@/types/ws-events';

export type SlotInfo = WsSlotInfo;

export type LogEntry = LogEntryPayload;
export type MonitorStatus = MonitorStatusPayload;


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
