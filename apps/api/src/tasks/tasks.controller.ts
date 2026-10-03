// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, type EventSink, zonedInstant } from '@attendra/core';
import { type Database, type FrontDeskRepository, staffNames, staffRole, taskFacts } from '@attendra/db';
import { Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { TaskAssign, TaskCount, TaskDone, TaskList, TaskNoteInput, TaskQuery, TaskSearch, WaitingTasks } from '../contracts';
import { can } from '../access';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { DB, EVENTS, FRONT_DESK } from '../http/tokens';
import { ZodPipe } from '../http/zod.pipe';

const iso = (d: Date | null) => d?.toISOString() ?? null;
const isUuid = (s: string) => z.uuid().safeParse(s).success;

@ApiTags('tasks')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/tasks')
export class TasksController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(DB) private readonly db: Database, @Inject(EVENTS) private readonly events: EventSink) {}

  @Get()
  @Requires('tasks:read')
  @ApiOperation({ summary: 'The request queue (refills, callbacks, new patients to check), newest first, filtered by type, by who has them, by the day they came in, and by words in them. Audited per request shown.' })
  @ApiOkResponse({ schema: schemaOf(TaskList) })
  async list(@Param('clinicId') clinicId: string, @Query(new ZodPipe(TaskQuery)) q: z.infer<typeof TaskQuery>, @CurrentStaff() staff: Staff): Promise<TaskList> {
    return this.find(clinicId, { ...q, q: '' }, staff);
  }

  /** A POST, not a GET: what is typed can be a name, a medication or a phone number, and URLs end up in logs. */
  @Post('search')
  @HttpCode(200)
  @Requires('tasks:read')
  @ApiOperation({ summary: 'The request queue with words to find in the patient\'s name, the details or the type, from the first character. Audited per request shown, never by what was typed.' })
  @ApiBody({ schema: schemaOf(TaskSearch) })
  @ApiOkResponse({ schema: schemaOf(TaskList) })
  async search(@Param('clinicId') clinicId: string, @Body(new ZodPipe(TaskSearch)) q: z.infer<typeof TaskSearch>, @CurrentStaff() staff: Staff): Promise<TaskList> {
    return this.find(clinicId, q, staff);
  }

  private async find(clinicId: string, q: z.infer<typeof TaskSearch>, staff: Staff): Promise<TaskList> {
    const assignee = q.assignee === 'me' ? { userId: staff.userId } : q.assignee;
    // the days are the clinic's own, whatever zone the server or the browser is in
    const tz = q.from || q.to ? ClinicConfig.parse(await this.desk.settings(clinicId)).timezone : null;
    const tasks = await this.desk.listTasks(clinicId, {
      status: q.status, type: q.type, assignee, limit: 100, q: q.q || undefined,
      from: q.from && tz ? zonedInstant(q.from, '00:00', tz) : undefined,
      to: q.to && tz ? zonedInstant(addDays(q.to, 1), '00:00', tz) : undefined,
    }, staff.userId);
    const names = await staffNames(this.db, clinicId, tasks.flatMap((t) => [t.assigneeUserId, t.doneByUserId, ...t.notes.map((n) => n.authorUserId)].filter((x): x is string => !!x)));
    return {
      tasks: tasks.map(({ assignedByUserId: _by, notes, ...t }) => ({
        ...t, createdAt: t.createdAt.toISOString(), claimedAt: iso(t.claimedAt), doneAt: iso(t.doneAt),
        assigneeName: t.assigneeUserId ? names.get(t.assigneeUserId) ?? null : null,
        doneByName: t.doneByUserId ? names.get(t.doneByUserId) ?? null : null,
        notes: notes.map((n) => ({ id: n.id, author: names.get(n.authorUserId) ?? null, at: n.at.toISOString(), body: n.body })),
      })),
    };
  }

  @Get('count')
  @Requires('tasks:read')
  @ApiOperation({ summary: 'How many tasks are open. No patient data, not audited.' })
  @ApiOkResponse({ schema: schemaOf(TaskCount) })
  async count(@Param('clinicId') clinicId: string): Promise<TaskCount> {
    return { open: await this.desk.openTaskCount(clinicId) };
  }

  @Get('waiting')
  @Requires('tasks:read')
  @ApiOperation({ summary: 'Open tasks nobody has claimed, newest first: type and age only, for the home screen. No patient data, not audited.' })
  @ApiOkResponse({ schema: schemaOf(WaitingTasks) })
  async waiting(@Param('clinicId') clinicId: string): Promise<WaitingTasks> {
    const { tasks, total } = await this.desk.waitingTasks(clinicId);
    return { tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })), total };
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
  @ApiOperation({ summary: 'Close a request you hold, or one nobody holds, with what came of it. Audited.' })
  @ApiBody({ schema: schemaOf(TaskDone), required: false })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Someone else holds the task, or it is already done' })
  async done(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(TaskDone)) body: z.infer<typeof TaskDone>, @CurrentStaff() staff: Staff) {
    this.outcome(isUuid(taskId) ? await this.desk.completeTask(clinicId, taskId, staff.userId, body.outcome ?? null) : 'not_found');
    const facts = await taskFacts(this.db, clinicId, taskId);
    if (facts) await this.events.emit(clinicId, { type: 'request.done', key: taskId, data: facts });
  }

  @Post(':taskId/notes')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Add an internal note to a request. Stored encrypted; notes are never edited. Audited.' })
  @ApiBody({ schema: schemaOf(TaskNoteInput) })
  @ApiNoContentResponse()
  async note(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(TaskNoteInput)) body: z.infer<typeof TaskNoteInput>, @CurrentStaff() staff: Staff) {
    this.outcome(isUuid(taskId) ? await this.desk.addTaskNote(clinicId, taskId, staff.userId, body.body) : 'not_found');
  }

  @Post(':taskId/assign')
  @HttpCode(204)
  @Requires('tasks:reassign')
  @ApiOperation({ summary: 'Give an open request to a teammate who works the front desk. Owners and managers. Audited.' })
  @ApiBody({ schema: schemaOf(TaskAssign) })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'The request is already done' })
  async assign(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(TaskAssign)) body: z.infer<typeof TaskAssign>, @CurrentStaff() staff: Staff) {
    const role = await staffRole(this.db, body.userId, clinicId);
    if (!role || role === 'viewer') throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'userId', message: 'assign requests to someone who works the front desk here' }] });
    this.outcome(isUuid(taskId) ? await this.desk.assignTask(clinicId, taskId, body.userId, staff.userId) : 'not_found');
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

  private outcome(result: 'claimed' | 'done' | 'released' | 'added' | 'assigned' | 'taken' | 'not_found') {
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result === 'taken') throw new ConflictException({ error: 'task_taken', message: 'Someone else holds this request, or it is already done.' });
  }
}
