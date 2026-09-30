// SPDX-License-Identifier: AGPL-3.0-only
import { type ApiKey, ApiKeyRepository, type Database, staffNames } from '@attendra/db';
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyCreated, ApiKeyInput, ApiKeys, type ApiKeyView } from '../contracts';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CLOCK, DB } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const isUuid = (s: string) => z.uuid().safeParse(s).success;

/**
 * Settings > API keys: keys for other AI agents to reach the front desk over MCP
 * (docs/mcp.md). Owners and managers make and revoke them; a key is shown once, and
 * only its hash is kept.
 */
@ApiTags('integrations')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/api-keys')
export class ApiKeysController {
  private readonly repo: ApiKeyRepository;
  constructor(@Inject(DB) private readonly db: Database, @Inject(CLOCK) private readonly now: () => Date) {
    this.repo = new ApiKeyRepository(db);
  }

  @Get()
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'The clinic\'s API keys: name, scopes, expiry, last use. Never the key.' })
  @ApiOkResponse({ schema: schemaOf(ApiKeys) })
  async list(@Param('clinicId') clinicId: string): Promise<ApiKeys> {
    const keys = await this.repo.list(clinicId);
    const names = await staffNames(this.db, clinicId, keys.map((k) => k.createdByUserId));
    return { keys: keys.map((k) => this.view(k, names)) };
  }

  @Post()
  @HttpCode(201)
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Make a key with scopes and an expiry. The response is the only time it is shown. Audited.' })
  @ApiBody({ schema: schemaOf(ApiKeyInput) })
  @ApiOkResponse({ schema: schemaOf(ApiKeyCreated) })
  async create(@Param('clinicId') clinicId: string, @Body(new ZodPipe(ApiKeyInput)) body: z.infer<typeof ApiKeyInput>, @CurrentStaff() staff: Staff): Promise<ApiKeyCreated> {
    const expiresAt = new Date(this.now().getTime() + body.expiresInDays * 86_400_000);
    const { id, key } = await this.repo.create(clinicId, { name: body.name, scopes: [...new Set(body.scopes)], expiresAt, userId: staff.userId });
    const made = (await this.repo.list(clinicId)).find((k) => k.id === id)!;
    return { apiKey: this.view(made, new Map([[staff.userId, staff.name]])), key };
  }

  @Delete(':keyId')
  @HttpCode(204)
  @Requires('integrations:manage')
  @ApiOperation({ summary: 'Revoke a key. It stops working at once. Audited.' })
  async revoke(@Param('clinicId') clinicId: string, @Param('keyId') keyId: string, @CurrentStaff() staff: Staff) {
    if (!isUuid(keyId) || !(await this.repo.revoke(clinicId, keyId, staff.userId))) throw new NotFoundException({ error: 'not_found' });
  }

  private view(k: ApiKey, names: Map<string, string>): ApiKeyView {
    return {
      id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, expiresAt: k.expiresAt.toISOString(), createdBy: names.get(k.createdByUserId) ?? null,
      createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null,
      status: k.revokedAt ? 'revoked' : k.expiresAt <= this.now() ? 'expired' : 'active',
    };
  }
}
