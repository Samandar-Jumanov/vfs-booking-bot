'use client';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  icon: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  className?: string;
}

export function MetricCard({ label, value, subValue, icon: Icon, trend, className }: MetricCardProps) {
  return (
    <div className={cn("card p-6 flex items-start justify-between relative overflow-hidden group hover:border-primary/50 transition-colors", className)}>
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <div className="flex items-baseline gap-2">
          <h4 className="text-3xl font-bold tracking-tight">{value}</h4>
          {trend && (
            <span className={cn(
              "text-xs font-medium px-1.5 py-0.5 rounded-full",
              trend.isPositive ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
            )}>
              {trend.isPositive ? '+' : '-'}{trend.value}%
            </span>
          )}
        </div>
        {subValue && <p className="text-xs text-muted-foreground font-mono">{subValue}</p>}
      </div>
      
      <div className="p-3 bg-accent/50 rounded-xl group-hover:bg-primary/10 group-hover:text-primary transition-all duration-300">
        <Icon className="w-5 h-5 text-muted-foreground" />
      </div>

      <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-primary/5 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
