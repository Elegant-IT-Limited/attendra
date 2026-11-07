// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Paging: the few alert kinds that must reach a phone, not only a Slack channel nobody
 * reads at night. Everything else stays a Slack line.
 *
 * The P0 kinds are listed here and nowhere else. A kind pages when it happens `after`
 * times within one alert window (15 minutes by default): one lost change feed is already
 * an outage, one empty call is not, three are. A kind pages at most once per
 * PAGE_COOLDOWN_MS while it keeps failing.
 */
export interface PageRule {
  /** How many of this kind within one alert window before someone is paged. */
  after: number;
  /** The runbook's name: `<ATTENDRA_RUNBOOK_URL>/<runbook>.md` says what to do. */
  runbook: string;
}

export const P0_KINDS: Readonly<Record<string, PageRule>> = {
  // no open screen hears of a new call, booking or request until it is back
  change_notices_down: { after: 1, runbook: 'change-notices-down' },
  // calls failing: set up and turned away, dropped mid-call, or a caller who never heard the assistant
  call_failed: { after: 3, runbook: 'calls-failing' },
  call_dropped: { after: 3, runbook: 'calls-failing' },
  empty_call: { after: 3, runbook: 'calls-failing' },
};

/** The rule for a kind, or undefined when it does not page. */
export const p0Rule = (kind: string): PageRule | undefined => (Object.hasOwn(P0_KINDS, kind) ? P0_KINDS[kind] : undefined);

/** A kind that keeps failing pages again after this long, not on every window. */
export const PAGE_COOLDOWN_MS = 60 * 60_000;

export interface Page {
  /** Which part of Attendra speaks: "voice", "worker", "api". */
  service: string;
  kind: string;
  text: string;
  /** The runbook, when ATTENDRA_RUNBOOK_URL is set. */
  link?: string;
}

/** Where a page goes: a push to the on-call phone. Never throws; a page that cannot be sent is the caller's warning. */
export interface Pager {
  readonly channel: string;
  page(p: Page): Promise<void>;
}

type Post = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<void>;

const defaultPost: Post = async (url, init) => {
  const res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`pager answered ${res.status}`);
};

/**
 * ntfy (ntfy.sh, or a server of your own): one HTTPS POST to a topic, which the ntfy app on
 * the on-call phone shows at the top priority, through Do Not Disturb if the app is allowed to.
 * The topic's address is the secret: anyone who knows it can read and post, so make it long
 * and random, or use an access token on a server that has them.
 */
export function ntfyPager(o: { url: string; token?: string; post?: Post }): Pager {
  const post = o.post ?? defaultPost;
  return {
    channel: 'ntfy',
    page: (p) => {
      const headers: Record<string, string> = {
        // header values must be plain ASCII
        Title: `Attendra P0: ${p.kind} (${p.service})`.replace(/[^\x20-\x7e]/g, '?'),
        Priority: 'urgent',
        Tags: 'rotating_light',
        ...(p.link ? { Click: p.link } : {}),
        ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
      };
      return post(o.url, { headers, body: p.link ? `${p.text}\nRunbook: ${p.link}` : p.text });
    },
  };
}

type Env = Record<string, string | undefined>;
type Warn = { warn(obj: object, msg: string): void };

/**
 * The pager the environment asks for, or null: paging is off until a channel is set.
 *   ATTENDRA_PAGER_NTFY_URL    https://ntfy.sh/<long random topic>, or a topic on your own server
 *   ATTENDRA_PAGER_NTFY_TOKEN  an access token, for a topic that needs one (optional)
 * A setting that is wrong turns paging off with a warning; it never stops the service.
 */
export function pagerFromEnv(env: Env, log?: Warn): Pager | null {
  const url = env.ATTENDRA_PAGER_NTFY_URL?.trim();
  if (!url) return null;
  if (!/^https:\/\/[^/\s]+\/[^\s]+$/.test(url)) {
    log?.warn({}, 'paging is off: ATTENDRA_PAGER_NTFY_URL must be an https:// topic address');
    return null;
  }
  return ntfyPager({ url, token: env.ATTENDRA_PAGER_NTFY_TOKEN?.trim() || undefined });
}

/** The runbook for a P0 kind, or undefined when the kind has none or no runbook address is set. */
export function runbookLink(base: string | undefined, kind: string): string | undefined {
  const rule = p0Rule(kind);
  // trailing slashes dropped by hand: a regex anchored after `/+` is slow on a long run of them (CodeQL js/polynomial-redos)
  let root = base?.trim();
  while (root?.endsWith('/')) root = root.slice(0, -1);
  return rule && root && /^https:\/\//.test(root) ? `${root}/${rule.runbook}.md` : undefined;
}
