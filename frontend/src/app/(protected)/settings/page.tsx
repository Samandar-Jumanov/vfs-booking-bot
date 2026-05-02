'use client';
import { useState, useEffect, Suspense } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import {
  Bell,
  Shield,
  ChevronRight,
  Save,
  RefreshCcw,
  Mail,
  Zap,
  Send,
  ShieldCheck,
  Code2
} from 'lucide-react';
import { api } from '@/lib/api';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SettingsData {
  [key: string]: any;
}

interface SettingComponentProps {
  settings: SettingsData | undefined;
  onSave: (newData: Record<string, any>) => void;
  saving: boolean;
}

// ── Settings Content Components ───────────────────────────────────────────────

function TelegramSettings({ settings, onSave, saving }: SettingComponentProps) {
  const [local, setLocal] = useState<Record<string, any>>({});
  const v = (k: string) => local[k] !== undefined ? local[k] : settings?.[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  return (
    <SettingsCard 
      title="Telegram Bot Integration" 
      description="Real-time operational alerts and interactive remote control via Telegram."
      icon={Send}
      onSave={() => onSave(local)}
      saving={saving}
      isDirty={Object.keys(local).length > 0}
    >
      <div className="space-y-6">
        <SettingToggle 
          label="Enable Telegram Alerts" 
          description="Activate real-time push notifications for slot detection and booking updates."
          checked={v('notifications.telegram.enabled') || false} 
          onChange={(val: boolean) => set('notifications.telegram.enabled', val)} 
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
          <SettingInput 
            label="Bot Token" 
            placeholder="123456:ABC-DEF..."
            type="password"
            value={v('notifications.telegram.botToken') || ''} 
            onChange={(val: string) => set('notifications.telegram.botToken', val)} 
          />
          <SettingInput 
            label="Chat ID" 
            placeholder="-100..."
            value={v('notifications.telegram.chatId') || ''} 
            onChange={(val: string) => set('notifications.telegram.chatId', val)} 
          />
        </div>
      </div>
    </SettingsCard>
  );
}

function EmailSettings({ settings, onSave, saving }: SettingComponentProps) {
  const [local, setLocal] = useState<Record<string, any>>({});
  const v = (k: string) => local[k] !== undefined ? local[k] : settings?.[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  return (
    <SettingsCard 
      title="Email Notifications" 
      description="Standardized reports and critical audit trails delivered to your inbox."
      icon={Mail}
      onSave={() => onSave(local)}
      saving={saving}
      isDirty={Object.keys(local).length > 0}
    >
      <div className="space-y-6">
        <SettingToggle 
          label="Enable Email Dispatch" 
          description="Send detailed session summaries and booking confirmations via email."
          checked={v('notifications.email.enabled') || false} 
          onChange={(val: boolean) => set('notifications.email.enabled', val)} 
        />
        <div className="pt-4">
          <SettingInput 
            label="Recipient Address" 
            placeholder="operator@vfs-engine.io"
            value={v('notifications.email.recipient') || ''} 
            onChange={(val: string) => set('notifications.email.recipient', val)} 
          />
        </div>
      </div>
    </SettingsCard>
  );
}

function CaptchaSettings({ settings, onSave, saving }: SettingComponentProps) {
  const [local, setLocal] = useState<Record<string, any>>({});
  const v = (k: string) => local[k] !== undefined ? local[k] : settings?.[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  return (
    <SettingsCard 
      title="CAPTCHA Resolver" 
      description="Automate security bypass using neural networks or manual interception."
      icon={Shield}
      onSave={() => onSave(local)}
      saving={saving}
      isDirty={Object.keys(local).length > 0}
    >
      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-4">
           {['manual', 'twocaptcha'].map((m) => (
             <button
              key={m}
              onClick={() => set('captcha.solver', m)}
              className={cn(
                "h-20 rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-1",
                v('captcha.solver') === m 
                  ? "bg-primary/10 border-primary text-primary" 
                  : "bg-white/5 border-white/5 text-muted-foreground hover:bg-white/10"
              )}
             >
                <span className="text-sm font-black uppercase tracking-widest">{m}</span>
                <span className="text-[10px] opacity-60 font-medium">{m === 'manual' ? 'No External API' : 'High Reliability'}</span>
             </button>
           ))}
        </div>
        
        {v('captcha.solver') === 'twocaptcha' && (
          <div className="animate-in fade-in slide-in-from-top-4 duration-500">
             <SettingInput 
                label="2Captcha API Key" 
                placeholder="4c9e...6f7a"
                type="password"
                value={v('captcha.twoCaptchaApiKey') || ''} 
                onChange={(val: string) => set('captcha.twoCaptchaApiKey', val)} 
              />
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

function NetworkSettings({ settings, onSave, saving }: SettingComponentProps) {
  const [local, setLocal] = useState<Record<string, any>>({});
  const g = settings?.global || {};
  const v = (k: string) => local[k] !== undefined ? local[k] : g[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  return (
    <SettingsCard 
      title="Global Infrastructure Proxy" 
      description="Apply a system-wide residential proxy to all monitoring units by default."
      icon={ShieldCheck}
      onSave={() => onSave(local)}
      saving={saving}
      isDirty={Object.keys(local).length > 0}
    >
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingInput 
            label="Default Proxy Host" 
            placeholder="proxy.example.com"
            value={v('proxyHost') || ''} 
            onChange={(val: string) => set('proxyHost', val)} 
          />
          <SettingNumber 
            label="Proxy Port" 
            value={v('proxyPort') || 8080} 
            onChange={(val: number) => set('proxyPort', val)} 
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4">
          <SettingInput 
            label="Proxy Username (Optional)" 
            placeholder="user123"
            value={v('proxyUsername') || ''} 
            onChange={(val: string) => set('proxyUsername', val)} 
          />
          <SettingInput 
            label="Proxy Password (Optional)" 
            placeholder="••••••••"
            type="password"
            value={v('proxyPassword') || ''} 
            onChange={(val: string) => set('proxyPassword', val)} 
          />
        </div>
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex gap-4 items-start">
           <Zap className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
           <p className="text-[10px] text-amber-200/70 font-medium leading-relaxed">
             <strong>Warning:</strong> Global proxy settings will act as a fallback. If a specific monitor has its own proxy configured, the monitor-specific one will take precedence.
           </p>
        </div>
      </div>
    </SettingsCard>
  );
}

function EngineSettings({ settings, onSave, saving }: SettingComponentProps) {
  const [local, setLocal] = useState<Record<string, any>>({});
  const v = (k: string) => local[k] !== undefined ? local[k] : settings?.[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  return (
    <SettingsCard 
      title="Agent Mode Configuration" 
      description="Fine-tune the execution engine for maximum throughput and stealth."
      icon={Zap}
      onSave={() => onSave(local)}
      saving={saving}
      isDirty={Object.keys(local).length > 0}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        <SettingNumber 
          label="Polling Interval (MS)" 
          value={v('monitor.defaultIntervalMs') || 30000} 
          onChange={(val: number) => set('monitor.defaultIntervalMs', val)}
          min={5000}
          max={300000}
        />
        <SettingNumber 
          label="System Concurrency" 
          value={v('booking.concurrency') || 1} 
          onChange={(val: number) => set('booking.concurrency', val)}
          min={1}
          max={10}
        />
        <SettingNumber 
          label="Maximum Retries" 
          value={v('booking.maxRetries') || 3} 
          onChange={(val: number) => set('booking.maxRetries', val)}
          min={0}
          max={20}
        />
      </div>
    </SettingsCard>
  );
}

function SelectorsSettings({ settings, onSave, saving }: SettingComponentProps) {
  const initial = settings?.['vfs.selectors'] ?? {};
  const initialText = JSON.stringify(initial, null, 2);
  const [text, setText] = useState(initialText);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setText(JSON.stringify(settings?.['vfs.selectors'] ?? {}, null, 2)); }, [settings]);

  const isDirty = text !== initialText;

  const handleSave = () => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      setErr(null);
      onSave({ 'vfs.selectors': parsed });
    } catch (e: any) {
      setErr(`Invalid JSON: ${e.message}`);
    }
  };

  return (
    <SettingsCard
      title="VFS Selector Overrides"
      description="Hot-patch CSS selectors when the VFS site DOM changes. No redeploy required — engine reloads on next booking attempt."
      icon={Code2}
      onSave={handleSave}
      saving={saving}
      isDirty={isDirty}
    >
      <div className="space-y-4">
        <div className="space-y-3">
          <label className="text-xs font-black uppercase tracking-widest text-muted-foreground/60 pl-2">
            Selector Map (JSON)
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='{\n  "loginEmail": "input[name=email]",\n  "loginPassword": "input[name=password]"\n}'
            className="w-full h-96 bg-black/40 border border-white/10 rounded-2xl p-6 text-sm text-green-300 placeholder:text-zinc-700 focus:ring-4 focus:ring-primary/10 focus:border-primary/50 transition-all outline-none font-mono leading-relaxed"
          />
          {err && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 font-mono">
              {err}
            </div>
          )}
        </div>
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex gap-4 items-start">
          <Code2 className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
          <p className="text-[10px] text-amber-200/70 font-medium leading-relaxed">
            Only override the keys you need to change — everything else falls back to defaults. Common keys: <code>loginEmail</code>, <code>loginPassword</code>, <code>loginSubmit</code>, <code>bookAppointmentLink</code>, <code>countryOfResidenceDropdown</code>, <code>destinationCountryDropdown</code>, <code>visaCategoryDropdown</code>, <code>continueButton</code>, <code>slotDateCell</code>, <code>slotTimeButton</code>, <code>submitButton</code>, <code>confirmButton</code>, <code>confirmationNumber</code>.
          </p>
        </div>
      </div>
    </SettingsCard>
  );
}

// ── Atomic UI Components ──────────────────────────────────────────────────────

function SettingsCard({ title, description, children, onSave, saving, isDirty, icon: Icon }: {
  title: string;
  description: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
  isDirty: boolean;
  icon: any;
}) {
  return (
    <div className="bg-card/40 backdrop-blur-2xl border border-white/5 rounded-[2rem] overflow-hidden shadow-2xl relative group">
      <div className="p-10 space-y-8">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-5">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
              <Icon className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <h2 className="text-2xl font-black tracking-tight text-white uppercase">{title}</h2>
              <p className="text-sm text-muted-foreground font-medium max-w-md">{description}</p>
            </div>
          </div>
          <button
            onClick={onSave}
            disabled={!isDirty || saving}
            className={cn(
               "h-12 px-8 rounded-xl font-black uppercase tracking-widest text-xs transition-all active:scale-95 flex items-center gap-2",
               isDirty 
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90" 
                : "bg-white/5 text-muted-foreground cursor-not-allowed grayscale"
            )}
          >
            {saving ? <RefreshCcw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Commit Changes
          </button>
        </div>

        <div className="relative pt-2">
          {children}
        </div>
      </div>
    </div>
  );
}

function SettingToggle({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between group/row p-6 bg-white/[0.02] border border-white/5 rounded-2xl hover:bg-white/[0.04] transition-all">
      <div className="space-y-1.5 px-2">
        <h3 className="text-lg font-black tracking-tight text-white uppercase">{label}</h3>
        <p className="text-sm text-muted-foreground/80 font-medium">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={cn(
          "w-14 h-8 rounded-full transition-all relative flex items-center px-1",
          checked ? "bg-primary shadow-[0_0_15px_rgba(var(--primary),0.4)]" : "bg-zinc-800"
        )}
      >
        <motion.div 
          animate={{ x: checked ? 24 : 0 }}
          className="w-6 h-6 bg-white rounded-full shadow-lg"
        />
      </button>
    </div>
  );
}

function SettingInput({ label, value, onChange, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const isPass = type === "password";

  return (
    <div className="space-y-4">
      <label className="text-xs font-black uppercase tracking-widest text-muted-foreground/60 pl-2">{label}</label>
      <div className="relative group">
        <input
          type={isPass ? (show ? "text" : "password") : type}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full h-16 bg-white/[0.03] border-white/10 rounded-2xl px-6 text-lg text-white placeholder:text-zinc-800 focus:ring-4 focus:ring-primary/10 focus:border-primary/50 transition-all outline-none font-medium"
        />
        {isPass && (
          <button 
            type="button"
            onClick={() => setShow(!show)}
            className="absolute right-6 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
          >
            <ShieldCheck className={cn("w-5 h-5", show && "text-primary")} />
          </button>
        )}
      </div>
    </div>
  );
}

function SettingNumber({ label, value, onChange, min, max }: {
  label: string;
  value: number;
  onChange: (val: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-4">
      <label className="text-xs font-black uppercase tracking-widest text-muted-foreground/60 pl-2">{label}</label>
      <div className="relative group">
        <input
          type="number"
          value={value || 0}
          onChange={(e) => onChange(parseInt(e.target.value))}
          min={min}
          max={max}
          className="w-full h-16 bg-white/[0.03] border-white/10 rounded-2xl px-6 text-2xl text-white focus:ring-4 focus:ring-primary/10 focus:border-primary/50 transition-all outline-none font-black"
        />
         <div className="absolute right-6 top-1/2 -translate-y-1/2 flex flex-col gap-1">
             <div className="w-1.5 h-1.5 rounded-full bg-primary/40" />
             <div className="w-1.5 h-1.5 rounded-full bg-primary/20" />
         </div>
      </div>
    </div>
  );
}

// ── Main Page Content ──────────────────────────────────────────────────────────

function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams.get('tab') as any) || 'notifications';
  const [activeTab, setActiveTab] = useState(initialTab);
  
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t) setActiveTab(t);
  }, [searchParams]);

  const { data: settings, refetch, isLoading } = useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: () => api.get('/settings').then((res) => res.data),
  });

  const mutation = useMutation({
    mutationFn: (newData: any) => api.patch('/settings', newData),
    onSuccess: () => refetch(),
  });

  const globalMutation = useMutation({
    mutationFn: (newData: any) => api.post('/settings/global', newData),
    onSuccess: () => refetch(),
  });

  if (isLoading) {
    return (
       <div className="flex flex-col items-center justify-center py-48 space-y-6">
          <RefreshCcw className="w-16 h-16 animate-spin text-primary opacity-40" />
          <p className="text-sm font-black uppercase tracking-widest text-muted-foreground animate-pulse">Synchronizing Security Vault...</p>
       </div>
    );
  }

  const tabs = [
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'captcha', label: 'Captcha Solver', icon: Shield },
    { id: 'network', label: 'Network Proxy', icon: ShieldCheck },
    { id: 'engine', label: 'Agent Mode', icon: Zap },
    { id: 'selectors', label: 'VFS Selectors', icon: Code2 },
  ];

  const handleSave = (newData: any) => {
    mutation.mutate(newData);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 animate-in fade-in zoom-in-95 duration-1000">
      {/* Navigation Sidebar */}
      <div className="lg:col-span-3 space-y-3">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={cn(
              "w-full flex items-center justify-between px-6 py-5 rounded-[1.5rem] text-sm font-black uppercase tracking-widest transition-all duration-500 overflow-hidden relative group",
              activeTab === tab.id 
                ? "bg-primary text-primary-foreground shadow-2xl shadow-primary/40 scale-[1.05]" 
                : "text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent hover:border-white/5"
            )}
          >
            <div className="flex items-center gap-4 relative z-10">
              <tab.icon className={cn(
                "w-5 h-5 transition-all duration-500",
                activeTab === tab.id ? "rotate-[15deg] scale-125" : "group-hover:rotate-12 group-hover:scale-110"
              )} />
              <span>{tab.label}</span>
            </div>
            {activeTab === tab.id ? (
               <ChevronRight className="w-4 h-4" />
            ) : (
               <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
            )}
            {activeTab === tab.id && (
              <motion.div 
                layoutId="tab-bg"
                className="absolute inset-0 bg-gradient-to-r from-primary to-blue-600 opacity-20"
              />
            )}
          </button>
        ))}
        
        <div className="mt-12 p-8 rounded-[2rem] bg-indigo-500/10 border border-indigo-500/20 relative overflow-hidden group">
           <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-3xl -mr-16 -mt-16" />
           <p className="text-[10px] font-black uppercase tracking-widest text-indigo-400 mb-2">System Health</p>
           <h4 className="text-sm font-bold text-indigo-200">Terminal encryption active and validated.</h4>
        </div>
      </div>

      {/* Content Area */}
      <div className="lg:col-span-9">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 30, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -30, scale: 0.98 }}
            transition={{ type: "spring", damping: 30, stiffness: 200 }}
            className="space-y-10"
          >
            {activeTab === 'notifications' && (
              <div className="space-y-10">
                <TelegramSettings settings={settings} onSave={handleSave} saving={mutation.isPending} />
                <EmailSettings settings={settings} onSave={handleSave} saving={mutation.isPending} />
              </div>
            )}
            
            {activeTab === 'captcha' && (
              <CaptchaSettings settings={settings} onSave={handleSave} saving={mutation.isPending} />
            )}

            {activeTab === 'network' && (
              <NetworkSettings settings={settings} onSave={(data) => globalMutation.mutate(data)} saving={globalMutation.isPending} />
            )}

            {activeTab === 'engine' && (
              <EngineSettings settings={settings} onSave={handleSave} saving={mutation.isPending} />
            )}

            {activeTab === 'selectors' && (
              <SelectorsSettings settings={settings} onSave={handleSave} saving={mutation.isPending} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <DashboardShell 
      title="Global Configuration" 
      description="Refine execution behaviors, secure alert streams, and automated bypasses."
    >
      <Suspense fallback={<div>Loading Configuration...</div>}>
         <SettingsContent />
      </Suspense>
    </DashboardShell>
  );
}
