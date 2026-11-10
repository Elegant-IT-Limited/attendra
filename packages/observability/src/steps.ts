// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What to do about each alert kind: the "Do:" at the end of its Slack line, so whoever is on call can act from the
 * phone without looking anything up. Every kind's step is here and nowhere else; a service never writes its own.
 * Short, plain, and the first step only: the runbook (P0 kinds) has the rest.
 */
const STEPS: Readonly<Record<string, string>> = {
  // calls
  call_dropped: 'open the call and read where it stopped; if the caller was cut off before they were helped, call them back.',
  call_failed: 'make one test call to the clinic number; if it fails too, read the voice logs (docker compose logs voice) and follow the runbook.',
  empty_call: 'open the call; the caller heard nothing, so call them back, then make one test call to check the line.',
  stalled_turn: 'open the call and read the turn before the silence; if the caller hung up waiting, call them back.',
  slow_answer: 'open the call and look at the slow turn; if it keeps happening, check status.openai.com.',
  answer_timeout: 'the caller was offered a callback: make sure the callback request is on Today, then open the call for the slow turn.',
  call_rejected: 'check the dialled number belongs to a clinic (back office) and is on the right Twilio trunk, then make one test call.',
  voice_error: 'read the voice logs around this time (docker compose logs voice); if it repeats, it needs a fix.',
  // texts
  text_failed: 'look up the Twilio error code (Console > Monitor > Messaging); 30007 or 30034 usually means the A2P registration.',
  text_blocked: 'nothing, unless the clinic expects texts abroad: the number was outside the US and Canada, or premium.',
  text_limit: 'check it is real use (the clinic\'s Calls and texts); raise the cap only if it is.',
  // jobs, live screens, Twilio set-up
  job_failed: 'read the worker logs for the job (docker compose logs worker); if a caller is waiting on a summary or a text, do it by hand.',
  change_notices_down: 'open screens refresh slowly until it is back; if it lasts, restart the api service at 0 live calls.',
  backup_route: 'check the trunk\'s disaster-recovery URL in Twilio Console; the worker tries again every 10 minutes.',
  spend_alerts: 'check the Twilio credentials in .env; the worker tries again at its next start.',
  // Vapi
  vapi_failed: 'open the location in the back office and save its Vapi set-up again; the Vapi dashboard shows the error.',
  vapi_control_failed: 'open the call; if a transfer failed, call the client back.',
  vapi_call_refused: 'the number still points at Vapi\'s trunk: move it back to the Attendra trunk in Twilio.',
  vapi_concurrency: 'nothing now (calls over the limit go to our own engine); if it keeps happening, buy more Vapi concurrency.',
  // money: when it runs out, calls stop
  openai_quota: 'top up the OpenAI project (platform.openai.com > Billing), check auto-reload is on, then make one test call.',
  twilio_balance_low: 'add funds in Twilio Console > Billing and turn auto-recharge on; calls and texts stop at $0.',
  twilio_balance_unread: 'check the Twilio credentials in .env; the balance is read again in an hour.',
  vapi_credit_low: 'add credit in the Vapi dashboard (Billing) and turn auto-reload on, or switch the location back to Attendra in the back office.',
  paging_test: 'nothing: this is a test of the alert path.',
};

/** Twilio's own spend lines (spend_sms, spend_totalprice...): one step for all of them. */
const SPEND_STEP = 'check Twilio Console > Usage for what is spending; a runaway (a loop, abuse) gets its number paused.';

/** The "Do:" step for a kind, or undefined for a kind with none. */
export function alertStep(kind: string): string | undefined {
  if (Object.hasOwn(STEPS, kind)) return STEPS[kind];
  return kind.startsWith('spend_') ? SPEND_STEP : undefined;
}

/** Every kind with a step, for the test that each alert raised in the code has one. */
export const ALERT_STEP_KINDS: readonly string[] = Object.keys(STEPS);
