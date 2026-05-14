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
  Code2,
  Cookie,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
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
  const [testStatus, setTestStatus] = useState<{ tone: 'idle' | 'success' | 'warn' | 'error'; message: string }>({ tone: 'idle', message: '' });
  const [soundEnabled, setSoundEnabled] = useState(false);
  const v = (k: string) => local[k] !== undefined ? local[k] : settings?.[k];
  const set = (k: string, val: any) => setLocal((p: any) => ({ ...p, [k]: val }));

  useEffect(() => {
    setSoundEnabled(window.localStorage.getItem('vfs.slotSoundEnabled') === 'true');
  }, []);

  const handleSoundToggle = (enabled: boolean) => {
    setSoundEnabled(enabled);
    window.localStorage.setItem('vfs.slotSoundEnabled', enabled ? 'true' : 'false');
  };

  const handleTelegramTest = async () => {
    setTestStatus({ tone: 'idle', message: 'Sending Telegram test...' });
    try {
      await api.post('/settings/notifications/test');
      setTestStatus({ tone: 'success', message: `✓ Sent to Telegram at ${new Date().toLocaleTimeString()}` });
    } catch (errorValue) {
      const errorObject = errorValue as { response?: { status?: number; data?: { error?: string; message?: string } }; message?: string };
      if (errorObject.response?.status === 404) {
        setTestStatus({ tone: 'warn', message: '⚠ Endpoint not yet available - TRACK 4 not merged' });
        return;
      }
      setTestStatus({
        tone: 'error',
        message: errorObject.response?.data?.error ?? errorObject.response?.data?.message ?? errorObject.message ?? 'Telegram test failed',
      });
    }
  };

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
        <SettingToggle
          label="Slot Sound"
          description="Play an optional browser sound when a slot is detected. Stored on this device only."
          checked={soundEnabled}
          onChange={handleSoundToggle}
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
        <div className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-white">Telegram delivery test</h3>
            <p className="mt-1 text-xs text-muted-foreground">Sends one test ping to the configured chat.</p>
          </div>
          <button
            type="button"
            onClick={handleTelegramTest}
            className="h-12 rounded-xl bg-primary px-5 text-xs font-black uppercase tracking-widest text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
          >
            Send test Telegram
          </button>
        </div>
        {testStatus.message && (
          <div className={cn(
            'flex items-center gap-3 rounded-xl border p-4 text-sm font-medium',
            testStatus.tone === 'success' && 'border-green-500/30 bg-green-500/10 text-green-200',
            testStatus.tone === 'warn' && 'border-amber-500/30 bg-amber-500/10 text-amber-200',
            testStatus.tone === 'error' && 'border-red-500/30 bg-red-500/10 text-red-200',
            testStatus.tone === 'idle' && 'border-blue-500/30 bg-blue-500/10 text-blue-200'
          )}>
            {testStatus.tone === 'success' && <CheckCircle2 className="h-5 w-5" />}
            {testStatus.tone === 'warn' && <AlertTriangle className="h-5 w-5" />}
            {testStatus.tone === 'error' && <XCircle className="h-5 w-5" />}
            {testStatus.tone === 'idle' && <RefreshCcw className="h-5 w-5 animate-spin" />}
            <span>{testStatus.message}</span>
          </div>
        )}
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

// ── Cookie Injection Panel ────────────────────────────────────────────────────

