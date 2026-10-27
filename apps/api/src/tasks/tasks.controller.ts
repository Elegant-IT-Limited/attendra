// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, ClinicConfig, type EventSink, readCustomValues, zonedInstant } from '@attendra/core';
import { approvesRefills, type Database, type FrontDeskRepository, type PhiCipher, PostgresTaskQueue, requestAssignees, staffPeople, staffRole, taskFacts } from '@attendra/db';
import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, UnprocessableEntityException } from '@nestjs/common';
import { ApiBody, ApiConflictResponse, ApiCookieAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CustomFieldValues, NewTask, TaskAssign, TaskAssignees, TaskCount, TaskDone, TaskList, TaskNoteInput, TaskPlan, TaskQuery, TaskSearch, WaitingTasks } from '../contracts';
import { can } from '../access';
import { schemaOf } from '../http/openapi';
import { CurrentStaff, Requires, type Staff } from '../http/staff.guard';
import { CIPHER, DB, EVENTS, FRONT_DESK, JOBS } from '../http/tokens';
import { randomUUID } from 'node:crypto';
import type { JobQueue } from '@attendra/worker/queue';
import { ZodPipe } from '../http/zod.pipe';
import { avatarUrl } from '../me/avatar';

const iso = (d: Date | null) => d?.toISOString() ?? null;
/** Sent to the pharmacy, ready to pick up, or not approved: each one says a vet decided. */
const REFILL_DECISIONS = new Set<string>(['refill_sent', 'refill_ready', 'refill_declined']);
const isUuid = (s: string) => z.uuid().safeParse(s).success;

@ApiTags('tasks')
@ApiCookieAuth()
@ApiParam({ name: 'clinicId', example: 'clinic_maple' })
@Controller('clinics/:clinicId/tasks')
export class TasksController {
  constructor(@Inject(FRONT_DESK) private readonly desk: FrontDeskRepository, @Inject(DB) private readonly db: Database, @Inject(EVENTS) private readonly events: EventSink, @Inject(JOBS) private readonly jobs: JobQueue, @Inject(CIPHER) private readonly cipher: PhiCipher) {}

