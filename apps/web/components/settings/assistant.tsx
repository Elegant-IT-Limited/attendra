// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { allowedEmergencyNumbers, cleanDigitsTyping, type ClinicConfig, DIGITS_ONLY, DEFAULT_ASSISTANT_NAME, EMERGENCY_COUNTRIES, emergencyCountry, emergencyNumberFor, type Language, LANGUAGES, normalise, PACKS, renameInGreeting, staleGreetingNames } from '@attendra/core';
import { Alert } from '@/components/ui/feedback';
import { Field, Section } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Input, Select, Textarea } from '@/components/ui/input';
import { useState } from 'react';

/**
 * A greeting that still says an old clinic or assistant name (note 52 B3: a test clinic renamed both, and callers kept
 * hearing the old ones): "Your greeting still says 'Riverside'", with the one-click change to the name now. With no
 * assistant name of its own, the change is the suggested greeting.
 */
export function StaleGreeting({ text, language, clinic, onFix }: { text: string; language: Language; clinic: ClinicConfig; onFix: (text: string) => void }) {
  const names = { clinicName: clinic.name, assistantName: clinic.assistantName };
  const stale = staleGreetingNames(text, language, names);
  if (!stale.length) return null;
  const fixed = stale.reduce((t, s) => (s.now ? renameInGreeting(t, s.said, s.now) ?? t : t), text);
  const suggestion = PACKS[language].greeting({ clinicName: clinic.name, assistantName: clinic.assistantName?.trim() || null });
  const toSuggested = stale.some((s) => !s.now);
  const said = stale.map((s) => `"${s.said}"`).join(' and ');
  return (
    <div data-testid={`greeting-stale-${language}`}><Alert tone="warn">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span>Your {PACKS[language].name} greeting still says {said}.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => onFix(toSuggested ? suggestion : fixed)}>
          {toSuggested ? 'Use the suggested greeting' : `Change it to ${stale.map((s) => `"${s.now}"`).join(' and ')}`}
        </Button>
      </span>
    </Alert></div>
  );
}

/** Whatever a language pack says, marked with its language so screen readers pick it up. */
export function Spoken({ language, children }: { language: Language; children: string }) {
  return <p lang={PACKS[language].locale} className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-base">{children}</p>;
}

/**
 * The assistant's name, the languages it speaks and the number its emergency script
 * gives. The dashboard itself stays in English; only what callers hear changes.
 */
