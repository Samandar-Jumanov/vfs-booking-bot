'use client';

import { ChangeEvent, FormEvent, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  Mail,
  Phone,
  UploadCloud,
  User,
} from 'lucide-react';

type Gender = 'MALE' | 'FEMALE' | 'OTHER';

type PassportExtraction = {
  extracted: boolean;
  confidence?: number;
  data?: Partial<FormState>;
};

type FormState = {
  fullName: string;
  passportNumber: string;
  dob: string;
  passportExpiry: string;
  nationality: string;
  gender: Gender;
  email: string;
  phone: string;
  destination: string;
  preferredStartDate: string;
  preferredEndDate: string;
  paymentMethod: string;
};

type OnboardResponse = {
  id: string;
  statusToken: string;
  statusUrl: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

const initialForm: FormState = {
  fullName: '',
  passportNumber: '',
  dob: '',
  passportExpiry: '',
  nationality: '',
  gender: 'MALE',
  email: '',
  phone: '',
  destination: '',
  preferredStartDate: '',
  preferredEndDate: '',
  paymentMethod: 'Operator follow-up',
};

function fieldClass(hasIcon = false) {
  return `h-12 w-full rounded-md border border-slate-300 bg-white px-3 text-base text-slate-950 outline-none transition focus:border-slate-950 focus:ring-2 focus:ring-slate-200 ${
    hasIcon ? 'pl-10' : ''
  }`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function OnboardPage() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<OnboardResponse | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return (
      form.fullName &&
      form.passportNumber &&
      form.dob &&
      form.passportExpiry &&
      form.nationality &&
      form.email &&
      form.phone &&
      form.destination &&
      form.preferredStartDate &&
      form.preferredEndDate
    );
  }, [form]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handlePassportUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setMessage(null);
    setUploadName(file.name);

    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`${API_BASE}/api/profiles/extract-passport`, {
        method: 'POST',
        body,
      });

      if (!response.ok) throw new Error('Passport scan failed. Enter the details manually or try another photo.');
      const result = (await response.json()) as PassportExtraction;
      if (!result.extracted || !result.data) {
        setMessage('We could not read the passport automatically. You can still complete the form manually.');
        return;
      }

      setForm((current) => ({
        ...current,
        fullName: result.data?.fullName ?? current.fullName,
        passportNumber: result.data?.passportNumber ?? current.passportNumber,
        dob: result.data?.dob ?? current.dob,
        passportExpiry: result.data?.passportExpiry ?? current.passportExpiry,
        nationality: result.data?.nationality ?? current.nationality,
        gender: result.data?.gender ?? current.gender,
      }));
      setMessage(`Passport details filled${result.confidence ? ` with ${result.confidence}% OCR confidence` : ''}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passport scan failed.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`${API_BASE}/api/profiles/onboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? 'Could not submit onboarding request.');
      }

      setCreated((await response.json()) as OnboardResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit onboarding request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 sm:px-6">
        <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-2xl items-center">
          <div className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h1 className="mt-6 text-2xl font-semibold tracking-normal sm:text-3xl">Request received</h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              Your profile was created with pending payment status. An operator will review the details and contact you.
            </p>
            <div className="mt-6 rounded-md border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-600">Status link</p>
              <a className="mt-2 block break-all text-base font-semibold text-slate-950 underline" href={created.statusUrl}>
                {created.statusUrl}
              </a>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <section className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[0.8fr_1.2fr] lg:py-10">
        <div className="lg:pt-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-slate-500">VFS appointment service</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-normal sm:text-4xl">Customer onboarding</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-slate-600">
            Upload your passport, confirm your contact details, and choose your destination. Payment is confirmed by an
            operator before booking starts.
          </p>
          <div className="mt-6 grid gap-3 text-sm text-slate-600">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-slate-900" />
              Passport OCR fills the key fields when possible.
            </div>
            <div className="flex items-center gap-3">
              <CalendarDays className="h-5 w-5 text-slate-900" />
              Date range helps the operator prioritize your request.
            </div>
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-slate-900" />
              Payment remains pending until the operator confirms it.
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center transition hover:border-slate-950">
            {uploading ? <Loader2 className="h-8 w-8 animate-spin text-slate-700" /> : <UploadCloud className="h-8 w-8 text-slate-700" />}
            <span className="mt-3 text-base font-semibold">Upload passport photo</span>
            <span className="mt-1 text-sm text-slate-500">{uploadName ?? 'JPEG or PNG, clear MRZ lines preferred'}</span>
            <input className="sr-only" type="file" accept="image/jpeg,image/png" onChange={handlePassportUpload} />
          </label>

          {message ? (
            <div className="mt-4 flex gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </div>
          ) : null}
          {error ? (
            <div className="mt-4 flex gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Input label="Full name" icon={User} value={form.fullName} onChange={(value) => update('fullName', value)} required />
            <Input label="Passport number" value={form.passportNumber} onChange={(value) => update('passportNumber', value.toUpperCase())} required />
            <Input label="Date of birth" type="date" value={form.dob} onChange={(value) => update('dob', value)} required />
            <Input label="Passport expiry" type="date" value={form.passportExpiry} onChange={(value) => update('passportExpiry', value)} required />
            <Input label="Nationality" value={form.nationality} onChange={(value) => update('nationality', value.toUpperCase())} required />
            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">Gender</span>
              <select className={fieldClass()} value={form.gender} onChange={(event) => update('gender', event.target.value as Gender)}>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
            <Input label="Email" icon={Mail} type="email" value={form.email} onChange={(value) => update('email', value)} required />
            <Input label="Phone" icon={Phone} type="tel" value={form.phone} onChange={(value) => update('phone', value)} required />
            <Input label="Destination" value={form.destination} onChange={(value) => update('destination', value)} placeholder="Portugal, Brazil, etc." required />
            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">Payment method</span>
              <select className={fieldClass()} value={form.paymentMethod} onChange={(event) => update('paymentMethod', event.target.value)}>
                <option value="Operator follow-up">Operator follow-up</option>
                <option value="Bank transfer">Bank transfer</option>
                <option value="Cash">Cash</option>
              </select>
            </label>
            <Input
              label="Preferred start"
              type="date"
              min={todayIso()}
              value={form.preferredStartDate}
              onChange={(value) => update('preferredStartDate', value)}
              required
            />
            <Input
              label="Preferred end"
              type="date"
              min={form.preferredStartDate || todayIso()}
              value={form.preferredEndDate}
              onChange={(value) => update('preferredEndDate', value)}
              required
            />
          </div>

          <button type="submit" className="mt-6 h-12 w-full rounded-md bg-slate-950 px-4 text-base font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 className="mx-auto h-5 w-5 animate-spin" /> : 'Submit onboarding request'}
          </button>
        </form>
      </section>
    </main>
  );
}

function Input(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
  icon?: typeof User;
}) {
  const Icon = props.icon;
  return (
    <label className="grid gap-2">
      <span className="text-sm font-medium text-slate-700">{props.label}</span>
      <span className="relative">
        {Icon ? <Icon className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" /> : null}
        <input
          className={fieldClass(Boolean(Icon))}
          type={props.type ?? 'text'}
          value={props.value}
          min={props.min}
          placeholder={props.placeholder}
          required={props.required}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </span>
    </label>
  );
}
