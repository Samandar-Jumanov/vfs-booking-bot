'use client';
import { motion } from 'framer-motion';
import { useAuthStore } from '@/store/authStore';
import { Bell, Search, User } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

interface DashboardShellProps {
  children: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function DashboardShell({ children, title, description, actions }: DashboardShellProps) {
  const user = useAuthStore((s) => s.user);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <header className="h-20 border-b bg-card/10 backdrop-blur-md px-8 flex items-center justify-between sticky top-0 z-40">
        <div className="flex flex-col min-w-0">
          <h1 className="text-2xl font-black tracking-tight text-foreground truncate">{title}</h1>
          <p className="text-[10px] md:text-sm text-muted-foreground/80 font-medium uppercase tracking-wider truncate">{description}</p>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0 ml-4">
          {actions && <div className="flex-shrink-0">{actions}</div>}
          
          <div className="mr-4 h-9 flex items-center border-r pr-4 border-border/50">
             <ThemeToggle size="sm" />
          </div>

          <div className="relative hidden md:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input 
              type="text" 
              placeholder="Search engine..." 
              className="bg-accent/50 border-none h-9 w-64 rounded-lg pl-9 text-sm focus:ring-1 focus:ring-ring"
            />
          </div>
          
          <button className="p-2 rounded-lg hover:bg-accent relative">
            <Bell className="w-5 h-5 text-muted-foreground" />
            <span className="absolute top-2 right-2 w-2 h-2 bg-primary rounded-full" />
          </button>

          <div className="flex items-center gap-3 pl-4 border-l">
            <div className="flex flex-col items-end hidden sm:flex">
              <span className="text-sm font-medium">{user?.email?.split('@')[0]}</span>
              <span className="text-[10px] text-muted-foreground uppercase">{user?.role}</span>
            </div>
            <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center border">
              <User className="w-5 h-5 text-muted-foreground" />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8 pt-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
