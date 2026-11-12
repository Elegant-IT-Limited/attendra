// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import type { KnowledgeAnswer, KnowledgeDocument, KnowledgeDocuments } from '@attendra/api/contracts';
import { isWordFile, UNSUPPORTED_UPLOAD } from '@attendra/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Search, Trash2, Upload } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { SettingsHeader, SettingsIntro } from '@/components/settings/settings-nav';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Panel } from '@/components/ui/dialog';
import { Alert, Empty, Skeleton } from '@/components/ui/feedback';
import { Input, Label } from '@/components/ui/input';
import { Table, TD, TH, THead, TRow } from '@/components/ui/table';
import { useProblem, useToast } from '@/components/ui/toast';
import { usePets } from '@/lib/terms';
import { api, ApiFailure, useClinic } from '@/lib/api';
import { clinicTime } from '@/lib/format';
import { documentStats, looksScanned } from '@/lib/knowledge';
import { SAFETY_POLL_MS } from '@/lib/changes';

const MAX = 5 * 1024 * 1024;
const TYPES: Record<string, string> = { pdf: 'PDF', markdown: 'Markdown', text: 'Text' };
const STATUS: Record<KnowledgeDocument['status'], { label: string; tone: BadgeTone }> = {
  queued: { label: 'Waiting', tone: 'neutral' }, indexing: { label: 'Indexing', tone: 'info' }, ready: { label: 'Ready', tone: 'ok' }, failed: { label: 'Failed', tone: 'danger' },
};
const FAILURES: Record<string, string> = {
  pdf_unreadable: 'The PDF could not be read. Is it a scan? Upload the text instead.', not_a_pdf: 'The file is not a PDF.', empty: 'There is no text in it.',
  chunk_too_long: 'It could not be split into parts. Upload it as plain text.',
  too_large: 'It is over 5 MB.', too_many_chunks: 'It is too long. Split it into smaller documents.', not_text: 'It is not a text file.',
  too_many_pages: 'It has more than 200 pages. Split it into smaller documents.', too_much_text: 'It has more than 2 MB of text. Split it into smaller documents.',
  pdf_timeout: 'The PDF took too long to read. Try saving it again as a simpler PDF, or upload the text.', pdf_too_complex: 'The PDF is too complex to read. Upload the text instead.',
};
const mediaType = (f: File) => f.type || (f.name.endsWith('.md') ? 'text/markdown' : f.name.endsWith('.pdf') ? 'application/pdf' : 'text/plain');
// a PDF with no text at all is most likely a scan: say so, instead of only "no text"
const failureOf = (d: KnowledgeDocument) => (d.failure === 'empty' && d.sourceType === 'pdf' ? 'No text was found in it: is it a scan? Upload the text instead.' : FAILURES[d.failure!] ?? 'It could not be indexed. Try uploading it again.');
const NOT_CLINIC = 'This doesn\'t look like clinic information: callers may hear it. Upload anyway?';
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Settings > Knowledge: the clinic's own documents, which the assistant answers from.
 * Upload, see each document's status, delete, and ask a question the way a caller
 * would to check the answer and where it came from.
 */
