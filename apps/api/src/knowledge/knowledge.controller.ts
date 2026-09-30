// SPDX-License-Identifier: AGPL-3.0-only
import type { KnowledgeBase } from '@attendra/core';
import { type Database, KnowledgeRepository, staffNames } from '@attendra/db';
import { type Answerer, answerQuestion, MAX_BYTES, sourceTypeOf } from '@attendra/knowledge';
import type { JobQueue } from '@attendra/worker/queue';
import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { KnowledgeAnswer, KnowledgeAsk, KnowledgeDocument, KnowledgeDocuments, KnowledgeUpload } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { DB, JOBS, KNOWLEDGE } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

type Knowledge = { base: KnowledgeBase; answerer: Answerer; embeddingModel?: string };
const isUuid = (s: string) => z.uuid().safeParse(s).success;

/**
 * The clinic's documents: policies, insurance lists, visit preparation, provider
 * bios, directions. The assistant answers from them, and only from them. Managers
 * upload and delete, audited; anyone who may read the settings can see the list and
 * ask a question to check what the assistant would say.
 */
@ApiTags('knowledge')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/knowledge')
export class KnowledgeController {
  private readonly repo: KnowledgeRepository;

  constructor(@Inject(DB) private readonly db: Database, @Inject(JOBS) private readonly jobs: JobQueue, @Inject(KNOWLEDGE) private readonly knowledge: Knowledge | null) {
    this.repo = new KnowledgeRepository(db);
  }

  @Get('documents')
  @Requires('settings:read')
  @ApiOperation({ summary: 'The clinic\'s documents, with their indexing status and chunk count' })
  @ApiOkResponse({ schema: schemaOf(KnowledgeDocuments) })
  async list(@Param('clinicId') clinicId: string): Promise<KnowledgeDocuments> {
    const docs = await this.repo.list(clinicId);
    const names = await staffNames(this.db, clinicId, docs.map((d) => d.uploadedByUserId));
    return { documents: docs.map((d) => this.view(d, names)) };
  }

  /**
   * Upload a document as the raw body (PDF, plain text or markdown, up to 5 MB), with
   * its title in the query. The same title replaces the document; the same bytes
   * again change nothing. Indexing happens in the worker.
   */
  @Post('documents')
  @HttpCode(201)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Upload a document (application/pdf, text/plain or text/markdown). Audited.' })
  @ApiConsumes('application/pdf', 'text/plain', 'text/markdown')
  @ApiCreatedResponse({ schema: schemaOf(KnowledgeDocument) })
  async upload(@Param('clinicId') clinicId: string, @Query(new ZodPipe(KnowledgeUpload)) q: z.infer<typeof KnowledgeUpload>, @Body() body: unknown, @Req() req: FastifyRequest, @CurrentStaff() staff: Staff) {
    // checked as the types they must be, whatever the parsers let through
    if (!(body instanceof Uint8Array) || body.byteLength === 0) throw new HttpException({ error: 'empty_file' }, 400);
    if (body.byteLength > MAX_BYTES) throw new HttpException({ error: 'too_large' }, 413);
    if (typeof q.title !== 'string' || typeof q.name !== 'string') throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: typeof q.title !== 'string' ? 'title' : 'name', message: 'required' }] });
    const content = Buffer.from(body);
    const type = sourceTypeOf(q.name || q.title, String(req.headers['content-type'] ?? '').split(';')[0]);
    if (!type) throw new HttpException({ error: 'unsupported_type', message: 'Upload a PDF, a text file or a markdown file.' }, 415);
    const saved = await this.repo.save(clinicId, { title: q.title, sourceType: type, content, userId: staff.userId, embeddingModel: this.knowledge?.embeddingModel });
    if (saved.changed) await this.jobs.indexDocument({ clinicId, documentId: saved.id, hash: saved.hash, version: saved.version });
    const doc = await this.repo.get(clinicId, saved.id);
    return this.view(doc!, await staffNames(this.db, clinicId, [doc!.uploadedByUserId]));
  }

  @Delete('documents/:documentId')
  @HttpCode(204)
  @Requires('settings:write')
  @ApiOperation({ summary: 'Delete a document and everything indexed from it. Audited.' })
  async remove(@Param('clinicId') clinicId: string, @Param('documentId') documentId: string, @CurrentStaff() staff: Staff) {
    if (!isUuid(documentId) || !(await this.repo.remove(clinicId, documentId, staff.userId))) throw new NotFoundException({ error: 'not_found' });
  }

  /**
   * What the assistant would answer, and the passages it would answer from. A medical
   * question is refused before anything is searched. Do not type patient details: the
   * question is embedded like a caller's.
   */
  @Post('ask')
  @HttpCode(200)
  @Requires('settings:read')
  @ApiOperation({ summary: 'Ask a question the way a caller would, and see the answer with its citations' })
  @ApiBody({ schema: schemaOf(KnowledgeAsk) })
  @ApiOkResponse({ schema: schemaOf(KnowledgeAnswer) })
  async ask(@Param('clinicId') clinicId: string, @Body(new ZodPipe(KnowledgeAsk)) body: z.infer<typeof KnowledgeAsk>): Promise<KnowledgeAnswer> {
    if (!this.knowledge) throw new HttpException({ error: 'knowledge_unavailable' }, 503);
    return answerQuestion(this.knowledge.base, this.knowledge.answerer, clinicId, body.question);
  }

  private view(d: Awaited<ReturnType<KnowledgeRepository['list']>>[number], names: Map<string, string>): KnowledgeDocument {
    return {
      id: d.id, title: d.title, sourceType: d.sourceType, sizeBytes: d.sizeBytes, status: d.status, failure: d.failure, chunkCount: d.chunkCount,
      uploadedBy: names.get(d.uploadedByUserId) ?? null, updatedAt: d.updatedAt.toISOString(),
    };
  }
}
