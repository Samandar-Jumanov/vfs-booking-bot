'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  LayoutDashboard, 
  Users, 
  Activity, 
  Settings, 
  LogOut, 
  Terminal,
  ShieldCheck,
  Bell,
  Navigation
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { motion } from 'framer-motion';

const menuItems = [
  { group: 'Operations', items: [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Monitoring', href: '/setup', icon: Activity },
    { label: 'Activity Logs', href: '/logs', icon: Terminal },
  ]},
  { group: 'Records', items: [
    { label: 'Applicants', href: '/profiles', icon: Users },
  ]},
  { group: 'System', items: [
    // { label: 'Agent Mode', href: '/settings?tab=engine', icon: ShieldCheck },
    // { label: 'Notifications', href: '/settings?tab=notifications', icon: Bell },
    { label: 'Global Settings', href: '/settings', icon: Settings },
  ]},
];

export function ModernSidebar() {
  const pathname = usePathname();
  const logout = useAuthStore((s) => s.logout);

  return (
    <aside className="w-64 border-r bg-card/30 backdrop-blur-xl flex flex-col h-full transition-all duration-300">
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Navigation className="w-5 h-5 text-primary-foreground" />
        </div>
        <span className="font-bold text-lg tracking-tight">VFS Engine</span>
      </div>

      <nav className="flex-1 px-4 py-4 space-y-8 overflow-y-auto">
        {menuItems.map((group) => (
          <div key={group.group} className="space-y-2">
            <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              {group.group}
            </h3>
            <div className="space-y-1">
              {group.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 group relative",
                      isActive 
                        ? "bg-accent text-accent-foreground shadow-sm" 
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    <item.icon className={cn(
                      "w-4 h-4 transition-colors",
                      isActive ? "text-primary" : "group-hover:text-foreground"
                    )} />
                    {item.label}
                    {isActive && (
                      <motion.div
                        layoutId="active-nav"
                        className="absolute left-0 w-1 h-4 bg-primary rounded-full"
                        transition={{ type: "spring", stiffness: 300, damping: 300 }}
                      />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-4 border-t bg-accent/20">
        <button
          onClick={logout}
          className="flex items-center gap-3 w-full px-3 py-2 text-sm font-medium text-muted-foreground hover:text-destructive transition-colors rounded-lg hover:bg-destructive/10"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
