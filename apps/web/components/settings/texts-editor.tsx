// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { callUsNumber, type ClinicConfig, renderText, type SmsTemplateName, smsSegments, type Texting, TextWording } from '@attendra/core';
import { Fragment, useState } from 'react';
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

// a part of the text filled in when it is sent: ⟦key⟧ in the rendered template, a labelled tag on screen
const slot = (key: string) => `⟦${key}⟧`;
const SLOTS = /⟦(\w+)⟧/g;

/** What each filled-in part is called, for the clinic's kind of patient. */
function slotNames(pets: boolean): Record<string, string> {
  return {
    name: pets ? 'Owner\'s first name' : 'Patient\'s first name', pet: 'Pet\'s name', provider: pets ? 'Vet\'s name' : 'Doctor\'s name',
    visit: 'Visit type', when: 'Day and time', pharmacy: 'Pharmacy', details: pets ? 'What the vet sees' : 'What the doctor sees',
    answer: 'The answer to their question', hours: 'Opening hours, from your Settings', mapUrl: 'Map link', label: 'Link name', url: 'Link',
    hospital: 'Emergency hospital', hospitalAddress: 'Hospital address', hospitalPhone: 'Hospital phone', address: 'Your address',
    yourLead: 'Your words', yourLine: 'Your line',
  };
}

/**
 * The text as a template: the clinic's own name and number as they are, and every part the
 * call or the team fills in as a tag. The clinic's own words show where they go.
 */
function templateVars(c: ClinicConfig): Record<string, string> {
  const h = c.emergencyHospital;
  const pets = c.industry === 'vet';
  return {
    clinic: c.name, clinicPhone: callUsNumber(c), emergencyNumber: '911',
    name: slot('name'), ...(pets ? { pet: slot('pet'), visit: slot('visit') } : {}), provider: slot('provider'), when: slot('when'),
    pharmacy: slot('pharmacy'), details: slot('details'), answer: slot('answer'), hours: slot('hours'), mapUrl: slot('mapUrl'),
    label: slot('label'), url: slot('url'), address: c.address?.trim() || slot('address'),
    hospital: h?.name ?? slot('hospital'), hospitalAddress: h?.address ?? slot('hospitalAddress'), hospitalPhone: h?.phone ?? slot('hospitalPhone'),
  };
}

/** An example of a sent text: plainly made-up names, never anyone's record. */
function exampleVars(c: ClinicConfig): Record<string, string> {
  const pets = c.industry === 'vet';
  const vet = c.providers.find((p) => p.kind !== 'room');
  return {
    ...templateVars(c), clinicPhone: callUsNumber(c),
    name: pets ? 'Alex' : 'Sam', ...(pets ? { pet: 'Max', visit: (c.visitTypes[0]?.name ?? 'check-up').toLowerCase() } : {}),
    provider: vet?.name ?? 'Dr. Lee', when: 'Wednesday, October 28 at 10:00 AM', pharmacy: 'CVS on Main St', details: 'sees dogs and cats',
    answer: 'We are open until 6 PM today.', hours: 'Mon-Fri 8 AM-6 PM, Sat 9 AM-1 PM', mapUrl: 'https://maps.google.com/?q=clinic',
    label: c.texting?.links[0]?.label ?? 'New client form', url: c.texting?.links[0]?.url ?? 'https://example.com/form',
    address: c.address?.trim() || '214 Main Street',
    hospital: c.emergencyHospital?.name ?? 'City Pet Emergency', hospitalAddress: c.emergencyHospital?.address ?? '1200 Larkspur Avenue', hospitalPhone: c.emergencyHospital?.phone ?? '+13035550188',
  };
}

/** A template on screen: the fixed text, each filled-in part as a tag, the clinic's own words outlined. */
function Template({ body, names, testId, words = {} }: { body: string; names: Record<string, string>; testId: string; words?: Record<string, string | undefined> }) {
  const parts = body.split(SLOTS);
  return (
    <p className="max-w-xl whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-border bg-surface px-3.5 py-2.5 text-sm leading-7" data-testid={testId}>
      {parts.map((p, i) => (i % 2 === 0 ? <Fragment key={i}>{p}</Fragment>
        : p === 'yourLead' || p === 'yourLine'
          // the clinic's own words where they go, as typed; an empty place shows what goes there
          ? words[p]
            ? <span key={i} className="rounded-md bg-warning-soft px-1 py-0.5 font-medium">{words[p]}</span>
            : <span key={i} className="rounded-md border border-dashed border-warning bg-warning-soft px-1.5 py-0.5 text-xs font-medium">{names[p]}</span>
          : <span key={i} className="rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary">{`{${names[p] ?? p}}`}</span>))}
    </p>
  );
}

