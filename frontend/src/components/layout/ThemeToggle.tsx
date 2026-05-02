'use client';
import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

export function ThemeToggle({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const isSm = size === 'sm';

  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (saved) {
      setTheme(saved);
      document.documentElement.classList.toggle('dark', saved === 'dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', prefersDark);
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
  };

  return (
    <button
      onClick={toggleTheme}
      className={cn(
        "flex items-center transition-all hover:bg-white/5 group relative overflow-hidden",
        isSm ? "p-2 rounded-lg" : "w-full gap-4 px-4 py-3 rounded-xl"
      )}
      aria-label="Toggle Theme"
    >
      <div className={cn("relative flex items-center justify-center", isSm ? "w-5 h-5" : "w-6 h-6")}>
        <motion.div
          animate={{ 
            rotate: theme === 'dark' ? 0 : 90,
            opacity: theme === 'dark' ? 1 : 0,
            scale: theme === 'dark' ? 1 : 0 
          }}
          className="absolute"
        >
          <Moon className={cn(isSm ? "w-4 h-4" : "w-5 h-5", "text-indigo-400")} />
        </motion.div>
        <motion.div
          animate={{ 
            rotate: theme === 'light' ? 0 : -90,
            opacity: theme === 'light' ? 1 : 0,
            scale: theme === 'light' ? 1 : 0 
          }}
          className="absolute"
        >
          <Sun className={cn(isSm ? "w-4 h-4" : "w-5 h-5", "text-amber-400")} />
        </motion.div>
      </div>
      
      {!isSm && (
        <span className="text-sm font-bold tracking-wide text-muted-foreground group-hover:text-foreground transition-colors uppercase">
          {theme === 'dark' ? 'Dark Mode' : 'Light Mode'}
        </span>
      )}
      
      {/* Subtle glow effect */}
      <div className={cn(
        "absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity blur-xl",
        theme === 'dark' ? "bg-indigo-500" : "bg-amber-500"
      )} />
    </button>
  );
}
