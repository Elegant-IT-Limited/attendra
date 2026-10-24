// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { callUsNumber, type ClinicConfig, renderText, type SmsTemplateName, smsSegments, type Texting, TextWording } from '@attendra/core';
import { useState } from 'react';
import { Section } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { phone } from '@/lib/format';

const NAMES: Record<SmsTemplateName, string> = {
  booking_confirmed: 'Booking confirmed', change_confirmed: 'Visit moved', cancel_confirmed: 'Visit cancelled', reminder: 'Reminder before a visit',
  directions: 'Address and directions', hours: 'Opening hours', emergency_hospital: 'Emergency hospital', provider: 'A vet\'s details',
  answer: 'An answer to a common question', link: 'One of your links',
  request_ready: 'Refill ready to pick up', refill_sent: 'Refill sent to the pharmacy', refill_not_approved: 'Refill: please call us',
};

const DURING_CALL = 'During a call, when the caller says yes to a text';

/** When each text goes, so nobody has to guess. */
const WHEN: Record<SmsTemplateName, string> = {
  booking_confirmed: 'Right after the assistant books a visit', change_confirmed: 'Right after a visit is moved', cancel_confirmed: 'Right after a visit is cancelled',
  reminder: 'The day before a visit, to people who said yes to reminders',
  request_ready: 'When your team marks a refill ready to pick up', refill_sent: 'When your team marks a refill sent to a pharmacy', refill_not_approved: 'When your team marks a refill not approved',
  directions: DURING_CALL, hours: DURING_CALL, emergency_hospital: 'In an animal emergency, after the emergency advice', provider: DURING_CALL, answer: DURING_CALL,
  link: 'During a call, when one of your links fits and the caller says yes',
};

/** The texts in the groups a clinic thinks in. */
const GROUPS: { title: string; texts: SmsTemplateName[] }[] = [
  { title: 'Visits', texts: ['booking_confirmed', 'change_confirmed', 'cancel_confirmed', 'reminder'] },
  { title: 'Refills', texts: ['request_ready', 'refill_sent', 'refill_not_approved'] },
  { title: 'Sent during a call', texts: ['directions', 'hours', 'emergency_hospital', 'provider', 'answer', 'link'] },
];

/** Sample details, so each text shows as a client gets it, with the names a call gives. Never anyone's real record. */
function sample(c: ClinicConfig): Record<string, string> {
  const h = c.emergencyHospital;
  const pets = c.industry === 'vet';
  const vet = c.providers.find((p) => p.kind !== 'room');
  return {
    clinic: c.name, clinicPhone: phone(callUsNumber(c)), when: 'Wednesday, October 28 at 10 AM',
    name: pets ? 'Abdul' : 'Maria', ...(pets ? { pet: 'Bella', visit: (c.visitTypes[0]?.name ?? 'check-up').toLowerCase() } : {}),
    address: c.address?.trim() || '214 Main Street', mapUrl: 'https://maps.google.com/?q=clinic', hours: 'Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM',
    hospital: h?.name ?? 'City Pet Emergency', hospitalAddress: h?.address ?? '1200 Larkspur Avenue', hospitalPhone: phone(h?.phone ?? '+13035550188'), emergencyNumber: '911',
    provider: vet?.name ?? 'Dr. Ruiz', details: 'sees dogs and cats', answer: 'We are open until 6 PM today.',
    label: c.texting?.links[0]?.label ?? 'New client form', url: c.texting?.links[0]?.url ?? 'https://example.com/form', pharmacy: 'CVS on Main St',
  };
}

/** A text as a phone shows it. */
function Bubble({ children, testId }: { children: string; testId: string }) {
  return <p className="max-w-xl whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2.5 text-sm leading-relaxed" data-testid={testId}>{children}</p>;
}

/**
 * Every text the clinic sends, shown in full as a client gets it, grouped by when it goes.
 * The clinic can add a few words after its name and one line before "Reply STOP"; the
 * name, the facts and the opt-out are fixed, as the carriers registered them.
 */
