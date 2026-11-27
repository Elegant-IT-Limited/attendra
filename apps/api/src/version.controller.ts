// SPDX-License-Identifier: AGPL-3.0-only
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from './http/staff.guard';
import { type BuildInfo, buildInfo } from './version';

/** Which build this is, for the dashboard's footer and for anyone checking what is deployed. */
@ApiTags('version')
@Controller('version')
export class VersionController {
  // the tree does not change under a running process (dirty is as it was at start)
  private readonly info: BuildInfo = buildInfo();

  @Get()
  @Public()
  @ApiOperation({ summary: 'This build: the release version, the build number, the short commit and whether the tree had changes. No session needed; nothing secret.' })
  @ApiOkResponse({ schema: { type: 'object', properties: { version: { type: 'string' }, build: { type: ['integer', 'null'] }, commit: { type: 'string' }, dirty: { type: ['boolean', 'null'] } } } })
  version(): BuildInfo {
    return this.info;
  }
}