export default function Knowledge() {
  const { clinicId } = useParams<{ clinicId: string }>();
  const { clinic, can } = useClinic(clinicId);
  const pets = usePets(clinicId);
  const queries = useQueryClient();
  const toast = useToast();
  const writable = can('settings:write');
  const docs = useQuery({
    queryKey: ['knowledge', clinicId],
    queryFn: () => api<KnowledgeDocuments>(`/clinics/${clinicId}/knowledge/documents`),
    // a document's progress arrives on the change stream ('knowledge'); while one is being indexed, a slow safety check too
    refetchInterval: (q) => (q.state.data?.documents.some((d) => d.status === 'queued' || d.status === 'indexing') ? SAFETY_POLL_MS : false),
  });
  const file = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<File | null>(null);
  // what did not work opens in a dialog, wherever the page is scrolled
  const showProblem = useProblem();
  const setProblem = (message: string | null) => { if (message) showProblem({ title: 'Not uploaded', message }); };
  const [removing, setRemoving] = useState<KnowledgeDocument | null>(null);
  // an upload that does not read like clinic information waits here for a yes or a no
  const [unsure, setUnsure] = useState<File | null>(null);
  const [question, setQuestion] = useState('');

  const upload = useMutation({
    mutationFn: ({ f, confirm }: { f: File; confirm?: boolean }) => api<KnowledgeDocument>(`/clinics/${clinicId}/knowledge/documents?${new URLSearchParams({ title: title.trim() || f.name.replace(/\.[^.]+$/, ''), name: f.name, ...(confirm ? { confirm: 'true' } : {}) })}`, {
      method: 'POST', body: f, headers: { 'content-type': mediaType(f) },
    }),
    onSuccess: () => {
      setTitle(''); setChosen(null); setUnsure(null); if (file.current) file.current.value = '';
      void queries.invalidateQueries({ queryKey: ['knowledge', clinicId] });
      toast({ tone: 'success', message: 'Uploaded. It is being indexed.' });
    },
    onError: (e, { f }) => e instanceof ApiFailure && e.status === 409 && e.body.error === 'not_clinic_information' ? setUnsure(f) : setProblem(e instanceof ApiFailure && e.status === 415 ? UNSUPPORTED_UPLOAD : e instanceof ApiFailure && e.status === 413 ? 'The file is over 5 MB.'
      : e instanceof ApiFailure && e.body.error === 'empty_file' ? 'The file is empty. Choose one with the text in it.'
      : e instanceof ApiFailure && e.body.error === 'too_many_documents' ? 'You have 50 documents, the most a clinic can keep. Delete one, or upload with the same title to replace it.' : 'The upload did not work. Try again.'),
  });
  const remove = useMutation({
    mutationFn: (d: KnowledgeDocument) => api<void>(`/clinics/${clinicId}/knowledge/documents/${d.id}`, { method: 'DELETE' }),
    onSuccess: () => { setRemoving(null); void queries.invalidateQueries({ queryKey: ['knowledge', clinicId] }); toast({ tone: 'success', message: 'Deleted. The assistant no longer answers from it.' }); },
    // gone already (someone else deleted it) is what was asked for; anything else says so, under its own title
    onError: (e) => {
      if (e instanceof ApiFailure && e.status === 404) { setRemoving(null); void queries.invalidateQueries({ queryKey: ['knowledge', clinicId] }); return; }
      setRemoving(null);
      showProblem({ title: 'Not removed', message: e instanceof ApiFailure && e.status === 403 ? 'Your role at this clinic cannot delete documents. Ask the clinic\'s owner.' : 'That document could not be removed. Try again.' });
    },
  });
  const ask = useMutation({
    mutationFn: (q: string) => api<KnowledgeAnswer>(`/clinics/${clinicId}/knowledge/ask`, { method: 'POST', body: JSON.stringify({ question: q }) }),
    onError: () => showProblem({ title: 'No answer', message: 'The question did not reach the assistant. Try again.' }),
  });
  const tz = clinic?.timezone ?? 'UTC';

  const choose = (f: File | null) => {
    setProblem(null);
    if (f && f.size > MAX) { setProblem('The file is over 5 MB.'); setChosen(null); return; }
    // a Word file is refused at once, with the way through, not after an upload that cannot work (note 52 C15)
    if (f && isWordFile(f.name)) { setProblem(UNSUPPORTED_UPLOAD); setChosen(null); if (file.current) file.current.value = ''; return; }
    setChosen(f);
    if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  return (
    <>
      <SettingsHeader clinicId={clinicId} />
      <SettingsIntro>What the assistant knows about the clinic, from your own documents. It answers only from them, and says so when they do not answer a question.</SettingsIntro>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {writable && (
            <Card>
              <CardHeader><CardTitle>Add a document</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <Alert tone="warn">{pets ? 'Clinic information only: policies, prices, visit preparation, vet bios, directions. Never upload anything about a client or a pet.' : 'Clinic information only: policies, insurance, visit preparation, provider bios, directions. Never upload anything about a patient.'}</Alert>
                <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); if (chosen) upload.mutate({ f: chosen }); }}>
                  <div className="space-y-1.5"><Label htmlFor="doc-title">Title</Label><Input id="doc-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Parking and directions" /></div>
                  <div className="space-y-1.5">
                    <Label htmlFor="doc-file">File</Label>
                    <Input id="doc-file" ref={file} type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" onChange={(e) => choose(e.target.files?.[0] ?? null)} className="py-1 file:mr-3 file:h-7 file:cursor-pointer file:rounded-sm file:border-0 file:bg-surface-sunken file:px-3 file:text-sm file:font-medium file:text-text" />
                  </div>
                  <Button type="submit" disabled={!chosen} loading={upload.isPending}><Upload /> Upload</Button>
                </form>
                <p className="text-xs text-text-muted">PDF, text or markdown, up to 5 MB. A document with the same title replaces the old one.</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>Documents</CardTitle></CardHeader>
            {docs.isPending ? <div className="space-y-3 p-5"><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
              : docs.isError ? <Alert tone="danger" className="m-5">The documents did not load.</Alert>
                : !docs.data.documents.length ? <Empty title="No documents yet" icon={<FileText />}>The assistant answers clinic questions from the FAQ until you add documents.</Empty> : (
                  <Table label="Documents">
                    <THead><tr><TH>Title</TH><TH>Status</TH><TH className="hidden md:table-cell">Added</TH>{writable && <TH><span className="sr-only">Delete</span></TH>}</tr></THead>
                    <tbody>
                      {docs.data.documents.map((d) => (
                        <TRow key={d.id} data-testid="knowledge-document">
                          <TD>
                            <p className="font-medium">{d.title}</p>
                            <p className="text-xs text-text-muted">{TYPES[d.sourceType]}, {size(d.sizeBytes)}</p>
                            {/* what was read from it, so a document that came out small says so */}
                            {documentStats(d) && <p className="text-xs tabular-nums text-text-muted" data-testid="knowledge-stats">{documentStats(d)}</p>}
                          </TD>
                          <TD>
                            <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                            {d.failure && <p className="mt-1 max-w-56 text-xs text-text-muted">{failureOf(d)}</p>}
                            {!d.failure && looksScanned(d) && <p className="mt-1 max-w-56 text-xs text-warn" data-testid="knowledge-scan">Little text was found: is this a scan? Callers hear only the text in it.</p>}
                          </TD>
                          <TD className="hidden text-sm text-text-muted md:table-cell">{clinicTime(d.updatedAt, tz)}{d.uploadedBy ? `, ${d.uploadedBy}` : ''}</TD>
                          {writable && <TD className="text-right"><Button size="sm" variant="ghost" aria-label={`Delete ${d.title}`} onClick={() => setRemoving(d)}><Trash2 /></Button></TD>}
                        </TRow>
                      ))}
                    </tbody>
                  </Table>
                )}
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader><CardTitle>Ask a question</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-text-muted">Ask the way a caller would, to see what the assistant would answer and where it comes from. Do not type {pets ? 'client or pet details' : 'patient details'}.</p>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (question.trim().length >= 2) ask.mutate(question.trim()); }}>
              <Input aria-label="Question" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} placeholder="Where do I park?" className="flex-1" />
              <Button type="submit" variant="outline" loading={ask.isPending} disabled={question.trim().length < 2}><Search /> Ask</Button>
            </form>
            {ask.data && (
              <div className="space-y-3" data-testid="knowledge-answer">
                <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
                  <p className="text-xs text-text-muted">The assistant would say</p>
                  <p className="mt-1 text-base">{ask.data.answer}</p>
                </div>
                {ask.data.refusal === 'medical' && <p className="text-xs text-text-muted">A medical question is refused before any document is searched.</p>}
                {ask.data.refusal === 'off_topic' && <p className="text-xs text-text-muted">The assistant answers questions about the clinic only, and never says how it is built. Nothing was searched.</p>}
                {ask.data.refusal === 'no_information' && <p className="text-xs text-text-muted">No document answers this. Add one, or an FAQ entry, if callers ask it.</p>}
                {/* sources only beside an answer read from them: never beside a refusal */}
                {ask.data.refusal === null && ask.data.citations.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-text-muted">From</p>
                    <ol className="space-y-2">
                      {ask.data.citations.map((c, i) => (
                        <li key={i} className="rounded-md border border-border px-3 py-2 text-sm" data-testid="knowledge-citation">
                          <p className="font-medium">{c.title}</p>
                          <p className="mt-1 line-clamp-4 whitespace-pre-line text-text-muted">{c.text}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Panel open={!!unsure} onOpenChange={(o) => !o && setUnsure(null)} title="Upload anyway?"
        description={NOT_CLINIC}
        footer={<><Button variant="outline" onClick={() => setUnsure(null)}>Cancel</Button><Button loading={upload.isPending} onClick={() => unsure && upload.mutate({ f: unsure, confirm: true })}>Upload anyway</Button></>}>
        <p className="text-sm text-text-muted">Whatever is uploaded here, the assistant may read to a caller. Keep to clinic information: hours, prices, policies, services, directions, the {pets ? 'vets' : 'doctors'}, visit preparation.</p>
      </Panel>
      <Panel open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Delete ${removing?.title ?? 'this document'}?`}
        description="The assistant stops answering from it at once. This is recorded in the audit log."
        footer={<><Button variant="outline" onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Delete</Button></>}>
        <p className="text-sm text-text-muted">To change a document, upload the new version with the same title instead.</p>
      </Panel>
    </>
  );
}
