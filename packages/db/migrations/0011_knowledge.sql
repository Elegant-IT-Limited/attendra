-- Attendra schema v11: the clinic's own documents, for the assistant to answer from.
--
-- Clinic policies, insurance lists, visit preparation, provider bios and directions:
-- never patient data (decision 0008). A document is kept whole, so it can be indexed
-- again with another embedding model, and split into chunks with an embedding
-- (pgvector, HNSW) and a full-text vector for hybrid search. The 'simple' text
-- configuration does no stemming, so it works the same for every language a clinic
-- writes in.

create extension if not exists vector;

create table knowledge_documents (
  id                  uuid primary key default gen_random_uuid(),
  clinic_id           text not null references clinics(id),
  title               text not null check (length(title) between 1 and 200),
  source_type         text not null check (source_type in ('text', 'markdown', 'pdf')),
  content             bytea not null check (octet_length(content) <= 5 * 1024 * 1024),
  content_hash        text not null,
  size_bytes          integer not null,
  status              text not null default 'queued' check (status in ('queued', 'indexing', 'ready', 'failed')),
  failure             text, -- a code, never text from the document
  chunk_count         integer not null default 0,
  -- what the chunks were made from and with; a new upload or a new model means indexing again
  indexed_hash        text,
  embedding_model     text,
  uploaded_by_user_id text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (clinic_id, title),
  unique (clinic_id, id)
);

create table knowledge_chunks (
  id          bigserial primary key,
  clinic_id   text not null,
  document_id uuid not null,
  ordinal     integer not null,
  heading     text,
  body        text not null,
  token_count integer not null,
  embedding   vector(1536) not null,
  model       text not null,
  tsv         tsvector generated always as (to_tsvector('simple', coalesce(heading, '') || ' ' || body)) stored,
  foreign key (clinic_id, document_id) references knowledge_documents (clinic_id, id) on delete cascade
);
create index knowledge_chunks_document on knowledge_chunks (clinic_id, document_id, ordinal);
create index knowledge_chunks_embedding on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index knowledge_chunks_tsv on knowledge_chunks using gin (tsv);

do $$ declare t text; begin
  foreach t in array array['knowledge_documents', 'knowledge_chunks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_clinic on %I using (clinic_id = current_setting(''app.clinic_id'', true)) with check (clinic_id = current_setting(''app.clinic_id'', true))',
      t, t);
  end loop;
end $$;
grant select, insert, update, delete on knowledge_documents, knowledge_chunks to attendra_app;
grant usage, select on sequence knowledge_chunks_id_seq to attendra_app;
