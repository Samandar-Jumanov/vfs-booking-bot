'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { ModernSidebar } from '@/components/layout/ModernSidebar';
import { CaptchaModal } from '@/components/ui/CaptchaModal';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  // Wait one tick so Zustand's persist middleware can rehydrate from
  // localStorage before we decide the user is unauthenticated. Without this,
  // the first render of every page bounces to /login even when a token
  // is in localStorage.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  useWebSocket(); // initialise WS connection for all protected pages

  useEffect(() => {
    if (hydrated && !user) router.replace('/login');
  }, [hydrated, user, router]);

  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <ModernSidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {children}
      </div>
      <CaptchaModal />
    </div>
  );
}

