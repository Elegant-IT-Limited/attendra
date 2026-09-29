// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, DEFAULT_ASSISTANT_NAME, emergencyNumberFor, type Language, LANGUAGES, PACKS } from '@attendra/core';
import { Field, Section } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/controls';
import { Alert } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/input';

export const EXPERIMENTAL_NOTE = 'Check the voice with a native speaker before using it with patients.';

/** Whatever a language pack says, marked with its language so screen readers and the Bengali font pick it up. */
export function Spoken({ language, children }: { language: Language; children: string }) {
  return <p lang={PACKS[language].locale} className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-base">{children}</p>;
}

/**
 * The assistant's name, the languages it speaks and the number its emergency script
 * gives. The dashboard itself stays in English; only what callers hear changes.
 */
export function AssistantSection({ c, set, disabled }: { c: ClinicConfig; set: (patch: Partial<ClinicConfig>) => void; disabled: boolean }) {
  const name = c.assistantName?.trim() || null;
  const defaultNumber = emergencyNumberFor({ phoneNumbers: c.phoneNumbers });
  const toggle = (l: Language, on: boolean) => set({ languages: on ? LANGUAGES.filter((x) => x === l || c.languages.includes(x)) : c.languages.filter((x) => x !== l) });

  return (
    <Section title="Assistant and languages" description="What the assistant is called, which languages it answers in, and the emergency number it gives. The dashboard stays in English.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Assistant name" htmlFor="assistant-name" hint={`One word, 2 to 24 letters. Without one it is "${DEFAULT_ASSISTANT_NAME}". A name never replaces the AI disclosure.`}>
          <Input id="assistant-name" value={c.assistantName ?? ''} placeholder="Maya" maxLength={24}
            onChange={(e) => set({ assistantName: e.target.value.trim() ? e.target.value : undefined })} />
        </Field>
        <Field label="Emergency number" htmlFor="emergency-number" hint={`What the emergency script tells callers to ring. Leave empty for ${defaultNumber}, from the clinic's country.`}>
          <Input id="emergency-number" inputMode="numeric" className="font-mono" value={c.emergencyNumber ?? ''} placeholder={defaultNumber} maxLength={4}
            onChange={(e) => set({ emergencyNumber: e.target.value.trim() || undefined })} />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Languages the assistant speaks</legend>
        {LANGUAGES.map((l) => {
          const pack = PACKS[l];
          const primary = l === c.primaryLanguage;
          return (
            <Checkbox key={l} id={`language-${l}`} checked={c.languages.includes(l)} disabled={disabled || primary} onCheckedChange={(on) => toggle(l, on)}
              label={<span className="inline-flex items-center gap-2">{pack.name}{pack.nativeName !== pack.name && <span lang={pack.locale} className="text-text-muted">{pack.nativeName}</span>}{pack.experimental && <Badge tone="warn">Experimental</Badge>}</span>}
              hint={primary ? 'The primary language. Choose another primary language to turn this one off.' : undefined} />
          );
        })}
      </fieldset>

      <Field label="Primary language" htmlFor="primary-language" hint="Calls start in this language. The assistant switches when the caller speaks another one from the list, and back again.">
        <Select id="primary-language" className="w-56" value={c.primaryLanguage} onChange={(e) => set({ primaryLanguage: e.target.value as Language })}>
          {c.languages.map((l) => <option key={l} value={l}>{PACKS[l].name}</option>)}
        </Select>
      </Field>

      {c.languages.some((l) => PACKS[l].experimental) && (
        <Alert tone="warn" title="Bangla is experimental">{EXPERIMENTAL_NOTE}</Alert>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Greeting preview</h3>
        {c.languages.map((l) => {
          const primary = l === c.primaryLanguage;
          const suggested = PACKS[l].greeting({ assistantName: name, clinicName: c.name });
          return (
            <div key={l} className="space-y-1.5" data-testid={`greeting-preview-${l}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-text-muted">{primary ? `${PACKS[l].name}: the first thing every caller hears (the greeting above)` : `${PACKS[l].name}: when a caller speaks ${PACKS[l].name}`}</p>
                {primary && c.greeting !== suggested && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => set({ greeting: suggested })}>Use the suggested greeting</Button>
                )}
              </div>
              <Spoken language={l}>{primary ? c.greeting : suggested}</Spoken>
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
          <Input className="w-56" lang={PACKS[l].locale} value={thing.names?.[l] ?? ''} placeholder={thing.name} aria-label={`${what} ${thing.name} in ${PACKS[l].name}`}
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
