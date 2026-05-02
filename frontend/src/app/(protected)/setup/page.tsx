'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMonitorStore } from '@/store/monitorStore';
import { cn } from '@/lib/utils';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { 
  Plus, 
  Play, 
  StopCircle, 
  Settings2, 
  Globe, 
  Zap, 
  ShieldCheck, 
  AlertTriangle,
  Clock,
  LayoutGrid,
  ChevronRight,
  UserCheck
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function SetupPage() {
  const qc = useQueryClient();
  const { setMonitors } = useMonitorStore();

  const [sourceCountry, setSourceCountry] = useState<'uzbekistan' | 'tajikistan' | 'latvia'>('uzbekistan');
  const [destination, setDestination] = useState<'portugal' | 'brazil'>('portugal');
  const [visaType, setVisaType] = useState('SCH');
  const [intervalMs, setIntervalMs] = useState(10000);
  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [proxy, setProxy] = useState<{ 
    host: string; 
    port: number; 
    username?: string; 
    password?: string 
  } | null>(null);

  const { data: profilesData } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get('/profiles').then((r) => r.data),
  });
  const profiles: { id: string; fullName: string; priority: string }[] = profilesData?.items ?? [];

  const { data: monitorStatus, refetch: refetchStatus } = useQuery({
    queryKey: ['monitor-status'],
    queryFn: () => api.get('/monitor/status').then((r) => { setMonitors(r.data); return r.data; }),
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: () => api.post('/monitor/start', { 
      sourceCountry,
      destination, 
      visaType, 
      intervalMs, 
      profileIds: selectedProfileIds, 
      mode,
      proxy: proxy?.host ? proxy : undefined
    }),
    onSuccess: () => { 
      setSelectedProfileIds([]); 
      setProxy(null);
      refetchStatus(); 
      qc.invalidateQueries({ queryKey: ['monitor-status'] }); 
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => api.post(`/monitor/stop/${id}`),
    onSuccess: () => refetchStatus(),
  });

  const activeMonitors = (monitorStatus ?? []).filter((m: { isRunning: boolean }) => m.isRunning);

  return (
    <DashboardShell 
      title="Monitoring Engine Control" 
      description="Deploy and calibrate advanced visa appointment detection units with real-time acquisition logic."
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* Left Column: Configuration Form (7 slots) */}
        <div className="lg:col-span-7 space-y-6">
          {/* Monitor Control */}
          <div className="card p-8 bg-card/40 backdrop-blur-md border-primary/20 shadow-2xl shadow-primary/5 relative z-[20]">
            <div className="absolute top-0 left-0 w-full h-1 bg-primary/30" />
            <div className="flex items-center gap-4 mb-8">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <Settings2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold tracking-tight">Engine Configuration</h3>
                <p className="text-xs text-muted-foreground">Setup target parameters for slot acquisition.</p>
              </div>
            </div>

            <div className="space-y-10">
              {/* Route Configuration */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
                <CustomSelect
                  label="Applying From"
                  value={sourceCountry}
                  onChange={(val: any) => setSourceCountry(val)}
                  options={[
                    { value: 'uzbekistan', label: 'Uzbekistan' },
                    { value: 'tajikistan', label: 'Tajikistan' },
                    { value: 'latvia', label: 'Latvia' },
                  ]}
                />
                <CustomSelect
                  label="Target Destination"
                  value={destination}
                  onChange={(val: any) => setDestination(val)}
                  options={[
                    { value: 'portugal', label: 'Portugal' },
                    { value: 'brazil', label: 'Brazil' },
                  ]}
                />
                <CustomSelect
                  label="Visa Category"
                  value={visaType}
                  onChange={setVisaType}
                  options={[
                    { value: 'SCH', label: 'Schengen Short-Stay Visa' },
                    { value: 'TRV', label: 'Tourist Visa' },
                    { value: 'VIS', label: 'Visitor Visa' },
                    { value: 'BUS', label: 'Business Visa' },
                    { value: 'STU', label: 'Student Visa' },
                    { value: 'WRK', label: 'Work Visa' },
                    { value: 'SEA', label: 'Seasonal Work Visa' },
                    { value: 'JOB', label: 'Job Seeker Visa' },
                    { value: 'DNV', label: 'Digital Nomad Visa' },
                    { value: 'D7',  label: 'D7 Passive Income Visa' },
                    { value: 'GLD', label: 'Golden Visa (Investment)' },
                    { value: 'FAM', label: 'Family Reunification' },
                    { value: 'MED', label: 'Medical Treatment Visa' },
                    { value: 'TRN', label: 'Airport Transit Visa' },
                  ]}
                />
              </div>

              {/* Execution Mode Toggle */}
              <div className="space-y-4">
                <label className="text-[10px] uppercase font-black tracking-widest text-muted-foreground pl-1">Execution Strategy</label>
                <div className="grid grid-cols-2 gap-4">
                  {(['auto', 'manual'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={cn(
                        "p-4 rounded-xl border flex flex-col items-center gap-2 transition-all duration-300",
                        mode === m 
                          ? "bg-primary/10 border-primary shadow-[0_0_15px_rgba(var(--primary),0.2)]" 
                          : "bg-accent/20 border-transparent hover:border-muted text-muted-foreground"
                      )}
                    >
                      {m === 'auto' ? <Zap className="w-5 h-5 text-primary" /> : <AlertTriangle className="w-5 h-5" />}
                      <span className="text-sm font-bold uppercase tracking-wide">{m} Mode</span>
                      <span className="text-[10px] opacity-70">
                        {m === 'auto' ? 'Automated Booking' : 'Alert Only (Dry Run)'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Polling Velocity Slider */}
              <div className="space-y-4 bg-accent/10 p-6 rounded-2xl border border-dashed">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase font-black tracking-widest text-muted-foreground pl-1 flex items-center gap-2">
                    <Clock className="w-3 h-3" /> Polling Intensity
                  </label>
                  <span className="text-xs font-mono font-bold bg-primary/20 text-primary px-2 py-0.5 rounded leading-none">
                    {intervalMs / 1000}s Interval
                  </span>
                </div>
                <input
                  type="range"
                  min={1000}
                  max={60000}
                  step={1000}
                  value={intervalMs}
                  onChange={(e) => setIntervalMs(Number(e.target.value))}
                  className="w-full h-2 bg-accent rounded-full appearance-none cursor-pointer accent-primary"
                />
                <div className="flex justify-between text-[10px] font-black text-muted-foreground/50 uppercase tracking-widest">
                  <span className="text-primary font-black">Turbo (1s)</span>
                  <span>Conservative (60s)</span>
                </div>
              </div>

              {/* Profile Target Matrix */}
              <div className="space-y-4">
                 <label className="text-[10px] uppercase font-black tracking-widest text-muted-foreground pl-1 flex items-center gap-2">
                    <UserCheck className="w-3 h-3" /> Target Profiles
                  </label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-2 custom-scrollbar">
                    {profiles.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setSelectedProfileIds(prev => 
                          prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id]
                        )}
                        className={cn(
                          "flex items-center justify-between p-3 rounded-xl border text-left transition-all",
                          selectedProfileIds.includes(p.id)
                            ? "bg-primary/5 border-primary shadow-sm"
                            : "bg-accent/20 border-transparent hover:border-muted text-muted-foreground opacity-60 hover:opacity-100"
                        )}
                      >
                        <span className="text-xs font-bold truncate pr-2">{p.fullName}</span>
                        <span className={cn(
                          "text-[9px] px-1.5 py-0.5 rounded font-black",
                          p.priority === 'HIGH' ? "bg-amber-500/20 text-amber-500" : "bg-zinc-500/20 text-zinc-500"
                        )}>
                          {p.priority}
                        </span>
                      </button>
                    ))}
                    {!profiles.length && <p className="col-span-full text-xs text-muted-foreground italic py-4">No active profiles — go to Applicants first.</p>}
                  </div>
              </div>

              {/* Trigger Button */}
              <button
                disabled={startMutation.isPending || selectedProfileIds.length === 0}
                onClick={() => startMutation.mutate()}
                className="w-full btn-primary h-14 rounded-2xl gap-3 text-lg font-bold shadow-xl shadow-primary/20 disabled:grayscale hover:scale-[1.01] active:scale-[0.98] transition-all"
              >
                {startMutation.isPending ? (
                  <div className="w-6 h-6 border-2 border-primary-foreground border-t-transparent animate-spin rounded-full" />
                ) : (
                  <>
                    <Play className="w-5 h-5 fill-current" />
                    Engage Monitoring
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Proxy Configuration (New) */}
          <div className="card p-8 bg-card/40 backdrop-blur-md border-primary/10 shadow-xl mt-6">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-lg font-bold tracking-tight">Secure Tunneling (Proxy)</h3>
                <p className="text-xs text-muted-foreground">Bypass IP blocks with residential proxies.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-muted-foreground pl-1">Proxy Host</label>
                <input 
                  type="text" 
                  placeholder="e.g. proxy.myservice.com"
                  className="w-full bg-accent/20 border-transparent focus:border-primary/50 rounded-xl p-3 text-sm transition-all"
                  value={proxy?.host || ''}
                  onChange={(e) => setProxy(prev => ({ ...prev!, host: e.target.value, port: prev?.port || 8080 }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-muted-foreground pl-1">Port</label>
                <input 
                  type="number" 
                  placeholder="8080"
                  className="w-full bg-accent/20 border-transparent focus:border-primary/50 rounded-xl p-3 text-sm transition-all"
                  value={proxy?.port || ''}
                  onChange={(e) => setProxy(prev => ({ ...prev!, port: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-muted-foreground pl-1">Username (Opt)</label>
                <input 
                  type="text" 
                  className="w-full bg-accent/20 border-transparent focus:border-primary/50 rounded-xl p-3 text-sm transition-all"
                  value={proxy?.username || ''}
                  onChange={(e) => setProxy(prev => ({ ...prev!, username: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black text-muted-foreground pl-1">Password (Opt)</label>
                <input 
                  type="password" 
                  className="w-full bg-accent/20 border-transparent focus:border-primary/50 rounded-xl p-3 text-sm transition-all"
                  value={proxy?.password || ''}
                  onChange={(e) => setProxy(prev => ({ ...prev!, password: e.target.value }))}
                />
              </div>
            </div>
            <p className="mt-4 text-[10px] text-muted-foreground italic">Note: HTTP/HTTPS proxies ONLY. SOCKS proxies require additional setup.</p>
          </div>
        </div>

        {/* Right Column: Active Streams (5 slots) */}
        <div className="lg:col-span-5 space-y-6">
          <div className="flex items-center justify-between px-2">
             <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">Active Streams</h3>
             <span className="text-[10px] font-mono text-muted-foreground bg-accent px-2 py-0.5 rounded">{activeMonitors.length} Units</span>
          </div>

          <div className="space-y-4">
            <AnimatePresence mode="popLayout">
              {activeMonitors.map((m: any) => (
                <motion.div
                  layout
                  key={m.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="card p-5 bg-card/60 border-l-4 border-l-green-500 group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center text-green-500 relative">
                        <Zap className="w-5 h-5 fill-current" />
                        <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-green-500 animate-ping opacity-50" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold uppercase tracking-tight">
                          {m.sourceCountry ? m.sourceCountry.toUpperCase() : 'N/A'} → {m.destination.toUpperCase()}
                        </h4>
                        <p className="text-[10px] text-muted-foreground">{m.visaType}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => stopMutation.mutate(m.id)}
                      className="p-2 rounded-lg bg-destructive/5 text-destructive/40 hover:bg-destructive hover:text-white transition-all shadow-sm"
                    >
                      <StopCircle className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-dashed">
                     <div className="space-y-1">
                        <p className="text-[9px] uppercase font-black text-muted-foreground tracking-widest">Slots Captured</p>
                        <p className="text-sm font-black text-green-500">{m.slotDetectedCount}</p>
                     </div>
                     <div className="space-y-1">
                        <p className="text-[9px] uppercase font-black text-muted-foreground tracking-widest">Current Latency</p>
                        <p className="text-sm font-mono font-bold">{(m.interval || 0).toFixed(1)}s</p>
                     </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-accent rounded-full overflow-hidden">
                       <motion.div 
                        initial={{ width: "0%" }}
                        animate={{ width: "100%" }}
                        transition={{ duration: m.interval || 5, repeat: Infinity, ease: "linear" }}
                        className="h-full bg-green-500/50"
                       />
                    </div>
                    <span className="text-[9px] text-muted-foreground uppercase font-bold tracking-tighter">Syncing...</span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {activeMonitors.length === 0 && (
              <div className="py-20 flex flex-col items-center justify-center text-center opacity-30 grayscale border-2 border-dashed rounded-3xl">
                <ShieldCheck className="w-12 h-12 mb-4" />
                <h3 className="text-sm font-bold uppercase tracking-widest">No Active Engine</h3>
                <p className="text-xs">Configure and start a monitor unit to see activity here.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
