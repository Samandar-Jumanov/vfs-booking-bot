'use client';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { api } from '@/lib/api';
import { useMonitorStore } from '@/store/monitorStore';
import { cn } from '@/lib/utils';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { MetricCard } from '@/components/dashboard/MetricCard';
import { Activity, Zap, CheckCircle, Shield, Radio, Terminal, Server, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function DashboardPage() {
  const { liveLogFeed, monitors } = useMonitorStore();
  const logContainerRef = useRef<HTMLDivElement>(null);

  const { data: bookingData } = useQuery({
    queryKey: ['booking-history'],
    queryFn: () => api.get('/booking/history?limit=1').then((r) => r.data),
    refetchInterval: 10_000,
  });

  const rowVirtualizer = useVirtualizer({
    count: liveLogFeed.length,
    getScrollElement: () => logContainerRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  const activeMonitors = monitors.filter((m) => m.isRunning).length;
  const lastBooking = bookingData?.items?.[0];
  const detectedCount = monitors.reduce((acc, m) => acc + m.slotDetectedCount, 0);

  return (
    <DashboardShell 
      title="Command Center" 
      description="Real-time system telemetry and automation monitoring."
    >
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* System Health Indicators */}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20 text-[10px] font-bold text-green-500 uppercase tracking-widest">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Engine Online
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-[10px] font-bold text-blue-500 uppercase tracking-widest">
            <Radio className="w-3 h-3" />
            Live Stream Connected
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-[10px] font-bold text-purple-500 uppercase tracking-widest">
            <Shield className="w-3 h-3" />
            AES-256 Encrypted
          </div>
        </div>

        {/* Core Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <MetricCard 
            label="Active Monitors" 
            value={activeMonitors} 
            icon={Activity}
            subValue="Real-time parallel polling"
          />
          <MetricCard 
            label="Slots Detected" 
            value={detectedCount} 
            icon={Zap}
            subValue="Detected this session"
            trend={{ value: 12, isPositive: true }}
          />
          <MetricCard 
            label="Last Booking" 
            value={lastBooking?.status || 'Standby'} 
            icon={CheckCircle}
            subValue={lastBooking?.confirmationNo || "Waiting for signal..."}
            className={cn(lastBooking?.status === 'SUCCESS' ? 'border-green-500/50 shadow-[0_0_15px_rgba(34,197,94,0.1)]' : '')}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Live Activity Console (2/3 width) */}
          <div className="lg:col-span-2 card flex flex-col h-[500px] overflow-hidden bg-zinc-950 border-zinc-800 shadow-2xl">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/50">
              <div className="flex items-center gap-3">
                <div className="p-1.5 bg-primary/10 rounded-lg text-primary">
                  <Terminal className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-zinc-100">Live Activity Feed</h3>
                  <p className="text-[10px] text-zinc-500 uppercase font-mono">Stream: /api/v1/events</p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                  <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">Capturing</span>
                </div>
              </div>
            </div>

            <div 
              ref={logContainerRef}
              className="flex-1 overflow-auto p-4 font-mono text-[11px] custom-scrollbar selection:bg-primary selection:text-primary-foreground"
            >
              <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                <AnimatePresence initial={false}>
                  {rowVirtualizer.getVirtualItems().map((row) => {
                    const entry = liveLogFeed[row.index];
                    if (!entry) return null;
                    
                    const isError = entry.level === 'ERROR';
                    const isWarn = entry.level === 'WARN';
                    const isSlot = entry.eventType === 'SLOT_DETECTED';

                    return (
                      <motion.div
                        key={row.index}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        style={{ 
                          position: 'absolute', 
                          top: 0, 
                          left: 0, 
                          width: '100%', 
                          transform: `translateY(${row.start}px)` 
                        }}
                        className={cn(
                          "group flex items-start gap-4 py-1.5 px-3 rounded-lg transition-all border-l-2 border-transparent",
                          isError && "bg-red-500/5 border-l-red-500 text-red-400",
                          isWarn && "bg-yellow-500/5 border-l-yellow-500 text-yellow-500",
                          isSlot && "bg-green-500/10 border-l-green-500 text-green-400 font-bold",
                          !isError && !isWarn && !isSlot && "hover:bg-zinc-900/50"
                        )}
                      >
                        <span className="text-zinc-600 shrink-0 select-none">
                          {new Date(entry.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span className={cn(
                          "px-1.5 py-0.5 rounded-[4px] text-[9px] font-bold uppercase tracking-tighter shrink-0",
                          isError ? "bg-red-500/20" : isWarn ? "bg-yellow-500/20" : isSlot ? "bg-green-500/20 text-green-400" : "bg-zinc-800 text-zinc-400"
                        )}>
                          {entry.eventType}
                        </span>
                        <span className="text-zinc-300 leading-relaxed font-normal">
                          {entry.message}
                        </span>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
                {liveLogFeed.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center space-y-4 opacity-20">
                    <Server className="w-12 h-12 animate-pulse text-zinc-500" />
                    <p className="text-[10px] uppercase font-black tracking-[0.2em]">Waiting for system handshake...</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Quick Engine Status (1/3 width) */}
          <div className="space-y-6">
            <div className="card p-6 bg-accent/10 border-dashed">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Globe className="w-4 h-4 text-primary" />
                Active Targets
              </h3>
              <div className="space-y-4">
                {monitors.slice(0, 3).map((m, i) => (
                  <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-background border">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold uppercase">{m.destination}</span>
                      <span className="text-[10px] text-muted-foreground">{m.visaType}</span>
                    </div>
                    <div className="px-2 py-1 rounded bg-accent text-[10px] font-mono">
                      {m.interval}s
                    </div>
                  </div>
                ))}
                {monitors.length === 0 && <p className="text-xs text-muted-foreground italic text-center py-4">No active monitors</p>}
              </div>
            </div>

            <div className="card p-6 bg-primary/5 border-primary/20 relative overflow-hidden group">
              <div className="relative z-10">
                <h3 className="text-sm font-semibold mb-2">Alpha Engine V2</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Advanced heuristics enabled. Multi-tab concurrency at 4x. Proxies rotated every 5 minutes.
                </p>
                <div className="mt-4 pt-4 border-t flex items-center justify-between">
                  <span className="text-[10px] font-bold text-primary uppercase">Status: Optimal</span>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4].map(i => <div key={i} className="w-1 h-3 bg-primary/40 rounded-full" />)}
                  </div>
                </div>
              </div>
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/20 -mr-16 -mt-16 rounded-full blur-3xl opacity-20 group-hover:opacity-40 transition-opacity" />
            </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
