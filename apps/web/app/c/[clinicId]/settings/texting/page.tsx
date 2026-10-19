// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, Texting, type TextKind } from '@attendra/core';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/controls';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { moved, Sortable } from '@/components/ui/sortable';
import { useProblem, useToast } from '@/components/ui/toast';
import { ApiFailure, useClinic } from '@/lib/api';
import { useSettingsSlice } from '@/lib/settings-save';

type Draft = ReturnType<typeof Texting.parse>;
const blankLink = (l: { label: string; url: string; when: string }) => !l.label.trim() && /^(https?:\/\/)?$/.test(l.url.trim()) && !l.when.trim();
const linkId = (label: string) => `${label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'link'}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * What the assistant may text a caller during a call, after they say yes, and the
 * confirmations it sends when a visit is moved or cancelled. Saved with the clinic's
 * settings, on top of anyone else's save.
 */
export default function TextingSettings() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { can, clinic } = useClinic(clinicId);
  const toast = useToast();
  const problem = useProblem();
  const slice = useSettingsSlice(clinicId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  useEffect(() => { if (slice.config && !draft) setDraft(Texting.parse(slice.config.texting ?? {})); }, [slice.config, draft]);
  useEffect(() => {
    if (!added) return;
    const el = document.getElementById(added);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    setAdded(null);
  }, [added, draft]);

  const save = useMutation({
    mutationFn: (texting: Draft) => slice.save({ texting: { ...texting, links: texting.links.filter((l) => !blankLink(l)) } }),
    onSuccess: (config: ClinicConfig) => { setDraft(Texting.parse(config.texting ?? {})); toast({ tone: 'success', message: 'Saved. The next call uses these settings.' }); },
    onError: (e) => problem(e instanceof ApiFailure
      ? { title: 'Not saved. Fix these first', items: (e.body.issues ?? [{ path: '', message: e.message }]).map((i) => i.message) }
      : { title: 'Not saved', message: 'The changes did not reach the server. Check your connection and press Save changes again.' }),
  });

  if (slice.isError) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Alert tone="danger">The settings did not load. Refresh the page.</Alert></>;
  if (!draft || !slice.config) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Skeleton className="h-96" /></>;
  const c = slice.config;
  const writable = can('settings:write');
  const pet = c.industry === 'vet';
  const hosted = !!clinic?.accountLinks.length;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const kind = (k: TextKind, on: boolean) => set({ kinds: { ...draft.kinds, [k]: on } });
  const r = draft.reminders;
  const rem = (patch: Partial<Draft['reminders']>) => set({ reminders: { ...r, ...patch } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(Texting.parse(c.texting ?? {}));
  const kinds: { k: TextKind; label: string; hint: string; show?: boolean; disabled?: string }[] = [
    { k: 'change_confirmed', label: 'Appointment changes', hint: 'A confirmation when a visit is moved or cancelled on the phone, like the booking confirmation. Sent without asking.' },
    { k: 'directions', label: 'Address and directions', hint: 'Your address and a map link.', disabled: c.address?.trim() ? undefined : 'Add the clinic\'s address under General first.' },
    { k: 'hours', label: 'Opening hours', hint: 'Your weekly hours, and any day you are closed in the next two weeks.' },
    { k: 'emergency_hospital', label: 'Emergency hospital', hint: 'During an animal emergency: the hospital\'s name, address and phone, after the caller says yes. The only text the assistant sends in an emergency.', show: pet },
    { k: 'provider', label: pet ? 'A veterinarian\'s details' : 'A doctor\'s details', hint: 'Name, credentials and what they see.' },
    { k: 'answer', label: 'Answers to common questions', hint: 'The answer the assistant just gave from your Common questions. Never your documents.' },
    { k: 'link', label: 'Your links', hint: 'The links below.' },
  ];

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      <fieldset disabled={!writable || save.isPending} className="min-w-0 space-y-6 pb-24">
        <Section id="texting" title="Texting" description={'What the assistant may text a caller during a call, after they say yes. Texts go only to the number they are calling from, or the number on their file, and every text ends with "Reply STOP to opt out."'}>
          <Switch id="texting-on" label="Send texts during calls" checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })}
            hint={hosted ? 'Texts start once your text registration (A2P) is approved: Phone number, under Account in the menu.' : 'Needs Twilio Messaging on the voice service.'} />
          {!draft.enabled && <EmptyNote>Texting during calls is off. Callers hear everything; nothing is texted except booking confirmations and the changes below.</EmptyNote>}
        </Section>

        <Section id="kinds" title="What the assistant may text" description="Each one is offered only after the caller has heard it, and sent only after a clear yes.">
          {kinds.filter((x) => x.show !== false).map((x) => (
            <Switch key={x.k} id={`kind-${x.k}`} label={x.label} hint={x.disabled ?? x.hint} checked={draft.kinds[x.k] && !x.disabled} disabled={!!x.disabled} onCheckedChange={(on) => kind(x.k, on)} />
          ))}
        </Section>

        <Section id="map" title="Map link" description="The link texted with your address.">
          <Field label="Map link (optional)" hint="Leave empty to send a Google Maps link to your address.">
            <Input id="map-url" type="url" placeholder="https://" value={draft.mapUrl ?? ''} onChange={(e) => set({ mapUrl: e.target.value.trim() ? e.target.value : undefined })} />
          </Field>
        </Section>

        <Section id="links" title="Links" description="Your new-client form, price list or booking page, and when the assistant should offer each one."
          action={<Button type="button" size="sm" variant="outline" disabled={draft.links.length >= 10} onClick={() => {
            const empty = draft.links.findIndex(blankLink);
            if (empty >= 0) { setAdded(`link-${empty}`); return; }
            set({ links: [{ id: linkId('link'), label: '', url: 'https://', when: '' }, ...draft.links] }); setAdded('link-0');
          }}><Plus /> Link</Button>}>
          {!draft.links.length && <EmptyNote>No links yet. Add your new-client form, price list or website, and say when the assistant should offer it.</EmptyNote>}
          <Sortable items={draft.links} keyOf={(l) => l.id} label={(l) => l.label} disabled={!writable} onMove={(f, t) => set({ links: moved(draft.links, f, t) })} className="space-y-5">
          {(l, i, handle) => {
            const upd = (patch: Partial<typeof l>) => set({ links: draft.links.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <Item handle={handle} id={`link-${i}`} removeLabel={`Remove ${l.label || 'this link'}`} onRemove={() => set({ links: draft.links.filter((_, j) => j !== i) })}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="What the text calls it"><Input maxLength={40} value={l.label} placeholder="e.g. New client form" onChange={(e) => upd({ label: e.target.value })} /></Field>
                  <Field label="Link"><Input type="url" maxLength={300} value={l.url} placeholder="https://" onChange={(e) => upd({ url: e.target.value })} /></Field>
                  <Field label="When to offer it" className="sm:col-span-2"><Input maxLength={120} value={l.when} placeholder="e.g. a new client asks about paperwork" onChange={(e) => upd({ when: e.target.value })} /></Field>
                </div>
              </Item>
            );
          }}
          </Sortable>
        </Section>

        <Section id="reminders" title="Reminders" description="A text before each visit, to owners who said yes: on a call, on their record, or in an import. They reply C to confirm, and the Schedule shows it.">
          <Switch id="reminders-on" label="Send appointment reminders" checked={r.enabled} onCheckedChange={(enabled) => rem({ enabled })} />
          {r.enabled && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Hours before the visit" htmlFor="reminder-hours" hint="Between 2 and 168. 24 is the day before.">
                <Input id="reminder-hours" type="number" min={2} max={168} value={r.hoursBefore} onChange={(e) => rem({ hoursBefore: Number(e.target.value) })} />
              </Field>
              <Field label="Quiet hours" htmlFor="quiet-from" hint="No texts between these times, in your time zone. One that would fall in them goes out when they end." className="sm:col-span-2">
                <div className="flex items-center gap-2">
                  <Input id="quiet-from" type="time" className="w-32" value={r.quietFrom} onChange={(e) => rem({ quietFrom: e.target.value })} />
                  <span className="text-sm text-text-muted">to</span>
                  <Input aria-label="Quiet hours end" type="time" className="w-32" value={r.quietTo} onChange={(e) => rem({ quietTo: e.target.value })} />
                </div>
              </Field>
            </div>
          )}
          {r.enabled && <Switch id="reminders-ask" label="Ask callers when booking" hint={'After a booking, the assistant asks once: "Would you like a reminder text before the visit?" A clear yes is kept on their record.'} checked={r.askOnBooking} onCheckedChange={(askOnBooking) => rem({ askOnBooking })} />}
        </Section>
      </fieldset>

      {writable && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur md:left-16 xl:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <p className="text-sm text-text-muted">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setDraft(Texting.parse(c.texting ?? {})) }}>Discard</Button>
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