function CookieInjectionSettings() {
  const [destination, setDestination] = useState('prt');
  const [cookieStr, setCookieStr] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [errMsg, setErrMsg] = useState('');

  const { data: injected, refetch } = useQuery<Array<{ destination: string; setAt: string; expiresAt: string; cookieCount: number; valid: boolean }>>({
    queryKey: ['injected-cookies'],
    queryFn: () => api.get('/monitor/injected-cookies').then(r => r.data),
    refetchInterval: 30000,
  });

  const handleInject = async () => {
    if (!cookieStr.trim()) return;
    setStatus('saving');
    try {
      await api.post('/monitor/inject-cookies', { destination, cookies: cookieStr });
      setStatus('ok');
      setCookieStr('');
      refetch();
      setTimeout(() => setStatus('idle'), 3000);
    } catch (e: any) {
      setStatus('err');
      setErrMsg(e?.response?.data?.error || e.message);
    }
  };

  const destLabels: Record<string, string> = { prt: 'Portugal', tjk: 'Tajikistan', lva: 'Latvia' };

  return (
    <div className="bg-card/40 backdrop-blur-2xl border border-white/5 rounded-[2rem] overflow-hidden shadow-2xl">
      <div className="p-10 space-y-8">
        <div className="flex items-center gap-5">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
            <Cookie className="w-7 h-7" />
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl font-black tracking-tight text-white uppercase">Session Cookie Injection</h2>
            <p className="text-sm text-muted-foreground font-medium max-w-md">
              Bypass bot detection — paste your real browser cookies directly into the monitor.
            </p>
          </div>
        </div>

        {/* Instructions */}
        <div className="p-6 rounded-2xl bg-blue-500/10 border border-blue-500/20 space-y-3">
          <p className="text-xs font-black uppercase tracking-widest text-blue-400">How to get cookies</p>
          <ol className="text-xs text-blue-200/80 font-medium leading-relaxed space-y-1.5 list-decimal list-inside">
            <li>Open Chrome and log into <span className="font-mono text-blue-300">visa.vfsglobal.com/uzb/prt/en/schedule-appointment</span></li>
            <li>Open DevTools (F12) → <strong>Network</strong> tab</li>
            <li>Click any request to <span className="font-mono text-blue-300">visa.vfsglobal.com</span></li>
            <li>In <strong>Request Headers</strong>, find the <span className="font-mono text-blue-300">cookie:</span> line</li>
            <li>Copy the entire value and paste it below</li>
          </ol>
        </div>

        {/* Active injected cookies status */}
        {injected && injected.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {injected.map(item => (
              <div key={item.destination} className={cn(
                "p-5 rounded-2xl border flex flex-col gap-2",
                item.valid ? "bg-green-500/10 border-green-500/20" : "bg-zinc-800/40 border-white/5 opacity-50"
              )}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black uppercase tracking-widest text-white">{destLabels[item.destination] || item.destination}</span>
                  {item.valid
                    ? <CheckCircle2 className="w-5 h-5 text-green-400" />
                    : <XCircle className="w-5 h-5 text-zinc-500" />}
                </div>
                <p className="text-xs text-muted-foreground font-medium">{item.cookieCount} cookies</p>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
                  <Clock className="w-3 h-3" />
                  <span>Expires {new Date(item.expiresAt).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Injection form */}
        <div className="space-y-6">
          <div className="space-y-3">
            <label className="text-xs font-black uppercase tracking-widest text-muted-foreground/60 pl-2">Destination</label>
            <div className="grid grid-cols-3 gap-3">
              {(['prt', 'tjk', 'lva'] as const).map(d => (
                <button key={d} onClick={() => setDestination(d)} className={cn(
                  "h-14 rounded-2xl border-2 transition-all font-black text-sm uppercase tracking-widest",
                  destination === d
                    ? "bg-primary/10 border-primary text-primary"
                    : "bg-white/5 border-white/5 text-muted-foreground hover:bg-white/10"
                )}>
                  {destLabels[d]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <label className="text-xs font-black uppercase tracking-widest text-muted-foreground/60 pl-2">Cookie Header Value</label>
            <textarea
              value={cookieStr}
              onChange={e => setCookieStr(e.target.value)}
              placeholder="VFS-SESSION=abc123; .ASPXAUTH=xyz; XSRF-TOKEN=token123; ..."
              spellCheck={false}
              className="w-full h-40 bg-black/40 border border-white/10 rounded-2xl p-5 text-sm text-green-300 placeholder:text-zinc-700 focus:ring-4 focus:ring-primary/10 focus:border-primary/50 transition-all outline-none font-mono leading-relaxed"
            />
          </div>

          {status === 'err' && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 font-mono">{errMsg}</div>
          )}

          <button
            onClick={handleInject}
            disabled={!cookieStr.trim() || status === 'saving'}
            className={cn(
              "h-14 px-10 rounded-xl font-black uppercase tracking-widest text-sm transition-all active:scale-95 flex items-center gap-3",
              cookieStr.trim() && status !== 'saving'
                ? "bg-primary text-primary-foreground shadow-lg shadow-primary/30 hover:bg-primary/90"
                : "bg-white/5 text-muted-foreground cursor-not-allowed grayscale"
            )}
          >
            {status === 'saving' && <RefreshCcw className="w-5 h-5 animate-spin" />}
            {status === 'ok' && <CheckCircle2 className="w-5 h-5 text-green-400" />}
            {(status === 'idle' || status === 'err') && <Cookie className="w-5 h-5" />}
            {status === 'ok' ? 'Injected!' : status === 'saving' ? 'Injecting...' : 'Inject Cookies'}
          </button>
        </div>
      </div>
    </div>
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
    { id: 'cookies', label: 'Session Cookies', icon: Cookie },
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

            {activeTab === 'cookies' && (
              <CookieInjectionSettings />
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