export function TextsEditor({ config, texting, onChange, disabled }: { config: ClinicConfig; texting: Texting; onChange: (wording: Texting['wording']) => void; disabled: boolean }) {
  const [open, setOpen] = useState<SmsTemplateName | null>(null);
  const vars = sample(config);
  const languages = config.languages.filter((l): l is 'en' | 'es' => l === 'en' || l === 'es');
  const first = languages[0] ?? 'en';
  const set = (t: SmsTemplateName, lang: 'en' | 'es', patch: Partial<TextWording>) => {
    const cur = texting.wording[t] ?? {};
    const next = { ...(cur[lang] ?? {}), ...patch };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => typeof v === 'string' && v.trim()));
    const entry = { ...cur, [lang]: Object.keys(clean).length ? clean : undefined };
    const all = { ...texting.wording, [t]: entry };
    if (!entry.en && !entry.es) delete all[t];
    onChange(all);
  };
  return (
    <Section id="your-texts" title="Your texts" description={`Every text your clients can get, in full, with sample names. When a call gives them, texts use the caller's name${config.industry === 'vet' ? ', the pet\'s name' : ''}, the ${config.industry === 'vet' ? 'vet' : 'provider'} and the time, and ask people to call ${vars.clinicPhone}. You can add a few words after your clinic's name and one line before "Reply STOP".`}>
      <div className="space-y-6" data-testid="your-texts">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <h3 className="mb-2 text-sm font-semibold">{g.title}</h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {g.texts.map((t) => {
                const custom = !!texting.wording[t];
                const editing = open === t;
                return (
                  <li key={t} className="space-y-3 px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm font-medium">{NAMES[t]}{custom && <Badge tone="accent">Your words</Badge>}</p>
                        <p className="text-xs text-text-muted">{WHEN[t]}</p>
                      </div>
                      <Button type="button" size="sm" variant="outline" aria-expanded={editing} onClick={() => setOpen(editing ? null : t)}>{editing ? 'Done' : 'Add your words'}</Button>
                    </div>
                    {!editing && <Bubble testId={`text-${t}`}>{renderText(t, vars, first, texting.wording[t]?.[first])}</Bubble>}
                    {editing && languages.map((lang) => {
                      const w = texting.wording[t]?.[lang] ?? {};
                      const body = renderText(t, vars, lang, w);
                      const check = TextWording.safeParse(w);
                      const segments = smsSegments(body);
                      return (
                        <div key={lang} className="space-y-2">
                          {languages.length > 1 && <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{lang === 'es' ? 'Spanish' : 'English'}</p>}
                          <Bubble testId={`preview-${t}-${lang}`}>{body}</Bubble>
                          <p className={`text-xs ${segments > 1 ? 'text-warn' : 'text-text-muted'}`}>{body.length} characters: {segments === 1 ? '1 text' : `${segments} texts, each billed`}</p>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">After your name <span className="font-normal text-text-muted">(up to 40 characters)</span></span>
                              <Input maxLength={40} disabled={disabled} value={w.label ?? ''} placeholder={lang === 'es' ? 'p. ej. Encuéntrenos aquí' : 'e.g. Find our clinic here'} onChange={(e) => set(t, lang, { label: e.target.value })} />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">One more line <span className="font-normal text-text-muted">(up to 100 characters)</span></span>
                              <Input maxLength={100} disabled={disabled} value={w.extra ?? ''} placeholder={lang === 'es' ? 'p. ej. Llegue 10 minutos antes' : 'e.g. Please arrive 10 minutes early'} onChange={(e) => set(t, lang, { extra: e.target.value })} />
                            </label>
                          </div>
                          {!check.success && <p className="text-xs text-danger" role="alert">{check.error.issues[0]?.message}</p>}
                        </div>
                      );
                    })}
                    {editing && custom && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { const all = { ...texting.wording }; delete all[t]; onChange(all); }}>Reset to the standard text</Button>}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
