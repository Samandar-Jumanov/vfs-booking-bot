'use client';
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';
import type {
  BookingFailedPayload,
  BookingProgressPayload,
  BookingSuccessPayload,
  CaptchaManualNeededPayload,
  CookieExpiringSoonPayload,
  LogEntryPayload,
  MonitorCrashedPayload,
  MonitorDeadPayload,
  MonitorStatusPayload,
  SlotDetectedPayload,
  SlotInfo,
} from '@/types/ws-events';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';

let socket: Socket | null = null;

function destinationLabel(destination?: string) {
  return destination ? destination.toUpperCase() : 'unknown destination';
}

function slotMessage(data: SlotDetectedPayload) {
  const count = data.count ?? data.slots?.length ?? 1;
  const firstSlot = data.firstSlot ?? data.slots?.[0];
  const date = firstSlot?.date ? ` for ${firstSlot.date}` : '';
  return `${count} slot${count === 1 ? '' : 's'} detected${date}`;
}

export function useWebSocket() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const { addSlot, addLogEntry } = useMonitorStore();
  const connected = useRef(false);

  useEffect(() => {
    if (!accessToken || connected.current) return;

    socket = io(WS_URL, {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => { connected.current = true; });
    socket.on('disconnect', () => { connected.current = false; });

    socket.on('SLOT_DETECTED', (data: SlotDetectedPayload) => {
      const slots: SlotInfo[] = data.slots?.length
        ? data.slots
        : [{
            date: data.firstSlot?.date,
            time: data.firstSlot?.time,
            destination: data.destination,
            visaType: data.visaType,
          }];
      slots.forEach((slot) => addSlot(slot));
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        eventType: 'SLOT_DETECTED',
        message: slotMessage(data),
        destination: data.destination ?? slots[0]?.destination,
      });
    });

    socket.on('BOOKING_SUCCESS', (data: BookingSuccessPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        eventType: 'BOOKING_SUCCESS',
        message: `Booking confirmed: ${data.confirmationNo ?? 'confirmation pending'}`,
        destination: data.destination,
      });
    });

    socket.on('BOOKING_FAILED', (data: BookingFailedPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        eventType: 'BOOKING_FAILED',
        message: `Booking failed: ${data.error ?? data.errorMessage ?? 'unknown error'}`,
        destination: data.destination,
      });
    });

    socket.on('BOOKING_PROGRESS', (data: BookingProgressPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        eventType: 'BOOKING_PROGRESS',
        message: `Booking job ${data.jobId ?? 'unknown'} is ${data.status ?? 'running'}`,
      });
    });

    socket.on('CAPTCHA_MANUAL_NEEDED', (data: CaptchaManualNeededPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        eventType: 'CAPTCHA_MANUAL_NEEDED',
        message: data.message ?? 'Manual CAPTCHA intervention required',
        destination: data.destination,
      });
    });

    socket.on('COOKIE_EXPIRING_SOON', (data: CookieExpiringSoonPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        eventType: 'COOKIE_EXPIRING_SOON',
        message: `${destinationLabel(data.destination)} cookies expire in ${data.minutesRemaining ?? '?'} minutes`,
        destination: data.destination,
      });
    });

    socket.on('MONITOR_CRASHED', (data: MonitorCrashedPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        eventType: 'MONITOR_CRASHED',
        message: `Monitor ${data.monitorId ?? destinationLabel(data.destination)} crashed${data.attempt ? `, restart attempt ${data.attempt}` : ''}`,
        destination: data.destination,
      });
    });

    socket.on('MONITOR_DEAD', (data: MonitorDeadPayload) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        eventType: 'MONITOR_DEAD',
        message: `Monitor ${data.monitorId ?? destinationLabel(data.destination)} is dead`,
        destination: data.destination,
      });
    });

    socket.on('MONITOR_STATUS', (data: MonitorStatusPayload[] | MonitorStatusPayload) => {
      useMonitorStore.getState().setMonitors(Array.isArray(data) ? data : [data]);
    });

    socket.on('LOG_ENTRY', (entry: LogEntryPayload) => {
      addLogEntry(entry);
    });

    return () => {
      socket?.disconnect();
      socket = null;
      connected.current = false;
    };
  }, [accessToken, addSlot, addLogEntry]);

  const emit = (event: string, data: unknown) => socket?.emit(event, data);
  const isConnected = () => socket?.connected ?? false;

  return { emit, isConnected };
}
