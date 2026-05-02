'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, addMonths, subMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, isSameMonth, isSameDay, addDays } from 'date-fns';

interface CustomDatePickerProps {
  value: string; // ISO or datetime-local format
  onChange: (value: string) => void;
  label?: string;
  className?: string;
  withTime?: boolean;
}

export function CustomDatePicker({ value, onChange, label, className, withTime = true }: CustomDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse initial value safely
  const parseDate = (val: string) => {
    if (!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  };

  const selectedDate = parseDate(value);
  const [currentMonth, setCurrentMonth] = useState(selectedDate || new Date());

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const renderHeader = () => {
    const years = Array.from({ length: 121 }, (_, i) => new Date().getFullYear() + 20 - i);
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 bg-accent/5">
        <div className="flex items-center gap-1.5 min-w-0">
          <select
            value={currentMonth.getMonth()}
            onChange={(e) => {
              const newDate = new Date(currentMonth);
              newDate.setMonth(parseInt(e.target.value));
              setCurrentMonth(newDate);
            }}
            className="bg-transparent text-[10px] font-black uppercase tracking-widest outline-none cursor-pointer hover:text-primary transition-colors pr-1 max-w-[100px] truncate"
          >
            {months.map((m, i) => (
              <option key={m} value={i} className="bg-card text-foreground py-2">{m}</option>
            ))}
          </select>
          <select
            value={currentMonth.getFullYear()}
            onChange={(e) => {
              const newDate = new Date(currentMonth);
              newDate.setFullYear(parseInt(e.target.value));
              setCurrentMonth(newDate);
            }}
            className="bg-transparent text-[10px] font-black uppercase tracking-widest outline-none cursor-pointer hover:text-primary transition-colors pr-1"
          >
            {years.map(y => (
              <option key={y} value={y} className="bg-card text-foreground py-2">{y}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  };

  const renderDays = () => {
    const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    return (
      <div className="grid grid-cols-7 mb-2 px-2">
        {days.map((day) => (
          <div key={day} className="text-[10px] font-black text-muted-foreground/50 text-center uppercase py-2">
            {day}
          </div>
        ))}
      </div>
    );
  };

  const renderCells = () => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(monthStart);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const rows = [];
    let days = [];
    let day = startDate;

    while (day <= endDate) {
      for (let i = 0; i < 7; i++) {
        const formattedDate = format(day, 'd');
        const cloneDay = day;
        days.push(
          <button
            key={day.toString()}
            type="button"
            onClick={() => {
                let finalDate = new Date(cloneDay);
                if (selectedDate && withTime) {
                   finalDate.setHours(selectedDate.getHours());
                   finalDate.setMinutes(selectedDate.getMinutes());
                }
                
                if (withTime) {
                  onChange(finalDate.toISOString());
                } else {
                  // Return YYYY-MM-DD for date-only fields
                  onChange(format(finalDate, 'yyyy-MM-dd'));
                }

                if (!withTime) setIsOpen(false);
            }}
            className={cn(
              "h-9 w-9 flex items-center justify-center rounded-lg text-xs transition-all relative group",
              !isSameMonth(day, monthStart) ? "text-muted-foreground/20" : "text-foreground",
              selectedDate && isSameDay(day, selectedDate) 
                ? "bg-primary text-primary-foreground font-black shadow-lg shadow-primary/20" 
                : "hover:bg-primary/10 hover:text-primary"
            )}
          >
            <span>{formattedDate}</span>
            {isSameDay(day, new Date()) && !isSameDay(day, selectedDate || new Date(0)) && (
              <div className="absolute bottom-1 w-1 h-1 bg-primary rounded-full" />
            )}
          </button>
        );
        day = addDays(day, 1);
      }
      rows.push(
        <div className="grid grid-cols-7 gap-1 px-2 mb-1" key={day.toString()}>
          {days}
        </div>
      );
      days = [];
    }
    return <div className="pb-2">{rows}</div>;
  };

  return (
    <div className={cn("space-y-2 relative", className)} ref={containerRef}>
      {label && (
        <label className="text-[10px] uppercase font-black tracking-widest text-muted-foreground pl-1 flex items-center gap-2">
          {label}
        </label>
      )}
      
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "w-full h-11 px-4 rounded-xl border flex items-center justify-between transition-all duration-200 outline-none",
          "bg-accent/20 border-accent/20 hover:border-accent/40",
          isOpen ? "ring-2 ring-primary/20 border-primary bg-background shadow-lg" : "shadow-sm"
        )}
      >
        <div className="flex items-center gap-2">
           <CalendarIcon className="w-4 h-4 text-primary/60" />
           <span className="text-sm font-medium">
             {selectedDate ? format(selectedDate, withTime ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy') : "Select date..."}
           </span>
        </div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="absolute z-[100] mt-2 bg-card border border-border shadow-2xl rounded-2xl overflow-hidden backdrop-blur-xl w-[320px]"
          >
            {renderHeader()}
            <div className="p-2">
              {renderDays()}
              {renderCells()}
            </div>
            
            {withTime && selectedDate && (
              <div className="p-4 border-t border-border/50 bg-accent/5 flex items-center justify-between gap-4">
                 <div className="flex items-center gap-2 flex-1">
                    <input 
                      type="time" 
                      value={format(selectedDate, 'HH:mm')}
                      onChange={(e) => {
                        const [hours, minutes] = e.target.value.split(':');
                        const newDate = new Date(selectedDate);
                        newDate.setHours(parseInt(hours), parseInt(minutes));
                        onChange(newDate.toISOString());
                      }}
                      className="flex-1 bg-background border border-border rounded-lg px-2 py-1.5 text-xs font-mono outline-none focus:ring-1 focus:ring-primary"
                    />
                 </div>
                 <button 
                  onClick={() => setIsOpen(false)}
                  className="btn-primary h-8 px-4 text-[10px] rounded-lg"
                 >
                   Apply
                 </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
