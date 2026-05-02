'use client';
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/store/authStore';

export interface CaptchaPrompt {
  sessionId: string;
  image?: string; // base64
}

export function useCaptchaPrompt() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [prompt, setPrompt] = useState<CaptchaPrompt | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const s = io(process.env.NEXT_PUBLIC_WS_URL ?? '', {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
    });
    s.on('CAPTCHA_REQUIRED', (data: CaptchaPrompt) => setPrompt(data));
    setSocket(s);
    return () => { s.disconnect(); };
  }, [accessToken]);

  function submitSolution(token: string) {
    if (!prompt || !socket) return;
    socket.emit('CAPTCHA_SOLVED', { sessionId: prompt.sessionId, token });
    setPrompt(null);
  }

  function dismissPrompt() {
    setPrompt(null);
  }

  return { prompt, submitSolution, dismissPrompt };
}
