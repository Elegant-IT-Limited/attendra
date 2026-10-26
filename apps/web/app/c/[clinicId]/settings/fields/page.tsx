// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, type CustomField, listUsage, managedList } from '@attendra/core';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { BuiltIn, cleanFields, FieldsEditor } from '@/components/settings/fields-editor';
import { ListEditor } from '@/components/settings/list-editor';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { moved, Sortable } from '@/components/ui/sortable';
import { Tabs } from '@/components/ui/tabs';
import { useProblem, useToast } from '@/components/ui/toast';
import { ApiFailure, useClinic } from '@/lib/api';
import { useSettingsSlice } from '@/lib/settings-save';
import { providerTerms, useTerms } from '@/lib/terms';

type Tab = 'patients' | 'providers' | 'requests';
type Draft = Pick<ClinicConfig, 'customFields' | 'providerFields' | 'requestFields' | 'requestTopics'>;
const pick = (c: ClinicConfig): Draft => ({ customFields: c.customFields ?? [], providerFields: c.providerFields ?? [], requestFields: c.requestFields ?? [], requestTopics: c.requestTopics ?? [] });

export default function FieldsAndListsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><FieldsAndLists /></Suspense>;
}

/**
 * Settings, Fields and lists: for pets (or patients), veterinarians (or doctors) and
 * requests, the clinic's own fields and the lists they pick from. Every section saves with
 * its own button: fields, kinds of request and each list (a rename reaches every record).
 */
