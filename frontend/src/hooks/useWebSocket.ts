'use client';
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';

let socket: Socket | null = null;

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

    socket.on('SLOT_DETECTED', (data: { slots: Parameters<typeof addSlot>[0][] }) => {
      data.slots.forEach((slot) => addSlot(slot));
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        eventType: 'SLOT_DETECTED',
        message: `${data.slots.length} new slot(s) detected`,
        destination: data.slots[0]?.destination,
      });
    });

    socket.on('BOOKING_SUCCESS', (data: { profileId: string; confirmationNo: string; destination: string }) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        eventType: 'BOOKING_SUCCESS',
        message: `Booking confirmed: ${data.confirmationNo}`,
        destination: data.destination,
      });
    });

    socket.on('BOOKING_FAILED', (data: { error: string }) => {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        eventType: 'BOOKING_FAILED',
        message: `Booking failed: ${data.error}`,
      });
    });

    socket.on('LOG_ENTRY', (entry: Parameters<typeof addLogEntry>[0]) => {
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