export function AssistantSection({ c, set, rename, disabled }: { c: ClinicConfig; set: (patch: Partial<ClinicConfig>) => void; rename: (patch: Pick<Partial<ClinicConfig>, 'name' | 'assistantName'>) => void; disabled: boolean }) {
  const name = c.assistantName?.trim() || null;
  const defaultNumber = emergencyNumberFor({ phoneNumbers: c.phoneNumbers, country: c.country });
  const allowed = allowedEmergencyNumbers(c.phoneNumbers, c.country);
  const country = emergencyCountry(c.phoneNumbers, c.country);
  const fromPhone = emergencyCountry(c.phoneNumbers);
  // letters typed or pasted into the emergency number are dropped with a note, never silently
  const [digitsNote, setDigitsNote] = useState(false);
  const toggle = (l: Language, on: boolean) => set({ languages: on ? LANGUAGES.filter((x) => x === l || c.languages.includes(x)) : c.languages.filter((x) => x !== l) });

  return (
    <Section id="assistant" title="Assistant and languages" description="What the assistant is called, which languages it answers in, and the emergency number it gives. The dashboard stays in English.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Assistant name" htmlFor="assistant-name" hint={`One word, 2 to 24 letters. Without one it is "${DEFAULT_ASSISTANT_NAME}". A name never replaces the AI disclosure.`}>
          <Input id="assistant-name" autoComplete="off" value={c.assistantName ?? ''} placeholder="e.g. Maya" maxLength={24}
            onChange={(e) => rename({ assistantName: e.target.value.trim() ? e.target.value : undefined })} />
        </Field>
        <Field label="Country" htmlFor="clinic-country" hint="Sets the emergency number the assistant gives a person in danger.">
          <Select id="clinic-country" value={c.country ?? ''} disabled={disabled}
            onChange={(e) => set({ country: e.target.value || undefined, emergencyNumber: undefined })}>
            <option value="">{fromPhone ? `From your phone number: ${fromPhone}` : 'Not set'}</option>
            {[...EMERGENCY_COUNTRIES].sort((a, b) => a.name.replace(/^the /, '').localeCompare(b.name.replace(/^the /, ''))).map((x) => (
              <option key={x.code} value={x.code}>{x.name.replace(/^the /, '').replace(/^./, (l) => l.toUpperCase())}</option>
            ))}
          </Select>
        </Field>
        <Field label="Emergency number" htmlFor="emergency-number" hint={(digitsNote ? `${DIGITS_ONLY} ` : '') + (allowed.length
          ? `${defaultNumber}, from ${country}. Leave it empty unless your area uses another number${allowed.length > 1 ? ` (${allowed.join(' or ')})` : ''}.`
          : 'Your country isn\'t on our list, so the assistant says "call your local emergency number". Choose your country if it is listed.')}>
          <Input id="emergency-number" inputMode="numeric" autoComplete="off" className="font-mono" value={c.emergencyNumber ?? ''} placeholder={allowed.length ? defaultNumber : 'None'} maxLength={5}
            disabled={disabled || !allowed.length} onChange={(e) => { const { value, dropped } = cleanDigitsTyping(e.target.value); setDigitsNote(dropped || (digitsNote && !!value)); set({ emergencyNumber: value || undefined }); }} />
        </Field>
      </div>
      <p className="text-sm text-text-muted" data-testid="emergency-line">A person in danger is told: &ldquo;If a person is hurt or in danger, call {defaultNumber}.&rdquo;</p>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Languages the assistant speaks</legend>
        {LANGUAGES.map((l) => {
          const pack = PACKS[l];
          const primary = l === c.primaryLanguage;
          return (
            <Checkbox key={l} id={`language-${l}`} checked={c.languages.includes(l)} disabled={disabled || primary} onCheckedChange={(on) => toggle(l, on)}
              label={<span className="inline-flex items-center gap-2">{pack.name}{pack.nativeName !== pack.name && <span lang={pack.locale} className="text-text-muted">{pack.nativeName}</span>}</span>}
              hint={primary ? 'The primary language. Choose another primary language to turn this one off.' : undefined} />
          );
        })}
      </fieldset>

      <Field label="Primary language" htmlFor="primary-language" hint="Calls start in this language. The assistant switches when the caller speaks another one from the list, and back again.">
        <Select id="primary-language" className="sm:w-64" value={c.primaryLanguage} onChange={(e) => set({ primaryLanguage: e.target.value as Language })}>
          {c.languages.map((l) => <option key={l} value={l}>{PACKS[l].name}</option>)}
        </Select>
      </Field>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Greetings</h3>
        {c.languages.map((l) => {
          const primary = l === c.primaryLanguage;
          const suggested = PACKS[l].greeting({ assistantName: name, clinicName: c.name });
          const own = c.greetings?.[l];
          // the greeting in another language: the clinic's own words, or the suggestion until it writes some
          const setOther = (text: string | undefined) => {
            const next = { ...c.greetings, [l]: text };
            const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Partial<Record<Language, string>>;
            set({ greetings: Object.keys(kept).length ? kept : undefined });
          };
          const missing = !!own && !PACKS[l].disclosure.test(normalise(own));
          return (
            <div key={l} className="space-y-1.5" data-testid={`greeting-preview-${l}`}>
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={`greeting-${l}`} className="text-xs text-text-muted">{primary ? `${PACKS[l].name}: the first thing every caller hears (the greeting above)` : `${PACKS[l].name}: said once when a caller speaks ${PACKS[l].name}`}</label>
                {primary && c.greeting !== suggested && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => set({ greeting: suggested })}>Use the suggested greeting</Button>
                )}
                {!primary && own && own !== suggested && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOther(undefined)}>Use the suggested greeting</Button>
                )}
              </div>
              {primary ? <Spoken language={l}>{c.greeting}</Spoken> : (
                <>
                  <Textarea id={`greeting-${l}`} lang={PACKS[l].locale} maxLength={400} rows={2} value={own ?? suggested} disabled={disabled}
                    aria-invalid={missing || undefined} aria-describedby={missing ? `greeting-${l}-error` : undefined} onChange={(e) => setOther(e.target.value === suggested ? undefined : e.target.value)} />
                  {missing && <p id={`greeting-${l}-error`} className="text-xs text-danger">The {PACKS[l].name} greeting must say the caller is speaking with an AI assistant.</p>}
                  {own && <StaleGreeting text={own} language={l} clinic={c} onFix={(text) => setOther(text === suggested ? undefined : text)} />}
                </>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** A visit type's or provider's name in the clinic's other languages, when callers say it differently. */
export function LocalNames({ thing, languages, onChange, what }: {
  thing: { name: string; names?: Partial<Record<Language, string>> }; languages: Language[]; what: string;
  onChange: (names: Partial<Record<Language, string>> | undefined) => void;
}) {
  const others = languages.filter((l) => l !== 'en');
  if (!others.length) return null;
  return (
    <>
      {others.map((l) => (
        <Field key={l} label={`In ${PACKS[l].name}`}>
          <Input lang={PACKS[l].locale} maxLength={80} autoComplete="off" value={thing.names?.[l] ?? ''} placeholder={thing.name} aria-label={`${what} ${thing.name} in ${PACKS[l].name}`}
            onChange={(e) => {
              const names = { ...thing.names, [l]: e.target.value || undefined };
              const kept = Object.fromEntries(Object.entries(names).filter(([, v]) => v)) as Partial<Record<Language, string>>;
              onChange(Object.keys(kept).length ? kept : undefined);
            }} />
        </Field>
      ))}
    </>
  );
}
