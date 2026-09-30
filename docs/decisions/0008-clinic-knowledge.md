# 8. The assistant answers from the clinic's own documents, and only from them

**Status:** accepted, 2026-09-30

Callers ask about parking, insurance, how to prepare for a visit, which doctor sees children. The FAQ in Settings answers the common ones in the clinic's words. Clinics also have documents that say more: a parking and directions page, an insurance list, a preparation leaflet, provider bios. We let a practice manager upload those, and the assistant answers from them.

## What may be uploaded

Clinic information only: policies, insurance lists, visit preparation, provider bios, directions and opening arrangements. Never patient data: no referral letters, no lab results, no lists of patients. The upload form says so, and so does this record.

The reason is where the text goes. A document is split into chunks, and each chunk is sent to the embedding model and stored with its embedding, in clear, so that it can be searched. That is acceptable for a parking page and not for anything about a person. Documents are not encrypted like the PHI columns, because they hold no PHI; they are kept per clinic behind Row Level Security like every clinic row, and uploads and deletes are audited (`knowledge.document.uploaded`, `knowledge.document.deleted`).

A caller's question is embedded too, to search with. The planner is told to search with a short topic ("parking", "fasting before blood work") and never a name or other personal detail, and the tool's description says the same. That is an instruction to a model, not a guarantee, which is one more reason the documents themselves must never hold patient data: a question can only ever be matched against clinic information.

## How answers are grounded and cited

- Uploads are PDF, plain text or markdown, up to 5 MB. The worker extracts the text (unpdf for PDFs), splits it by heading and paragraph into chunks of about 500 tokens that share their edge paragraph with their neighbours, embeds them, and swaps them in for the document's old chunks in one transaction. Indexing is idempotent per content hash: the same bytes uploaded twice are one job and one set of chunks.
- Search is hybrid. The vector search's top 20 (pgvector, HNSW, cosine distance) and the full-text search's top 20 (a `tsvector` with the `simple` configuration, so every language works the same, with prefix matching) are fused by reciprocal rank fusion, and the best 4 are kept. Full text finds exact words (Cigna, Suite 3); vectors find paraphrases. A vector match further than the model's distance ceiling is dropped, and stop words in the caller's languages are ignored, so a question with nothing in common with the documents finds nothing.
- The planner gets the passages with their document titles from `search_knowledge` (and from `get_clinic_info`, after the FAQ). It is told to answer only from them, in a sentence or two, and when they are empty the tool tells it to say exactly: "I don't have that information, I can have someone call you back." Settings > Knowledge has an Ask a question box that shows the answer the assistant would give and the passages it came from, so a manager can check a document before a caller relies on it.

## How the assistant refuses anything medical

A question that asks for dosing, whether to take or stop a medicine, side effects, interactions or what a result means is refused in code, before anything is searched: `isMedicalQuestion` in `packages/core/src/medical.ts` is a phrase list in English and Spanish, like the emergency guardrail, and errs toward refusing. `search_knowledge` and `get_clinic_info` both return `medical_question` for it, with the line "I can't give medical advice, but I can have someone from the care team call you back." So a document that mentions metformin can never become an answer about how much metformin to take. The planner's rules and the answer instructions say the same, but the code is what holds. An eval proves it with a document that names the medication.

## Storage and cost

Chunks live in Postgres, next to everything else, in `knowledge_chunks` with a `vector(1536)` column and an HNSW index. Compose uses the `pgvector/pgvector:pg16` image; the extension is created by the migration. There is no separate vector database to run or secure.

Embedding uses `text-embedding-3-small` by default (`ATTENDRA_EMBEDDING_MODEL`), at 1,536 dimensions. A document's cost is its length in tokens: a ten-page policy is roughly 5,000 tokens. Indexing is capped at 400 chunks per document (about 200,000 tokens), and each request has a timeout. A question costs the embedding of a few words. Answers in the Ask a question box use the backend model with a 200-token ceiling. Check OpenAI's current prices for what these come to: embedding is priced per token, and a clinic's documents are short.

Without an OpenAI key, every part of the system uses a local embedder that hashes words and word pairs into the same 1,536 dimensions. It knows nothing about meaning, but together with full text it answers the demo's questions, costs nothing, and gives the tests and evals fixed embeddings. Each chunk records the model that embedded it, and search only compares vectors from the same model: switch models and documents must be indexed again (upload them again, or re-queue them).

## What we gave up

Scanned PDFs are not read: there is no OCR. A PDF with no text layer fails with `pdf_unreadable`, and the manager is told to upload the text. Tables and multi-column layouts come out as extracted text, which is good enough for policies and poor for spreadsheets. The assistant cannot combine a document with a patient's own record ("is my insurance on file?"); that stays with the front desk.
