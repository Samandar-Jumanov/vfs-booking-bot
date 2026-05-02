'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import { api } from '@/lib/api';
import { 
  Plus, 
  Upload, 
  Trash2, 
  Edit2, 
  User, 
  ShieldCheck, 
  Search, 
  X,
  FileText,
  AlertCircle,
  MoreVertical
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomSelect } from '@/components/ui/CustomSelect';
import { CustomDatePicker } from '@/components/ui/CustomDatePicker';
import { DashboardShell } from '@/components/layout/DashboardShell';
import { motion, AnimatePresence } from 'framer-motion';

interface Profile {
  id: string;
  fullName: string;
  passportNumberMasked: string;
  dob: string;
  passportExpiry: string;
  passportIssueDate?: string;
  nationality: string;
  email: string;
  phone: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  priority: 'HIGH' | 'NORMAL';
  isActive: boolean;
  visaType?: string;
}

export default function ProfilesPage() {
  const qc = useQueryClient();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [importResults, setImportResults] = useState<{ succeeded: number; failed: number; results: { row: number; success: boolean; error?: string }[] } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get('/profiles').then((r) => r.data),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/profiles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
  });

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'text/csv': ['.csv'] },
    maxFiles: 1,
    onDrop: async (files) => {
      if (!files[0]) return;
      const fd = new FormData();
      fd.append('file', files[0]);
      try {
        const res = await api.post('/profiles/bulk-upload', fd);
        setImportResults(res.data);
        qc.invalidateQueries({ queryKey: ['profiles'] });
      } catch (err) {
        console.error('Upload failed', err);
      }
    },
  });

  const profiles: Profile[] = data?.items || [];
  const filteredProfiles = profiles.filter(p => 
    p.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.passportNumberMasked.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <DashboardShell 
      title="Applicants" 
      description="Manage profiles and personal records for automated booking."
    >
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        
        {/* Actions Bar */}
        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input 
              type="text"
              placeholder="Filter by name or passport..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-accent/30 border-none h-11 rounded-xl pl-10 text-sm focus:ring-1 focus:ring-primary transition-all shadow-inner"
            />
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <button 
              onClick={() => { setEditing(null); setShowModal(true); }}
              className="flex-1 md:flex-none btn-primary gap-2 h-11 px-6 shadow-lg shadow-primary/20"
            >
              <Plus className="w-4 h-4" /> New Applicant
            </button>
          </div>
        </div>

        {/* Global Import Zone */}
        {!importResults && (
          <div
            {...getRootProps()}
            className={cn(
              "group border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all duration-300",
              isDragActive 
                ? "border-primary bg-primary/5 scale-[0.99]" 
                : "border-muted hover:border-primary/50 hover:bg-accent/30"
            )}
          >
            <input {...getInputProps()} />
            <div className="mx-auto w-12 h-12 rounded-xl bg-accent flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-primary/20 group-hover:text-primary transition-all">
              <Upload className="w-6 h-6 text-muted-foreground transition-colors" />
            </div>
            <h4 className="text-sm font-semibold mb-1">Bulk Import Profiles</h4>
            <p className="text-xs text-muted-foreground max-w-xs mx-auto">
              Drag & drop Excel or CSV files to import multiple applicants at once.
            </p>
          </div>
        )}

        {/* Import Feedback */}
        {importResults && (
           <motion.div 
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="card p-4 border-primary/20 bg-primary/5 flex items-center justify-between"
          >
            <div className="flex items-center gap-4">
              <div className="p-2 bg-primary/20 rounded-lg text-primary">
                <FileText className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-bold">Import Summary</p>
                <p className="text-xs text-muted-foreground">
                  <span className="text-green-500 font-bold">{importResults.succeeded} Success</span> • 
                  <span className="text-destructive font-bold ml-1">{importResults.failed} Failed</span>
                </p>
              </div>
            </div>
            <button onClick={() => setImportResults(null)} className="p-2 hover:bg-accent rounded-lg">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}

        {/* Profile Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          <AnimatePresence mode="popLayout">
            {filteredProfiles.map((p) => (
              <motion.div 
                layout
                key={p.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="card group relative flex flex-col p-6 bg-card/40 hover:bg-card hover:border-primary/30 hover:shadow-2xl hover:shadow-primary/5 transition-all duration-300 overflow-hidden"
              >
                {/* Visual Accent */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 -mr-16 -mt-16 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity" />
                
                <div className="flex items-start justify-between relative z-10 mb-6 font-mono">
                  <div className="h-12 w-12 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center group-hover:bg-primary group-hover:text-primary-foreground transition-all duration-300 shadow-sm">
                    <User className="w-6 h-6" />
                  </div>
                  <div className="flex flex-col items-end gap-1.5 pt-1">
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-widest",
                      p.priority === 'HIGH' ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" : "bg-accent text-muted-foreground"
                    )}>
                      {p.priority} Priority
                    </span>
                    <div className="flex gap-0.5">
                       {[...Array(p.priority === 'HIGH' ? 3 : 1)].map((_, i) => (
                         <div key={i} className="w-1 h-3 bg-primary rounded-full" />
                       ))}
                    </div>
                  </div>
                </div>

                <div className="flex-1 space-y-5 relative z-10">
                  <div>
                    <h3 className="text-lg font-bold tracking-tight text-foreground group-hover:text-primary transition-colors">{p.fullName}</h3>
                    <div className="flex items-center gap-2 mt-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-xs font-mono text-muted-foreground tracking-tight">{p.passportNumberMasked}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 pt-4 border-t border-dashed">
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase font-black text-muted-foreground tracking-wider">Nationality</p>
                      <p className="text-[11px] font-bold truncate">{p.nationality}</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] uppercase font-black text-muted-foreground tracking-wider">Visa Category</p>
                      <p className="text-[11px] font-bold truncate">{p.visaType || 'Standard'}</p>
                    </div>
                  </div>

                  {/* Actions Overlay */}
                  <div className="flex gap-2 pt-2 translate-y-2 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
                    <button 
                      onClick={() => { setEditing(p); setShowModal(true); }}
                      className="flex-1 h-9 rounded-lg bg-accent hover:bg-primary hover:text-primary-foreground text-xs font-bold transition-all flex items-center justify-center gap-2"
                    >
                      <Edit2 className="w-3 h-3" /> Edit Profile
                    </button>
                    <button 
                      onClick={() => { if (confirm('Delete applicant?')) deleteMutation.mutate(p.id); }}
                      className="w-9 h-9 flex items-center justify-center rounded-lg border border-destructive/20 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Empty State */}
          {!isLoading && filteredProfiles.length === 0 && (
            <div className="col-span-full py-20 flex flex-col items-center justify-center text-center opacity-40 grayscale">
              <div className="w-20 h-20 bg-accent rounded-3xl flex items-center justify-center mb-6">
                <User className="w-10 h-10" />
              </div>
              <h3 className="text-lg font-bold">No Applicants Found</h3>
              <p className="text-sm">Start by adding a new profile or importing a list.</p>
            </div>
          )}
        </div>
      </div>

      {showModal && <ProfileModal profile={editing} onClose={() => setShowModal(false)} />}
    </DashboardShell>
  );
}