/** A text as a phone shows it. */
function Bubble({ children, testId }: { children: string; testId: string }) {
  return <p className="max-w-xl whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2.5 text-sm leading-relaxed" data-testid={testId}>{children}</p>;
}

/**
 * Every text the clinic sends, as a template: what is fixed, what each call fills in, and
 * where the clinic's own few words go, with an example of how it arrives. The clinic can
 * add a few words after its name and one line before "Reply STOP"; the rest is fixed, as
 * the carriers registered it.
 */
export function TextsEditor({ config, texting, onChange, disabled }: { config: ClinicConfig; texting: Texting; onChange: (wording: Texting['wording']) => void; disabled: boolean }) {
  const [open, setOpen] = useState<SmsTemplateName | null>(null);
  const pets = config.industry === 'vet';
  const names = slotNames(pets);
  const tmpl = templateVars(config);
  const example = exampleVars(config);
  const languages = config.languages.filter((l): l is 'en' | 'es' => l === 'en' || l === 'es');
  const first = languages[0] ?? 'en';
  // the clinic's own words, marked where they go (shown highlighted); none set, nothing marked
  const slotted = (w: TextWording | undefined) => ({
    ...(w?.label ? { label: slot('yourLead') } : {}),
    ...(w?.extra ? { extra: slot('yourLine') } : {}),
  });
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
    <Section id="your-texts" title="Your texts" description={`Every text your clients can get. Your clinic's name and ${phone(callUsNumber(config))} are as they are sent; each part in a tag is filled in from the call when it goes out. You can add a few words after your clinic's name and one line before "Reply STOP".`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted" data-testid="texts-legend">
        <span className="flex items-center gap-1.5"><span className="rounded-md bg-primary-soft px-1.5 py-0.5 font-medium text-primary">{`{${names.pet}}`}</span> filled in from the call or the request</span>
        <span className="flex items-center gap-1.5"><span className="rounded-md border border-dashed border-warning bg-warning-soft px-1.5 py-0.5 font-medium text-text">{names.yourLead}</span> where your own words go</span>
      </div>
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
                    {!editing && <Template testId={`text-${t}`} names={names} words={{ yourLead: texting.wording[t]?.[first]?.label, yourLine: texting.wording[t]?.[first]?.extra }} body={renderText(t, tmpl, first, slotted(texting.wording[t]?.[first]))} />}
                    {editing && languages.map((lang) => {
                      const w = texting.wording[t]?.[lang] ?? {};
                      const sent = renderText(t, example, lang, w);
                      const check = TextWording.safeParse(w);
                      const segments = smsSegments(sent);
                      return (
                        <div key={lang} className="space-y-2">
                          {languages.length > 1 && <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{lang === 'es' ? 'Spanish' : 'English'}</p>}
                          {/* one preview: the text with its tags, and the clinic's words in place as they are typed */}
                          <Template testId={`template-${t}-${lang}`} names={names} words={{ yourLead: w.label, yourLine: w.extra }}
                            body={renderText(t, tmpl, lang, { label: slot('yourLead'), extra: slot('yourLine') })} />
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">{names.yourLead}, after your name <span className="font-normal text-text-muted">(up to 40 characters)</span></span>
                              <Input maxLength={40} disabled={disabled} value={w.label ?? ''} placeholder={lang === 'es' ? 'p. ej. Encuéntrenos aquí' : 'e.g. Find our clinic here'} onChange={(e) => set(t, lang, { label: e.target.value })} />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">{names.yourLine}, before &quot;Reply STOP&quot; <span className="font-normal text-text-muted">(up to 100 characters)</span></span>
                              <Input maxLength={100} disabled={disabled} value={w.extra ?? ''} placeholder={lang === 'es' ? 'p. ej. Llegue 10 minutos antes' : 'e.g. Please arrive 10 minutes early'} onChange={(e) => set(t, lang, { extra: e.target.value })} />
                            </label>
                          </div>
                          {!check.success && <p className="text-xs text-danger" role="alert">{check.error.issues[0]?.message}</p>}
                          <p className={`text-xs ${segments > 1 ? 'text-warn' : 'text-text-muted'}`}>About {sent.length} characters: {segments === 1 ? '1 text' : `${segments} texts`}. Names change the length a little.</p>
                          <details className="group text-sm">
                            <summary className="focus-ring cursor-pointer rounded text-xs font-medium text-primary hover:underline">See it as a client gets it, with made-up names</summary>
                            <div className="mt-2"><Bubble testId={`preview-${t}-${lang}`}>{sent}</Bubble></div>
                          </details>
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
