'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Activity,
  Settings,
  Wand2,
  LogOut,
  Terminal,
  ShieldCheck,
  Puzzle,
  Navigation,
  Wallet,
  Cookie,
  CalendarClock,
  Server,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';

const menuItems = [
  { group: 'Operations', items: [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Monitor Setup', href: '/setup', icon: Activity },
    { label: 'Bookings', href: '/bookings', icon: CalendarClock },
    { label: 'Activity Logs', href: '/logs', icon: Terminal },
  ]},
  { group: 'Records', items: [
    { label: 'Applicants', href: '/profiles', icon: Users },
    { label: 'Account Pool', href: '/account-pool', icon: ShieldCheck },
    { label: 'Inject Cookies', href: '/inject-cookies', icon: Cookie },
    { label: 'Extension Setup', href: '/extension-setup', icon: Puzzle },
  ]},
  { group: 'System', items: [
    { label: 'Fleet Status', href: '/fleet', icon: Server },
    { label: 'Vendor Costs', href: '/vendors', icon: Wallet },
  ]},
];

export function ModernSidebar() {
  const pathname = usePathname();
  const logout = useAuthStore((s) => s.logout);

  return (
    <aside className="w-64 border-r bg-card/30 backdrop-blur-xl flex flex-col h-full">
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
                const isActive = pathname === item.href || pathname?.startsWith(item.href + '/');
                return (
                  <Link
                    key={`${item.label}-${item.href}`}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium group relative',
                      'transition-colors duration-150 ease-out',
                      isActive
                        ? 'bg-accent text-accent-foreground shadow-sm'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-primary rounded-full" />
                    )}
                    <item.icon
                      className={cn(
                        'w-4 h-4 shrink-0',
                        isActive ? 'text-primary' : 'group-hover:text-foreground',
                      )}
                    />
                    <span className="truncate">{item.label}</span>
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
