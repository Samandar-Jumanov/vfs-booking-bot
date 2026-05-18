'use client';
import { useState } from 'react';
import { format } from 'date-fns';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { 
  Download, 
  Search, 
  Terminal, 
  Filter, 
  Calendar, 
  AlertCircle, 
  Info, 
  AlertTriangle,
  RefreshCw,
  User,
  History,
  ArrowRight,
  Trash2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { CustomDatePicker } from '@/components/ui/CustomDatePicker';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { motion, AnimatePresence } from 'framer-motion';

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  eventType: string;
  message: string;
  destination?: string;
  result?: string;
  profile?: { fullName: string } | null;
}

const EVENT_TYPES = [
  'SLOT_DETECTED', 
  'BOOKING_ATTEMPT', 
  'BOOKING_SUCCESS', 
  'BOOKING_FAILED', 
  'IP_BLOCKED', 
  'SESSION_EXPIRED', 
  'CAPTCHA_REQUIRED'
];

export default function LogsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [eventType, setEventType] = useState('');
  const [level, setLevel] = useState('');
  const [isClearing, setIsClearing] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['logs', from, to, eventType, level],
    queryFn: () =>
      api.get('/logs', { 
        params: { 
          from: from || undefined, 
          to: to || undefined, 
          eventType: eventType || undefined, 
          level: level || undefined, 
          limit: 200 
        } 
      }).then((r) => r.data),
  });

  function downloadCsv() {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (eventType) params.set('eventType', eventType);
    window.open(`/api/logs/export?${params}`, '_blank');
  }

  async function handleClearLogs() {
    if (!confirm('Are you certain you want to truncate all diagnostic logs? This action is irreversible.')) return;
    setIsClearing(true);
    try {
      await api.delete('/logs');
      refetch();
    } catch (err) {
      console.error('Failed to clear logs:', err);
    } finally {
      setIsClearing(false);
    }
  }

  const getLevelIcon = (lvl: string) => {
    switch (lvl) {
      case 'ERROR': return <AlertCircle className="w-3.5 h-3.5 text-red-500" />;
      case 'WARN': return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
      default: return <Info className="w-3.5 h-3.5 text-blue-500" />;
    }
  };

  return (
    <DashboardShell 
      title="System Intelligence Diagnostics" 
      description="REAL-TIME TELEMETRY STREAM AND HISTORICAL EVENT ANALYSIS FOR MONITORING ENGINES."
      actions={
        <button 
          onClick={downloadCsv}
          className="btn-secondary h-9 px-4 gap-2 text-xs font-bold uppercase tracking-wider"
        >
          <Download className="w-3.5 h-3.5" />
          Export Dataset
        </button>
      }
    >
      <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* Advanced Filter Bar */}
        <div className="card p-6 bg-card/40 backdrop-blur-md border-dashed border-muted grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 relative z-[30]">
          <CustomDatePicker
            label="From"
            value={from}
            onChange={setFrom}
          />
          <CustomDatePicker
            label="To"
            value={to}
            onChange={setTo}
          />
          <CustomSelect
            label="Category"
            value={eventType}
            onChange={setEventType}
            options={[
              { value: '', label: 'All Events' },
              ...EVENT_TYPES.map(t => ({ value: t, label: t.replace(/_/g, ' ') }))
            ]}
          />
          <CustomSelect
            label="Severity"
            value={level}
            onChange={setLevel}
            options={[
              { value: '', label: 'All Levels' },
              { value: 'INFO', label: 'INFO' },
              { value: 'WARN', label: 'WARN' },
              { value: 'ERROR', label: 'ERROR' },
            ]}
          />
          
          <div className="flex items-end">
            <motion.button 
              onClick={() => refetch()}
              disabled={isFetching}
              whileTap={{ scale: 0.96 }}
              animate={isFetching ? { 
                scale: [1, 0.98, 1],
                borderColor: ["rgba(var(--primary-rgb), 0.1)", "rgba(var(--primary-rgb), 0.4)", "rgba(var(--primary-rgb), 0.1)"]
              } : { scale: 1 }}
              transition={isFetching ? { 
                repeat: Infinity, 
                duration: 1.5, 
                ease: "easeInOut" 
              } : { duration: 0.2 }}
              className={cn(
                "btn-secondary h-11 w-full flex items-center justify-center transition-all rounded-xl gap-2 hover:bg-accent/20 border border-primary/10 relative overflow-hidden group whitespace-nowrap",
                isFetching && "ring-2 ring-primary/10"
              )}
            >
              {isFetching && (
                <motion.div 
                  initial={{ x: "-100%" }}
                  animate={{ x: "100%" }}
                  transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/5 to-transparent z-0"
                />
              )}
              
              <motion.div
                animate={isFetching ? { rotate: 360 } : { rotate: 0 }}
                transition={isFetching ? { repeat: Infinity, duration: 1, ease: "linear" } : { duration: 0.2 }}
                className="relative z-10"
              >
                <RefreshCw className="w-4 h-4 text-primary" />
              </motion.div>
              
              <span className="text-[10px] font-black uppercase tracking-[0.2em] relative z-10 text-foreground group-hover:text-primary transition-colors">
                {isFetching ? 'Scanning' : 'Refresh'}
              </span>
            </motion.button>
          </div>
        </div>

        {/* Diagnostic Terminal View */}
        <div className="card p-0 bg-accent/5 backdrop-blur-xl border-accent/20 overflow-hidden shadow-2xl transition-all duration-300 relative z-[10]">
          <div className="bg-accent/10 border-b border-accent/20 px-6 py-3 flex items-center justify-between">
             <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                   <div className="w-2.5 h-2.5 rounded-full bg-red-500/30 border border-red-500/20" />
                   <div className="w-2.5 h-2.5 rounded-full bg-amber-500/30 border border-amber-500/20" />
                   <div className="w-2.5 h-2.5 rounded-full bg-green-500/30 border border-green-500/20" />
                </div>
                <div className="h-4 w-[1px] bg-border/50 mx-2" />
                <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-[0.2em] font-black">diagnostic.stream</span>
             </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={handleClearLogs}
                  disabled={isClearing || !data?.items?.length}
                  className="flex items-center gap-1.5 px-3 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-500 transition-colors border border-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed group/clear"
                >
                   <Trash2 className="w-3 h-3 transition-transform group-hover/clear:scale-110" />
                   <span className="text-[9px] font-black uppercase tracking-widest">Clear Stream</span>
                </button>
                <div className="h-4 w-[1px] bg-border/20 mx-1" />
                <span className="text-[10px] font-mono text-muted-foreground/60 uppercase tracking-widest bg-accent/20 px-2 py-0.5 rounded">
                   Buffer: {data?.items?.length || 0}
                </span>
              </div>
          </div>

          <div className="overflow-x-auto min-h-[500px] relative">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-accent/5 border-b border-accent/10">
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/70">Timestamp</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/70">Level</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/70">Identifier</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/70">Trace Message</th>
                  <th className="px-6 py-4 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/70">Context</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/20 font-mono text-[11px]">
                <AnimatePresence mode="popLayout">
                  {isLoading ? (
                    <tr>
                      <td colSpan={5} className="py-20 text-center">
                         <div className="flex flex-col items-center gap-4">
                            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary animate-spin rounded-full" />
                            <p className="text-[10px] uppercase font-black tracking-widest text-muted-foreground/40">Initializing telemetry scan...</p>
                         </div>
                      </td>
                    </tr>
                  ) : data?.items?.length ? (
                    data.items.map((log: LogEntry, idx: number) => (
                      <motion.tr
                        layout
                        initial={{ opacity: 0, x: -4 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.2, delay: idx * 0.005 }}
                        key={log.id}
                        className={cn(
                          "group transition-all duration-200 border-l-[3px] border-l-transparent",
                          log.level === 'ERROR' ? "hover:border-l-red-500 hover:bg-red-500/5 bg-red-500/[0.02]" :
                          log.level === 'WARN' ? "hover:border-l-amber-500 hover:bg-amber-500/5 bg-amber-500/[0.02]" :
                          "hover:border-l-primary hover:bg-primary/5"
                        )}
                      >
                        <td className="px-6 py-3.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground/50 tabular-nums">
                          {format(new Date(log.timestamp), 'HH:mm:ss.SSS')}
                        </td>
                        <td className="px-6 py-3.5">
                          <div className={cn(
                            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[9px] font-black uppercase tracking-tighter",
                            log.level === 'ERROR' ? "bg-red-500/10 border-red-500/20 text-red-500" :
                            log.level === 'WARN' ? "bg-amber-500/10 border-amber-500/20 text-amber-500" :
                            "bg-blue-500/10 border-blue-500/20 text-blue-500"
                          )}>
                            {log.level}
                          </div>
                        </td>
                        <td className="px-6 py-3.5">
                           <span className={cn(
                             "px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground border border-border/50 uppercase tracking-tighter text-[9px] font-bold transition-colors group-hover:border-primary/30",
                             log.eventType === 'BOOKING_SUCCESS' && "bg-green-500/10 text-green-500 border-green-500/20"
                           )}>
                             {log.eventType}
                           </span>
                        </td>
                        <td className="px-6 py-3.5">
                          <p className={cn(
                            "truncate max-w-xl text-foreground font-medium group-hover:text-primary transition-colors",
                            log.level === 'ERROR' && "text-red-400",
                            log.level === 'WARN' && "text-amber-400"
                          )}>
                            {log.message}
                          </p>
                        </td>
                        <td className="px-6 py-3.5">
                           {log.profile ? (
                             <div className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground transition-opacity">
                               <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center border border-border/50">
                                 <User className="w-3 h-3" />
                               </div>
                               <span className="text-[10px] uppercase font-bold tracking-tight">{log.profile.fullName}</span>
                             </div>
                           ) : (
                             <span className="text-[10px] text-muted-foreground/30 uppercase tracking-widest">SYSTEM_ROOT</span>
                           )}
                        </td>
                      </motion.tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="py-32 text-center">
                         <div className="flex flex-col items-center gap-4 opacity-30 grayscale transition-all group-hover:opacity-50">
                            <div className="w-16 h-16 rounded-full bg-accent/50 flex items-center justify-center border border-border border-dashed">
                               <Terminal className="w-8 h-8" />
                            </div>
                            <div className="space-y-1">
                               <h4 className="text-xs font-black uppercase tracking-[0.3em]">EOF: Buffer Empty</h4>
                               <p className="text-[10px] max-w-[200px] mx-auto opacity-70">No matching telemetry signals detected in the current execution window.</p>
                            </div>
                         </div>
                      </td>
                    </tr>
                  )}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
          
          <div className="px-6 py-4 bg-accent/5 border-t border-accent/20 flex items-center justify-between">
             <div className="flex items-center gap-4">
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-[0.2em] font-black">
                   Telemetry Signal: <span className="text-green-500">Active</span>
                </span>
                <div className="h-3 w-[1px] bg-border/50" />
                <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-[0.2em]">
                   Samples: {data?.total || 0}
                </span>
             </div>
             <div className="flex gap-1.5 items-center">
               <span className="text-[8px] font-black text-muted-foreground uppercase mr-2 opacity-50 tracking-tighter">Live Monitor</span>
               <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
               <div className="w-1.5 h-1.5 bg-green-500/50 rounded-full animate-pulse delay-150" />
             </div>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