function ProfileModal({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const qc = useQueryClient();
  interface FormState {
    fullName: string;
    passportNumber: string;
    dob: string;
    passportExpiry: string;
    passportIssueDate: string;
    nationality: string;
    email: string;
    phone: string;
    gender: 'MALE' | 'FEMALE' | 'OTHER';
    priority: 'NORMAL' | 'HIGH';
    vfsPassword: string;
  }

  const [form, setForm] = useState<FormState>({
    fullName: profile?.fullName ?? '',
    passportNumber: '',
    dob: profile?.dob ?? '',
    passportExpiry: profile?.passportExpiry ?? '',
    passportIssueDate: profile?.passportIssueDate ?? '',
    nationality: profile?.nationality ?? '',
    email: profile?.email ?? '',
    phone: profile?.phone ?? '',
    gender: profile?.gender ?? 'MALE',
    priority: profile?.priority ?? 'NORMAL',
    vfsPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Create a clean payload with sanitized dates
      const payload: any = {
        ...form,
        passportExpiry: form.passportExpiry || undefined,
        passportIssueDate: form.passportIssueDate || undefined,
      };

      // Remove falsy optional fields to avoid Zod validation errors on empty strings
      if (!payload.passportIssueDate) delete payload.passportIssueDate;
      if (!payload.passportExpiry) delete payload.passportExpiry;
      
      // On update, only send passportNumber/vfsPassword if they were changed (not empty)
      if (profile) {
        if (!form.passportNumber) delete payload.passportNumber;
        if (!form.vfsPassword) delete payload.vfsPassword;
        await api.put(`/profiles/${profile.id}`, payload);
      } else {
        await api.post('/profiles', payload);
      }
      qc.invalidateQueries({ queryKey: ['profiles'] });
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Submission failed');
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: any) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm shadow-2xl" 
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-2xl bg-card/60 backdrop-blur-2xl border border-primary/20 shadow-[0_32px_64px_-16px_rgba(0,0,0,0.5)] rounded-[2rem] p-8 overflow-hidden flex flex-col max-h-[92vh]"
      >
        {/* Glow Effects */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 -mr-32 -mt-32 rounded-full blur-[100px]" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-500/5 -ml-24 -mb-24 rounded-full blur-[80px]" />
        
        <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-primary/20 via-primary to-primary/20" />
        
        <div className="flex items-center justify-between mb-8 relative z-10">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
              <User className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-2xl font-black tracking-tighter text-foreground">{profile ? 'Modify Dossier' : 'New Identity'}</h2>
              <p className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-[0.2em]">Acquisition Unit Profile v2.1</p>
            </div>
          </div>
          <button onClick={onClose} className="w-10 h-10 flex items-center justify-center hover:bg-accent rounded-xl transition-all border border-transparent hover:border-border">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-8 scrollbar-thin scrollbar-thumb-primary/10 hover:scrollbar-thumb-primary/20 relative z-10">
          <form id="profile-form" onSubmit={handleSubmit} className="space-y-6">
            {/* Identity Core */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <span className="h-px bg-primary/20 flex-1" />
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/40 px-4">Identity Core</span>
                <span className="h-px bg-primary/20 flex-1" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2 space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">Full Legal Name</label>
                  <input className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-sm font-bold transition-all shadow-inner px-5 rounded-xl" required {...field('fullName')} placeholder="Jules Verne" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">Passport Identifier</label>
                  <input className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-xs font-mono tracking-widest transition-all shadow-inner px-5 rounded-xl" required={!profile} {...field('passportNumber')} placeholder={profile ? '••••••••' : 'A1234567'} />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">Nationality</label>
                  <input className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-xs font-bold transition-all shadow-inner px-5 rounded-xl" required {...field('nationality')} placeholder="e.g. United Kingdom" />
                </div>
                <CustomDatePicker label="Date of Birth" value={form.dob} onChange={(val) => setForm(f => ({ ...f, dob: val }))} withTime={false} />
                <CustomSelect 
                  label="Biological Gender" 
                  value={form.gender} 
                  onChange={(val) => setForm(f => ({ ...f, gender: val as any }))}
                  options={[{ value: 'MALE', label: 'Male' }, { value: 'FEMALE', label: 'Female' }, { value: 'OTHER', label: 'Other' }]}
                />
              </div>
            </div>

            {/* Lifecycle Timeline */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <span className="h-px bg-primary/20 flex-1" />
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/40 px-4">Lifecycle Timeline</span>
                <span className="h-px bg-primary/20 flex-1" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <CustomDatePicker label="Passport Issue Date" value={form.passportIssueDate} onChange={(val) => setForm(f => ({ ...f, passportIssueDate: val }))} withTime={false} />
                <CustomDatePicker label="Passport Expiry" value={form.passportExpiry} onChange={(val) => setForm(f => ({ ...f, passportExpiry: val }))} withTime={false} />
              </div>
            </div>

            {/* Contact Intelligence */}
            <div>
              <div className="flex items-center gap-2 mb-4">
                <span className="h-px bg-primary/20 flex-1" />
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary/40 px-4">Contact Intelligence</span>
                <span className="h-px bg-primary/20 flex-1" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">Email Address</label>
                  <input type="email" className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-xs font-bold transition-all shadow-inner px-5 rounded-xl" required {...field('email')} placeholder="email@example.com" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">Phone Number</label>
                  <input type="tel" className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-xs font-bold transition-all shadow-inner px-5 rounded-xl" required {...field('phone')} placeholder="+..." />
                </div>
                <div className="md:col-span-2 space-y-2">
                  <label className="text-[10px] uppercase font-black tracking-[0.2em] text-muted-foreground ml-1">VFS Portal Password</label>
                  <input type="password" className="input h-12 bg-background/50 border-border/50 focus:border-primary/50 text-xs font-bold transition-all shadow-inner px-5 rounded-xl" required={!profile} {...field('vfsPassword')} placeholder={profile ? '••••••••' : 'Enter portal password'} />
                </div>
              </div>
            </div>

            <div className="pt-2">
              <CustomSelect
                label="Acquisition Priority"
                value={form.priority}
                onChange={(val) => setForm(f => ({ ...f, priority: val as any }))}
                options={[
                  { value: 'NORMAL', label: 'Balanced Mode (Standard)' },
                  { value: 'HIGH', label: 'Turbo Acquisition (High Priority)' },
                ]}
              />
            </div>
          </form>
        </div>

        {/* Action Footer */}
        <div className="p-8 border-t border-border bg-card/50 backdrop-blur-md flex gap-4 z-20">
          <button 
            type="button" 
            className="flex-1 h-12 rounded-xl text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:bg-accent hover:text-foreground transition-all border border-border/50" 
            onClick={onClose}
          >
            Discard
          </button>
          <button 
            type="submit"
            form="profile-form"
            className="flex-[2] btn-primary h-12 rounded-xl shadow-[0_10px_30px_-5px_rgba(var(--primary-rgb),0.3)] text-[10px] font-black tracking-[0.2em] uppercase transition-all hover:scale-[1.02] active:scale-[0.98]" 
            disabled={saving}
          >
            {saving ? (
              <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent animate-spin rounded-full mx-auto" />
            ) : profile ? 'Confirm Changes' : 'Initialize Identity'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

