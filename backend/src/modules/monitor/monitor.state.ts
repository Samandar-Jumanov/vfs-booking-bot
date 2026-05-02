export interface MonitorConfig {
  id: string;
  sourceCountry: 'uk' | 'usa' | 'angola';
  destination: 'portugal' | 'brazil';
  visaType: string;
  intervalMs: number;
  profileIds: string[];
  mode: 'auto' | 'manual';
  proxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
  // Opt 1: when true, proxy is used only for browser warm — HTTP GET/POST go direct
  proxyForWarmOnly?: boolean;
  // Opt 3: time-gating — polling slows outside active hours and pauses during maintenance
  activeHoursUtc?: { startHour: number; endHour: number };
  maintenanceWindowUtc?: { startHour: number; endHour: number };
  offHoursIntervalMs?: number;
}

export interface MonitorState {
  config: MonitorConfig;
  isRunning: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  lastKnownSlots: Set<string>; // slot keys: "date:time"
  lastCheckedAt: Date | null;
  slotDetectedCount: number;
  lastHttpStatus?: number;
  cookies?: string[];
  cookiesSetAt?: Date;   // timestamp when cookies were last refreshed (observability)
  cookiesValid?: boolean; // Opt 2: false = invalidated by 401/403, triggers re-warm
  userAgent?: string;
  secChUa?: string;
  earlySlotData?: any;   // set by warming browser when in-session fetch succeeds
}

// In-memory map of active monitors
const monitors = new Map<string, MonitorState>();

export function setMonitor(id: string, state: MonitorState): void {
  monitors.set(id, state);
}

export function getMonitor(id: string): MonitorState | undefined {
  return monitors.get(id);
}

export function deleteMonitor(id: string): void {
  monitors.delete(id);
}

export function getAllMonitors(): MonitorState[] {
  return Array.from(monitors.values());
}
