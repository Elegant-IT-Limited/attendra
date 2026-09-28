// SPDX-License-Identifier: AGPL-3.0-only
import type { FrontDeskRepository } from '@attendra/db';
import { ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiConflictResponse, ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { TaskCount, TaskList, TaskQuery } from '../contracts';
import { can } from '../access';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isUuid = (s: string) => z.uuid().safeParse(s).success;

@ApiTags('tasks')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/tasks')
export class TasksController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository) {}

  @Get()
  @Requires('tasks:read')
  @ApiOperation({ summary: 'The callback and refill queue. Open tasks oldest first, done tasks newest first. Audited per task.' })
  @ApiOkResponse({ schema: schemaOf(TaskList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(TaskQuery)) q: z.infer<typeof TaskQuery>, @CurrentStaff() staff: Staff): Promise<TaskList> {
    const tasks = await this.desk.listTasks(clinicId, { status: q.status, limit: 100 }, staff.userId);
    return { tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), claimedAt: iso(t.claimedAt), doneAt: iso(t.doneAt) })) };
  }

  @Get('count')
  @Requires('tasks:read')
  @ApiOperation({ summary: 'How many tasks are open. No patient data, not audited.' })
  @ApiOkResponse({ schema: schemaOf(TaskCount) })
  async count(@Param('clinicId') clinicId: string): Promise<TaskCount> {
    return { open: await this.desk.openTaskCount(clinicId) };
  }

  @Post(':taskId/claim')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Take a task, so nobody else calls the same patient back' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Someone else holds the task, or it is already done' })
  async claim(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @CurrentStaff() staff: Staff) {
    this.outcome(isUuid(taskId) ? await this.desk.claimTask(clinicId, taskId, staff.userId) : 'not_found');
  }

  @Post(':taskId/done')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Close a task you hold, or one nobody holds' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Someone else holds the task, or it is already done' })
  async done(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @CurrentStaff() staff: Staff) {
    this.outcome(isUuid(taskId) ? await this.desk.completeTask(clinicId, taskId, staff.userId) : 'not_found');
  }

  @Post(':taskId/release')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Give a task back to the queue. Owners and admins can release anyone\'s.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'You do not hold the task, or it is not claimed' })
  async release(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @CurrentStaff() staff: Staff) {
    const override = !!staff.role && can(staff.role, 'tasks:reassign');
    this.outcome(isUuid(taskId) ? await this.desk.releaseTask(clinicId, taskId, staff.userId, override) : 'not_found');
  }

  private outcome(result: 'claimed' | 'done' | 'released' | 'taken' | 'not_found') {
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result === 'taken') throw new ConflictException({ error: 'task_taken', message: 'Someone else holds this task, or it is already done.' });
  }
}
