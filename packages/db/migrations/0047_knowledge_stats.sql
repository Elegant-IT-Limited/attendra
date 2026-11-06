-- Attendra schema v47: how much text each knowledge document gave, so nothing is lost in silence.
--
-- Two PDFs of about 580 KB each came out as two chunks each, and the dashboard could not
-- say why. Kept per document by the indexer, from the extracted text:
--   extracted_chars  characters of text found (white space collapsed); 0 for a scan with no text
--   page_count       the PDF's pages; null for text and markdown, which have none
-- Settings shows both, and warns when a PDF has under 200 characters a page (a scan).
-- Null on documents indexed before this migration: `pnpm db:reindex-knowledge` queues them
-- again, and the indexer treats a document without them as not yet indexed with today's rules.
alter table knowledge_documents add column if not exists extracted_chars integer;
alter table knowledge_documents add column if not exists page_count integer;
alter table knowledge_documents add constraint knowledge_documents_extracted_chars_positive check (extracted_chars is null or extracted_chars >= 0);
alter table knowledge_documents add constraint knowledge_documents_page_count_positive check (page_count is null or page_count >= 0);
