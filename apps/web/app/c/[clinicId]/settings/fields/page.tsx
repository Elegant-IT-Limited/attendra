// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { type ClinicConfig, type CustomField, listUsage, managedList } from '@attendra/core';
import { useMutation } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { cleanFields, FieldsEditor } from '@/components/settings/fields-editor';
import { ListEditor } from '@/components/settings/list-editor';
import { EmptyNote, Field, Item, Section } from '@/components/settings/section';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiFailure, useClinic } from '@/lib/api';
import { useSettingsSlice } from '@/lib/settings-save';
import { useTerms } from '@/lib/terms';

type Tab = 'patients' | 'providers' | 'requests';
type Draft = Pick<ClinicConfig, 'customFields' | 'providerFields' | 'requestFields' | 'requestTopics'>;
const pick = (c: ClinicConfig): Draft => ({ customFields: c.customFields ?? [], providerFields: c.providerFields ?? [], requestFields: c.requestFields ?? [], requestTopics: c.requestTopics ?? [] });

export default function FieldsAndListsPage() {
  return <Suspense fallback={<Skeleton className="h-96" />}><FieldsAndLists /></Suspense>;
}

/**
 * Settings, Fields and lists: for pets (or patients), veterinarians (or doctors) and
 * requests, the clinic's own fields and the lists they pick from. Fields are saved with
 * the bar at the bottom; each list has its own Save, since a rename reaches every record.
 */