function FieldsAndLists() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const terms = useTerms(clinicId);
  const { can } = useClinic(clinicId);
  const toast = useToast();
  const problem = useProblem();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (['patients', 'providers', 'requests'] as const).find((t) => t === params.get('tab')) ?? 'patients';
  const slice = useSettingsSlice(clinicId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [config, setConfig] = useState<ClinicConfig | null>(null);
  useEffect(() => { if (slice.config && !config) { setConfig(slice.config); setDraft(pick(slice.config)); } }, [slice.config, config]);

  const save = useMutation({
    mutationFn: (d: Draft) => slice.save({
      customFields: cleanFields(d.customFields ?? []), providerFields: cleanFields(d.providerFields ?? []), requestFields: cleanFields(d.requestFields ?? []),
      requestTopics: (d.requestTopics ?? []).filter((t) => t.name.trim()),
    }),
    onSuccess: (c) => { setConfig(c); setDraft(pick(c)); toast({ tone: 'success', message: 'Saved.' }); },
    onError: (e) => problem(e instanceof ApiFailure
      ? { title: 'Not saved. Fix these first', items: (e.body.issues ?? [{ path: '', message: e.message }]).map((i) => i.message) }
      : { title: 'Not saved', message: 'The changes did not reach the server. Check your connection and press Save changes again.' }),
  });

  if (slice.isError) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Alert tone="danger">The settings did not load. Refresh the page.</Alert></>;
  if (!draft || !config) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Skeleton className="h-96" /></>;
  const writable = can('settings:write');
  const pet = config.industry === 'vet';
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const onListSaved = (c: ClinicConfig) => setConfig(c);
  const topics = draft.requestTopics ?? [];
  const setTab = (t: Tab) => router.replace(`${pathname}?tab=${t}`, { scroll: false });
  // each section saves with its own button, the same as every list on this page
  const changed = (k: keyof Draft) => JSON.stringify(draft[k] ?? []) !== JSON.stringify(pick(config)[k] ?? []);
  const saveButton = (k: keyof Draft, what: string) => writable && (
    <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
      {changed(k) && <span className="text-sm text-text-muted">Unsaved changes</span>}
      {changed(k) && <Button variant="ghost" onClick={() => set({ [k]: pick(config)[k] } as Partial<Draft>)}>Discard</Button>}
      <Button disabled={!changed(k) || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? 'Saving…' : `Save ${what}`}</Button>
    </div>
  );

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      <Tabs label="Fields and lists for" value={tab} onValueChange={setTab} className="mb-6"
        tabs={[{ value: 'patients', label: terms.title('patients') }, { value: 'providers', label: terms.title('providers') }, { value: 'requests', label: 'Requests' }]} />

      <div className="space-y-6">
        {tab === 'patients' && (
          <>
            <FieldsEditor id="patient-fields" title={`Fields on each ${terms.patient}`} disabled={!writable} teamOnly
              description={`Details you keep that have no place yet, like ${pet ? 'a microchip number, an insurer or a vaccine due date' : 'an insurer or a reminder date'}. Where they show: in Add ${terms.patient}, on each ${terms.patient}'s page under Details, and on the ${terms.patients} list when ticked. Dropdowns and yes-or-no fields also filter the list. Removing a field hides what was filled in.`} columnLabel={`Show on the ${terms.title('patients')} list`}
              placeholder={pet ? 'e.g. Microchip' : 'e.g. Insurance member ID'} fields={draft.customFields ?? []} onChange={(customFields: CustomField[]) => set({ customFields })}
              builtIn={pet ? ['Pet\'s name', 'Kind of animal', 'Sex', 'Birthday', 'Owner', 'Phone', 'Usual vet', 'Reminder consent'] : ['First name', 'Last name', 'Date of birth', 'Gender', 'Phone', 'Parent or guardian', 'Usual doctor']}
              footer={saveButton('customFields', 'fields')} />
            {pet && (
              <ListEditor clinicId={clinicId} name="species" id="species" title="Kind of animal" disabled={!writable} placeholder="e.g. Rabbit"
                description="Offered first when your team adds a pet, in this order, and used to filter the Pets list. Each pet keeps the kind it was saved with."
                values={managedList(config, 'species')} usage={{}} onSaved={onListSaved} />
            )}
          </>
        )}

        {tab === 'providers' && (
          <>
            <FieldsEditor id="provider-fields" title={`Fields on each ${terms.provider}`} disabled={!writable}
              description={`Details about your ${terms.providers} that have no place yet, like a licence number or the languages they speak. Where they show: in the form to add or edit a ${terms.provider}, under More details, and on their card once filled in. The assistant tells callers who ask, like their qualifications; untick "The assistant may tell callers" to keep one for your team, like a licence number.`}
              tellsCallers placeholder="e.g. Qualifications" fields={draft.providerFields ?? []} onChange={(providerFields: CustomField[]) => set({ providerFields })}
              builtIn={['Name', 'Is a', 'Gender', providerTerms(pet).specialty, providerTerms(pet).sees, 'Qualifications and certifications', ...(pet ? [] : ['Ages they see']), 'Visit types they can be booked for', 'Weekly hours', 'Days off', `Takes new ${terms.patients}`]}
              footer={saveButton('providerFields', 'fields')} />
            <ListEditor clinicId={clinicId} name="specialties" id="specialties" title={providerTerms(pet).specialty} disabled={!writable} placeholder={pet ? 'e.g. Surgery' : 'e.g. Family medicine'}
              description={`What callers hear a ${terms.provider} is (one each). Renaming one renames it on every ${terms.provider}; removing it takes it off them.`}
              values={managedList(config, 'specialties')} usage={listUsage(config, 'specialties')} onSaved={onListSaved} />
            <ListEditor clinicId={clinicId} name="categories" id="categories" title={providerTerms(pet).sees} disabled={!writable} placeholder={pet ? 'e.g. Exotics' : 'e.g. Children'}
              description={`The tags callers are matched on ("someone who sees rabbits"). Picked on each ${terms.provider}; renaming or removing one here changes it on every ${terms.provider}.`}
              values={managedList(config, 'categories')} usage={listUsage(config, 'categories')} onSaved={onListSaved} />
          </>
        )}

        {tab === 'requests' && (
          <>
            <FieldsEditor id="request-fields" title="Fields on each request" disabled={!writable} teamOnly
              description="Details your team adds to a request, like an insurance claim number or a follow-up reason. Where they show: in New request, and on every request card (&ldquo;Not filled in&rdquo; until someone fills them, with Edit details). Dropdowns and yes-or-no fields also filter the Requests page."
              placeholder="e.g. Pharmacy" fields={draft.requestFields ?? []} onChange={(requestFields: CustomField[]) => set({ requestFields })}
              builtIn={['Kind of request', pet ? 'Pet' : 'Patient', 'Call back on', 'What it is about', 'Who has it', 'Urgent', 'Due', 'Notes']}
              footer={saveButton('requestFields', 'fields')} />
            <Section id="topics" title="Kind of request" description="The built-in kinds, and your own kinds of request, like a boarding inquiry or an insurance question. The assistant asks what you list for each and labels the request, so your team sees at a glance what it is."
              action={<Button type="button" size="sm" variant="outline" disabled={!writable || topics.length >= 20} onClick={() => {
                const empty = topics.findIndex((t) => !t.name.trim());
                if (empty >= 0) { document.getElementById(`topic-${empty}`)?.querySelector('input')?.focus(); return; }
                set({ requestTopics: [{ id: `topic_${Math.random().toString(36).slice(2, 8)}`, name: '' }, ...topics] });
                setTimeout(() => document.getElementById('topic-0')?.querySelector('input')?.focus(), 0);
              }}><Plus /> Kind of request</Button>}>
              <BuiltIn label="Built in: always there, in the Requests filter and in New request" names={['Prescription refill', 'Callback', 'Voicemail', pet ? 'New pet to check' : 'New patient to check', 'Follow up']} />
              {!topics.length && <EmptyNote>None of your own yet. Requests are still taken; they are just not labelled.</EmptyNote>}
              <Sortable items={topics} keyOf={(t) => t.id} label={(t) => t.name} disabled={!writable} onMove={(f, to) => set({ requestTopics: moved(topics, f, to) })} className="space-y-5">
              {(t, i, handle) => (
                <Item handle={handle} id={`topic-${i}`} removeLabel="Remove kind of request" onRemove={() => set({ requestTopics: topics.filter((_, j) => j !== i) })}>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                    <Field label="Name"><Input maxLength={60} value={t.name} disabled={!writable} placeholder="e.g. Boarding inquiry" onChange={(e) => set({ requestTopics: topics.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
                    <Field label="What to ask the caller" hint="Optional."><Input maxLength={300} value={t.collect ?? ''} disabled={!writable} placeholder="e.g. The dates, the pet, and whether vaccines are current" onChange={(e) => set({ requestTopics: topics.map((x, j) => (j === i ? { ...x, collect: e.target.value || undefined } : x)) })} /></Field>
                  </div>
                </Item>
              )}
              </Sortable>
              {saveButton('requestTopics', 'kinds of request')}
            </Section>
          </>
        )}
      </div>

    </>
  );
}
