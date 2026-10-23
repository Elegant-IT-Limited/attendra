// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, renderText, SMS_TEMPLATE_NAMES, type SmsTemplateName, smsSegments, type Texting, TextWording } from '@attendra/core';
import { useState } from 'react';
import { Section } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { phone } from '@/lib/format';

const NAMES: Record<SmsTemplateName, string> = {
  booking_confirmed: 'Booking confirmed', change_confirmed: 'Visit moved', cancel_confirmed: 'Visit cancelled', reminder: 'Reminder before a visit',
  directions: 'Address and directions', hours: 'Opening hours', emergency_hospital: 'Emergency hospital', provider: 'A vet\'s details',
  answer: 'An answer to a common question', link: 'One of your links',
  request_ready: 'Refill ready to pick up', refill_sent: 'Refill sent to the pharmacy', refill_not_approved: 'Refill: please call us',
};

/** Sample details, so each text shows as a client would get it. Never anyone's real record. */
function sample(c: ClinicConfig): Record<string, string> {
  const h = c.emergencyHospital;
  return {
    clinic: c.name, clinicPhone: phone(c.phoneNumbers[0] ?? '+13035550100'), when: 'Tue 28 Oct at 10:00', pet: 'Bella',
    address: c.address?.trim() || '214 Main Street', mapUrl: 'https://maps.google.com/?q=clinic', hours: 'Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM',
    hospital: h?.name ?? 'City Pet Emergency', hospitalAddress: h?.address ?? '1200 Larkspur Avenue', hospitalPhone: phone(h?.phone ?? '+13035550188'), emergencyNumber: '911',
    provider: c.providers[0]?.name ?? 'Dr. Ruiz', details: 'sees dogs and cats', answer: 'We are open until 6 PM today.',
    label: c.texting?.links[0]?.label ?? 'New client form', url: c.texting?.links[0]?.url ?? 'https://example.com/form', pharmacy: 'CVS on Main St',
  };
}

/**
 * Each text the clinic sends, shown as a client gets it, with the clinic's own few words:
 * a short lead after its name and one line before "Reply STOP". The name, the facts and
 * the opt-out are fixed, as the carriers registered them.
 */
export function TextsEditor({ config, texting, onChange, disabled }: { config: ClinicConfig; texting: Texting; onChange: (wording: Texting['wording']) => void; disabled: boolean }) {
  const [open, setOpen] = useState<SmsTemplateName | null>(null);
  const vars = sample(config);
  const languages = config.languages.filter((l): l is 'en' | 'es' => l === 'en' || l === 'es');
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
    <Section id="your-texts" title="Your texts" description="Each text as a client gets it, with sample details. You can add a few words after your clinic's name and one line before the opt-out; your name, the details and &quot;Reply STOP&quot; stay as they are, because the carriers approve them that way.">
      <ul className="divide-y divide-border rounded-md border border-border" data-testid="your-texts">
        {SMS_TEMPLATE_NAMES.map((t) => {
          const custom = !!texting.wording[t];
          return (
            <li key={t} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <button type="button" className="focus-ring text-left text-sm font-medium" aria-expanded={open === t} onClick={() => setOpen(open === t ? null : t)}>{NAMES[t]}</button>
                <span className="text-xs text-text-muted">{custom ? 'Your words' : 'Standard'}</span>
              </div>
              {open === t && (
                <div className="mt-3 space-y-4">
                  {languages.map((lang) => {
                    const w = texting.wording[t]?.[lang] ?? {};
                    const body = renderText(t, vars, lang, w);
                    const check = TextWording.safeParse(w);
                    const segments = smsSegments(body);
                    return (
                      <div key={lang} className="space-y-2">
                        {languages.length > 1 && <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{lang === 'es' ? 'Spanish' : 'English'}</p>}
                        <p className="rounded-lg border border-border bg-surface-sunken/60 p-3 text-sm" data-testid={`preview-${t}-${lang}`}>{body}</p>
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
                  {custom && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => { const all = { ...texting.wording }; delete all[t]; onChange(all); }}>Reset to the standard text</Button>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
