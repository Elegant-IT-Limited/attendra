// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { bookingOf, type BookingRules, type ClinicConfig, type Terms } from '@attendra/core';
import { Field, Section } from '@/components/settings/section';
import { RadioGroup, Switch } from '@/components/ui/controls';
import { Input } from '@/components/ui/input';
import { moved, Sortable } from '@/components/ui/sortable';
import { useEffect, useState } from 'react';

/**
 * Settings, Booking rules: who the assistant books with when the caller names nobody,
 * set by the clinic, and every case said in plain words underneath, so the team knows
 * exactly what the assistant does.
 */
export function BookingRulesSection({ c, set, disabled, terms }: { c: ClinicConfig; set: (patch: Partial<ClinicConfig>) => void; disabled: boolean; terms: Pick<Terms, 'provider' | 'providers'> }) {
  const r = bookingOf(c);
  const pet = c.industry === 'vet';
  const vet = terms.provider; // "veterinarian" or "doctor"
  const vets = terms.providers;
  const who = pet ? 'the pet' : 'the patient';
  const upd = (patch: Partial<BookingRules>) => set({ booking: { ...r, ...patch } });
  const people = c.providers.filter((p) => !p.placeholder);

  return (
    <Section id="booking" title="Booking rules" description={`Who the assistant books with when a caller does not name a ${vet}. A caller who asks for someone (by name, a kind of ${vet}, a female or a male ${vet}) is only ever offered them.`}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">When the caller has no {vet} in mind</legend>
            <RadioGroup label={`When the caller has no ${vet} in mind`} value={r.noPreference} disabled={disabled} onValueChange={(noPreference) => upd({ noPreference })}
              options={[
                { value: 'usual_first', label: `${pet ? 'The pet’s' : 'Their'} usual ${vet} first`, hint: `The one ${pet ? 'it has' : 'they have'} seen most in two years. If they are not free soon enough, the earliest time with anyone, and the caller hears why.` },
                { value: 'earliest', label: `The earliest time with any ${vet}`, hint: 'Quickest for the caller; the visit goes to whoever is free first.' },
              ]} />
            {r.noPreference === 'usual_first' && (
              <Field label={`Wait for the usual ${vet} up to, in days`} hint={`1 to 30. Past this, the caller is offered the earliest time with another ${vet}.`}>
                <DaysInput disabled={disabled} value={r.usualWithinDays} onChange={(usualWithinDays) => upd({ usualWithinDays })} />
              </Field>
            )}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">When several {vets} are free at the same time</legend>
            <RadioGroup label={`When several ${vets} are free at the same time`} value={r.tieBreak} disabled={disabled} onValueChange={(tieBreak) => upd({ tieBreak })}
              options={[
                { value: 'fewest_visits', label: 'The one with the fewest visits that day', hint: 'Spreads the work evenly across the team.' },
                { value: 'list_order', label: 'In the order below', hint: `Drag the ${vets} into the order you want them offered.` },
              ]} />
            {r.tieBreak === 'list_order' && people.length > 1 && (
              <Sortable as="ul" items={people} keyOf={(p) => p.id} label={(p) => p.name} disabled={disabled}
                onMove={(f, t) => {
                  // the order of the whole list: the stand-in, if any, stays where it was, last
                  const next = moved(people, f, t);
                  set({ providers: [...next, ...c.providers.filter((p) => p.placeholder)] });
                }}
                className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface" itemClassName="flex items-center gap-2 px-2 py-1.5">
                {(p, i, handle) => (
                  <>
                    {handle}
                    <span className="w-5 text-right text-sm tabular-nums text-text-muted">{i + 1}</span>
                    <span className="flex-1 text-sm">{p.name}{p.specialty ? <span className="text-text-muted">, {p.specialty}</span> : null}</span>
                  </>
                )}
              </Sortable>
            )}
          </fieldset>

          {pet && (
            <Switch id="match-animal" label="Match the kind of animal" checked={r.matchAnimal} disabled={disabled} onCheckedChange={(matchAnimal) => upd({ matchAnimal })}
              hint="A rabbit is offered only vets who list rabbits or exotics under what they see. A vet who lists no animals sees every animal." />
          )}
        </div>

        <div className="rounded-lg border border-border bg-surface-sunken/50 p-4 text-sm" aria-label="How the assistant chooses">
          <p className="mb-2 font-medium">How the assistant chooses, in every case</p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>It asks once whether the caller would like a particular {vet}.</li>
            <li>A {vet} named by the caller: only their times. A kind of {vet} ({pet ? '"someone who sees rabbits"' : '"a pediatrician"'}) or a female or male {vet}: only those {vets}.</li>
            {pet && <li>{r.matchAnimal ? 'Only vets who see the pet’s kind of animal. A vet who lists no animals sees them all.' : 'Any vet, whatever the kind of animal.'}</li>}
            <li>No one in mind: {r.noPreference === 'usual_first'
              ? `${who}’s usual ${vet} first, if free within ${r.usualWithinDays} ${r.usualWithinDays === 1 ? 'day' : 'days'}; a sooner time with someone else is mentioned only if none suits. Otherwise the caller hears that their ${vet} is not free soon, and gets the earliest times.`
              : 'the earliest times with anyone.'}</li>
            <li>Three different times at most, never the same time three times. {r.tieBreak === 'fewest_visits' ? `With several ${vets} free at once, the one with the fewest visits that day.` : `With several ${vets} free at once, the first in your order.`}</li>
            <li>Never a {vet} who does not do that visit, is off or away then, does not see that age, or {pet ? 'takes no new pets' : 'takes no new patients'} when {pet ? 'the pet is' : 'they are'} new. Never outside the hours or on a day you are closed.</li>
            <li>Asked which {vet} is best, or to choose: it never ranks or compares your {vets}. It says it will find the right one, and follows these rules.</li>
            <li>It reads back the {vet}, the day and the time, and books only after a clear yes.</li>
          </ol>
        </div>
      </div>
    </Section>
  );
}

/** A number of days, 1 to 30, that can be cleared while typing: it settles on leaving the field. */
function DaysInput({ value, onChange, disabled, id, 'aria-describedby': describedBy }: { value: number; onChange: (days: number) => void; disabled?: boolean; id?: string; 'aria-describedby'?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  // Field names its control by passing these down: they go on the input itself
  return (
    <Input id={id} aria-describedby={describedBy} type="number" min={1} max={30} className="w-28" disabled={disabled} value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isInteger(n) && n >= 1 && n <= 30) onChange(n);
      }}
      onBlur={() => setText(String(value))} />
  );
}
