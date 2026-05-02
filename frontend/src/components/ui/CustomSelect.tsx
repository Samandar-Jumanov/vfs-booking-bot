'use client';
import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
  placeholder?: string;
}

export function CustomSelect({ options, value, onChange, label, className, placeholder }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(o => o.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
        <span className={cn("text-sm font-medium truncate pr-2", !selectedOption && "text-muted-foreground")}>
          {selectedOption ? selectedOption.label : placeholder || "Select..."}
        </span>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform duration-300", isOpen && "rotate-180")} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute z-[100] w-full mt-2 bg-card border border-border shadow-2xl rounded-2xl overflow-hidden backdrop-blur-xl"
          >
            <div className="max-h-60 overflow-y-auto p-1.5 custom-scrollbar">
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all",
                    option.value === value 
                      ? "bg-primary text-primary-foreground font-bold shadow-md shadow-primary/20" 
                      : "hover:bg-accent hover:text-foreground text-muted-foreground"
                  )}
                >
                  <span>{option.label}</span>
                  {option.value === value && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                </button>
              ))}
              {options.length === 0 && (
                <div className="p-4 text-center text-xs text-muted-foreground">No options available</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
