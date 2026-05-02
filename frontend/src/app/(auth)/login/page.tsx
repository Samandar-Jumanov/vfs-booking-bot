'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { Lock, Mail, ChevronRight, Zap, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      setAuth(data.user, data.accessToken);
      router.push('/dashboard');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Brand Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-primary/10 text-primary mb-4 border border-primary/20 shadow-[0_0_20px_rgba(var(--primary),0.1)]">
          <Zap className="w-8 h-8 fill-current" />
        </div>
        <h1 className="text-3xl font-black tracking-tighter text-white uppercase">Command Center</h1>
        <p className="text-sm text-zinc-500 font-medium">Initialize secure terminal session</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 bg-white/5 backdrop-blur-xl p-8 rounded-[2rem] border border-white/10 shadow-2xl relative overflow-hidden group">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-right from-transparent via-primary/50 to-transparent opacity-50" />
        
        {error && (
          <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-bold animate-in fade-in slide-in-from-top-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-[10px] uppercase font-black tracking-[0.2em] text-zinc-500 pl-1" htmlFor="email">
              Identity Identifier
            </label>
            <div className="relative group/field">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/field:text-primary" />
              <input
                id="email"
                type="email"
                placeholder="operator@vfs-engine.io"
                className="w-full h-12 bg-white/5 border-white/10 rounded-xl pl-12 pr-4 text-sm text-white placeholder:text-zinc-700 focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all outline-none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between pl-1">
              <label className="text-[10px] uppercase font-black tracking-[0.2em] text-zinc-500" htmlFor="password">
                Access Token
              </label>
              <button type="button" className="text-[9px] uppercase font-black text-primary/60 hover:text-primary transition-colors">
                Recover Access
              </button>
            </div>
            <div className="relative group/field">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600 transition-colors group-focus-within/field:text-primary" />
              <input
                id="password"
                type="password"
                placeholder="••••••••••••"
                className="w-full h-12 bg-white/5 border-white/10 rounded-xl pl-12 pr-4 text-sm text-white placeholder:text-zinc-700 focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
        </div>

        <button 
          type="submit" 
          disabled={loading}
          className="w-full h-12 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl flex items-center justify-center gap-2 font-black uppercase tracking-widest text-xs transition-all active:scale-[0.98] shadow-lg shadow-primary/20 disabled:grayscale"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent animate-spin rounded-full" />
          ) : (
            <>
              Initialize Session
              <ChevronRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      <div className="text-center pt-4">
        <p className="text-[10px] text-zinc-600 uppercase tracking-widest font-bold">
          Encrypted with 256-bit AES protection
        </p>
      </div>
    </div>
  );
}