function FieldsAndLists() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const terms = useTerms(clinicId);
  const { can } = useClinic(clinicId);
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab = (['patients', 'providers', 'requests'] as const).find((t) => t === params.get('tab')) ?? 'patients';
  const slice = useSettingsSlice(clinicId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [config, setConfig] = useState<ClinicConfig | null>(null);
  useEffect(() => { if (slice.config && !config) { setConfig(slice.config); setDraft(pick(slice.config)); } }, [slice.config, config]);

  const save = useMutation({
    mutationFn: (d: Draft) => slice.save({
      customFields: cleanFields(d.customFields ?? []), providerFields: cleanFields(d.providerFields ?? []), requestFields: cleanFields(d.requestFields ?? []),
      requestTopics: (d.requestTopics ?? []).filter((t) => t.name.trim()),
    }),
    onMutate: () => setIssues([]),
    onSuccess: (c) => { setConfig(c); setDraft(pick(c)); toast({ tone: 'success', message: 'Saved.' }); },
    onError: (e) => setIssues(e instanceof ApiFailure ? (e.body.issues ?? [{ path: '', message: e.message }]).map((i) => i.message) : ['Not saved. Try again.']),
  });

  if (slice.isError) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Alert tone="danger">The settings did not load. Refresh the page.</Alert></>;
  if (!draft || !config) return <><PageHeader title="Settings" /><SettingsNav clinicId={clinicId} /><Skeleton className="h-96" /></>;
  const writable = can('settings:write');
  const pet = config.industry === 'vet';
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(pick(config));
  const onListSaved = (c: ClinicConfig) => setConfig(c);
  const topics = draft.requestTopics ?? [];
  const setTab = (t: Tab) => router.replace(`${pathname}?tab=${t}`, { scroll: false });

  return (
    <>
      <PageHeader title="Settings" description="What the assistant says, when the clinic is open, and what it can book. Changes apply to the next call." />
      <SettingsNav clinicId={clinicId} />
      {!writable && <Alert className="mb-6">You can read these settings. A practice manager or owner can change them.</Alert>}
      {issues.length > 0 && <Alert tone="danger" title="Not saved:" className="mb-6"><ul className="list-disc pl-4">{issues.map((m, i) => <li key={i}>{m}</li>)}</ul></Alert>}
      <Tabs label="Fields and lists for" value={tab} onValueChange={setTab} className="mb-6"
        tabs={[{ value: 'patients', label: terms.title('patients') }, { value: 'providers', label: terms.title('providers') }, { value: 'requests', label: 'Requests' }]} />

      <div className="space-y-6 pb-24">
        {tab === 'patients' && (
          <>
            <FieldsEditor id="patient-fields" title={`Fields on each ${terms.patient}`} disabled={!writable}
              description={`Details you keep that have no place yet, like ${pet ? 'a microchip number, an insurer or a vaccine due date' : 'an insurer or a reminder date'}. Your team fills them in under Details on each record. Dropdowns and yes-or-no fields can filter the ${terms.patients} list. Removing a field hides what was filled in.`}
              placeholder={pet ? 'e.g. Microchip' : 'e.g. Insurance member ID'} fields={draft.customFields ?? []} onChange={(customFields: CustomField[]) => set({ customFields })} />
            {pet && (
              <ListEditor clinicId={clinicId} name="species" id="species" title="Kinds of animal" disabled={!writable} placeholder="e.g. Rabbit"
                description="Offered first when your team adds a pet, in this order, and used to filter the Pets list. Each pet keeps the kind it was saved with."
                values={managedList(config, 'species')} usage={{}} onSaved={onListSaved} />
            )}
          </>
        )}

        {tab === 'providers' && (
          <>
            <FieldsEditor id="provider-fields" title={`Fields on each ${terms.provider}`} disabled={!writable}
              description={`Details about your ${terms.providers} that have no place yet, like a licence number or the languages they speak. Filled in on each ${terms.provider}. The assistant does not use them.`}
              placeholder="e.g. Licence number" fields={draft.providerFields ?? []} onChange={(providerFields: CustomField[]) => set({ providerFields })} />
            <ListEditor clinicId={clinicId} name="specialties" id="specialties" title="Specialties" disabled={!writable} placeholder={pet ? 'e.g. Surgery' : 'e.g. Family medicine'}
              description={`What callers hear a ${terms.provider} is (one each). Renaming one renames it on every ${terms.provider}; removing it takes it off them.`}
              values={managedList(config, 'specialties')} usage={listUsage(config, 'specialties')} onSaved={onListSaved} />
            <ListEditor clinicId={clinicId} name="categories" id="categories" title={pet ? 'Animals and services they see' : 'What they see people for'} disabled={!writable} placeholder={pet ? 'e.g. Exotics' : 'e.g. Children'}
              description={`The tags callers are matched on ("someone who sees rabbits"). Picked on each ${terms.provider}; renaming or removing one here changes it on every ${terms.provider}.`}
              values={managedList(config, 'categories')} usage={listUsage(config, 'categories')} onSaved={onListSaved} />
          </>
        )}

        {tab === 'requests' && (
          <>
            <FieldsEditor id="request-fields" title="Fields on each request" disabled={!writable}
              description="Details your team adds to a request, like a pharmacy, an insurance claim number or a follow-up reason. Filled in on the request card; dropdowns and yes-or-no fields filter the Requests page."
              placeholder="e.g. Pharmacy" fields={draft.requestFields ?? []} onChange={(requestFields: CustomField[]) => set({ requestFields })} />
            <Section id="topics" title="Kinds of request" description="Your own kinds of request, like a boarding inquiry or an insurance question. The assistant asks what you list for each and labels the request, so your team sees at a glance what it is."
              action={<Button type="button" size="sm" variant="outline" disabled={!writable || topics.length >= 20} onClick={() => {
                const empty = topics.findIndex((t) => !t.name.trim());
                if (empty >= 0) { document.getElementById(`topic-${empty}`)?.querySelector('input')?.focus(); return; }
                set({ requestTopics: [{ id: `topic_${Math.random().toString(36).slice(2, 8)}`, name: '' }, ...topics] });
                setTimeout(() => document.getElementById('topic-0')?.querySelector('input')?.focus(), 0);
              }}><Plus /> Kind of request</Button>}>
              {!topics.length && <EmptyNote>None yet. Requests are still taken; they are just not labelled.</EmptyNote>}
              {topics.map((t, i) => (
                <Item key={t.id} id={`topic-${i}`} removeLabel="Remove kind of request" onRemove={() => set({ requestTopics: topics.filter((_, j) => j !== i) })}>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
                    <Field label="Name"><Input maxLength={60} value={t.name} disabled={!writable} placeholder="e.g. Boarding inquiry" onChange={(e) => set({ requestTopics: topics.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
                    <Field label="What to ask the caller" hint="Optional."><Input maxLength={300} value={t.collect ?? ''} disabled={!writable} placeholder="e.g. The dates, the pet, and whether vaccines are current" onChange={(e) => set({ requestTopics: topics.map((x, j) => (j === i ? { ...x, collect: e.target.value || undefined } : x)) })} /></Field>
                  </div>
                </Item>
              ))}
            </Section>
          </>
        )}
      </div>

      {writable && dirty && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur md:left-16 xl:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 md:px-8">
            <p className="text-sm text-text-muted">You have unsaved changes to fields.</p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setDraft(pick(config)); setIssues([]); }}>Discard</Button>
              <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