  /**
   * A request someone at the clinic writes down by hand, in the same queue as the
   * assistant's: a callback or a follow-up, with the number to call back on. Audited
   * under the person, and announced like any other request.
   */
  @Post()
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Write down a request by hand: a callback, a refill, a voicemail or a follow-up, with the number to call back on. Audited.' })
  @ApiBody({ schema: schemaOf(NewTask) })
  async create(@Param('clinicId') clinicId: string, @Body(new ZodPipe(NewTask)) body: z.infer<typeof NewTask>, @CurrentStaff() staff: Staff): Promise<{ id: string }> {
    const config = ClinicConfig.parse(await this.desk.settings(clinicId));
    const topic = body.topic ? config.requestTopics?.find((t) => t.name === body.topic)?.name : undefined;
    if (body.topic && !topic) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: 'topic', message: 'not one of the clinic\'s kinds of request' }] });
    const refill = body.type === 'refill';
    const details: Record<string, string> = {
      reason: body.reason, ...(topic ? { topic } : {}), ...(body.name ? { name: body.name } : {}), ...(body.callbackNumber ? { callback_number: body.callbackNumber } : {}),
      ...(refill && body.medication ? { medication: body.medication } : {}), ...(refill && body.pharmacy ? { pharmacy: body.pharmacy } : {}),
    };
    const task = await new PostgresTaskQueue(this.db, this.cipher, `user:${staff.userId}`).create(clinicId, { type: body.type, callId: null, patientId: null, idempotencyKey: `manual:${randomUUID()}`, details });
    if (body.urgent !== undefined || body.dueOn !== undefined) await this.desk.planTask(clinicId, task.id, { urgent: body.urgent, dueOn: body.dueOn }, staff.userId);
    await this.events.emit(clinicId, { type: 'request.created', key: task.id, data: { requestId: task.id, type: body.type, patientId: null, callId: null } });
    return { id: task.id };
  }

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
    // only people still on the team: a former member's name, role and picture are gone alike
    const people = await staffPeople(this.db, clinicId, tasks.flatMap((t) => [t.assigneeUserId, t.doneByUserId, t.createdByUserId, ...t.notes.map((n) => n.authorUserId)].filter((x): x is string => !!x)));
    const nameOf = (id: string | null) => (id ? people.get(id)?.name ?? null : null);
    const pictureOf = (id: string) => avatarUrl(id, people.get(id)?.avatarAt);
    return {
      tasks: tasks.map(({ assignedByUserId: _by, createdByUserId: by, notes, ...t }) => ({
        ...t, createdAt: t.createdAt.toISOString(), claimedAt: iso(t.claimedAt), doneAt: iso(t.doneAt),
        assigneeName: nameOf(t.assigneeUserId),
        doneByName: nameOf(t.doneByUserId),
        createdBy: by ? { name: nameOf(by), role: people.get(by)?.role ?? null, avatarUrl: pictureOf(by) } : null,
        notes: notes.map((n) => ({ id: n.id, author: nameOf(n.authorUserId), authorAvatarUrl: pictureOf(n.authorUserId), at: n.at.toISOString(), body: n.body })),
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
    const { tasks, total, byType } = await this.desk.waitingTasks(clinicId);
    return { tasks: tasks.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })), total, byType };
  }

  /**
   * The names in "Assign to": everyone who works requests, owners and the person asking
   * included. Its own route, not the Team list: that one is for managing people and
   * carries their email and sign-in, which handing over a request does not need.
   */
  @Get('assignees')
  @Requires('tasks:reassign')
  @ApiOperation({ summary: 'Who a request can be given to: everyone who works requests here, by name. Owners and managers.' })
  @ApiOkResponse({ schema: schemaOf(TaskAssignees) })
  async assignees(@Param('clinicId') clinicId: string, @CurrentStaff() staff: Staff): Promise<TaskAssignees> {
    return { people: (await requestAssignees(this.db, clinicId)).map(({ avatarAt, ...p }) => ({ ...p, you: p.userId === staff.userId, avatarUrl: avatarUrl(p.userId, avatarAt) })) };
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
  @ApiOperation({ summary: 'Close a request you hold, or one nobody holds, with what came of it. Closing a refill as sent to the pharmacy, ready to pick up or not approved needs a member marked as approving refills (403 refill_approval_required). Audited.' })
  @ApiBody({ schema: schemaOf(TaskDone), required: false })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'Someone else holds the task, or it is already done' })
  async done(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(TaskDone)) body: z.infer<typeof TaskDone>, @CurrentStaff() staff: Staff) {
    if (!isUuid(taskId)) this.outcome('not_found');
    // approving or declining a refill is a clinical decision: only someone marked for it on the Team page
    if (body.outcome && REFILL_DECISIONS.has(body.outcome) && (await taskFacts(this.db, clinicId, taskId))?.type === 'refill'
      && !(await approvesRefills(this.db, staff.userId, clinicId))) {
      throw new ForbiddenException({ error: 'refill_approval_required', message: 'Only a member marked as approving refills can do this.' });
    }
    this.outcome(await this.desk.completeTask(clinicId, taskId, staff.userId, body.outcome ?? null));
    const facts = await taskFacts(this.db, clinicId, taskId);
    // the caller hears what the team decided: ready to pick up, sent to the pharmacy, or please call us
    if (body.outcome && REFILL_DECISIONS.has(body.outcome) && facts?.type === 'refill') await this.jobs.requestReady({ clinicId, taskId });
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

  @Put(':taskId/fields')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'The clinic\'s own details on a request (Settings, Fields and lists): the whole set, checked against the fields. Stored encrypted; audited without the values.' })
  @ApiBody({ schema: schemaOf(CustomFieldValues) })
  @ApiNoContentResponse()
  async fields(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(CustomFieldValues)) body: z.infer<typeof CustomFieldValues>, @CurrentStaff() staff: Staff) {
    if (!isUuid(taskId)) this.outcome('not_found');
    const config = ClinicConfig.parse(await this.desk.settings(clinicId));
    const read = readCustomValues(config.requestFields ?? [], body.values, { complete: true });
    if (!read.ok) throw new UnprocessableEntityException({ error: 'invalid_request', issues: [{ path: `values.${read.field}`, message: read.message }] });
    if ((await this.desk.setTaskFields(clinicId, taskId, read.values, staff.userId)) === 'not_found') this.outcome('not_found');
  }

  @Post(':taskId/plan')
  @HttpCode(204)
  @Requires('tasks:work')
  @ApiOperation({ summary: 'Mark an open request urgent or not, and set or clear the day it is due. Audited.' })
  @ApiBody({ schema: schemaOf(TaskPlan) })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: 'The request is already done' })
  async plan(@Param('clinicId') clinicId: string, @Param('taskId') taskId: string, @Body(new ZodPipe(TaskPlan)) body: z.infer<typeof TaskPlan>, @CurrentStaff() staff: Staff) {
    this.outcome(isUuid(taskId) ? await this.desk.planTask(clinicId, taskId, body, staff.userId) : 'not_found');
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

  private outcome(result: 'claimed' | 'done' | 'released' | 'added' | 'assigned' | 'planned' | 'taken' | 'not_found') {
    if (result === 'not_found') throw new NotFoundException({ error: 'not_found' });
    if (result === 'taken') throw new ConflictException({ error: 'task_taken', message: 'Someone else holds this request, or it is already done.' });
  }
}
