'use client';
import { useState } from 'react';
import { useCaptchaPrompt } from '@/hooks/useCaptchaPrompt';
import { ShieldAlert, Send, X, Terminal } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

export function CaptchaModal() {
  const { prompt, submitSolution, dismissPrompt } = useCaptchaPrompt();
  const [token, setToken] = useState('');

  if (!prompt) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    submitSolution(token.trim());
    setToken('');
  }

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
        {/* Backdrop */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={dismissPrompt}
        />

        {/* Modal Card */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className="relative w-full max-w-md bg-card/80 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="bg-primary/10 border-b border-primary/20 px-8 py-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/20 rounded-xl text-primary">
                <ShieldAlert className="w-5 h-5 animate-pulse" />
              </div>
              <div className="space-y-0.5">
                <h2 className="text-sm font-black uppercase tracking-widest text-white">Security Intercept</h2>
                <div className="flex items-center gap-2 opacity-50">
                   <Terminal className="w-3 h-3 text-primary" />
                   <code className="text-[10px] font-mono tracking-tighter uppercase">{prompt.sessionId.slice(0, 8)}...</code>
                </div>
              </div>
            </div>
            <button 
              onClick={dismissPrompt}
              className="p-2 hover:bg-white/5 rounded-full transition-colors text-muted-foreground hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="p-8 space-y-6">
            <p className="text-xs text-muted-foreground leading-relaxed uppercase font-black tracking-tight">
              A neural-gate (CAPTCHA) has been detected in the current execution stream. Manual resolution required to proceed with booking.
            </p>

            {prompt.image && (
              <div className="relative group p-2 rounded-2xl bg-black/20 border border-white/5 overflow-hidden">
                <img
                  src={`data:image/png;base64,${prompt.image}`}
                  alt="CAPTCHA Challenge"
                  className="w-full rounded-xl border border-white/10 shadow-lg grayscale group-hover:grayscale-0 transition-all duration-500"
                />
                <div className="absolute inset-x-2 bottom-2 h-1 bg-primary/20 rounded-full overflow-hidden">
                   <motion.div 
                    initial={{ x: "-100%" }}
                    animate={{ x: "100%" }}
                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                    className="h-full w-1/3 bg-primary shadow-[0_0_10px_rgba(var(--primary),0.5)]"
                   />
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-black tracking-widest text-muted-foreground pl-1">
                  Decrypted Solution
                </label>
                <input
                  type="text"
                  className="w-full h-12 bg-white/5 border-white/10 rounded-xl px-4 text-sm text-white placeholder:text-zinc-700 focus:ring-2 focus:ring-primary/20 focus:border-primary/50 transition-all outline-none"
                  placeholder="Enter alphanumeric sequence..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  className="flex-1 h-12 rounded-xl text-xs font-black uppercase tracking-widest bg-white/5 hover:bg-white/10 text-white transition-all border border-white/10 active:scale-95" 
                  onClick={dismissPrompt}
                >
                  Bypass
                </button>
                <button 
                  type="submit" 
                  className="flex-[2] h-12 bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl flex items-center justify-center gap-2 font-black uppercase tracking-widest text-xs transition-all active:scale-[0.98] shadow-lg shadow-primary/20"
                >
                  <Send className="w-4 h-4" />
                  Commit Solution
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white/5 border-t border-white/10 px-8 py-4 flex items-center justify-center gap-2 opacity-30 grayscale transition-all hover:opacity-100 hover:grayscale-0">
             <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
             <span className="text-[9px] uppercase font-black tracking-widest text-white">Encrypted Handshake active</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

