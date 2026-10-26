#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/* global process, console */
/**
 * Keeps real people out of this public repo: every tracked text file, and on a pull
 * request its title, body and commit messages, are checked for phone numbers that are
 * not the fictional 555-0100 to 555-0199, email addresses outside the made-up domains,
 * real-looking OpenAI project ids, and the words of a private list (the PRIVACY_DENYLIST
 * secret: names, clinics, numbers and places from real test calls). CI logs are public,
 * so a finding is printed as a place and a rule, never with the text it matched.
 *
 *   PRIVACY_DENYLIST="$(cat path/to/denylist.txt)" node scripts/privacy-check.mjs
 *
 * In CI on a pull request: PR_TITLE, PR_BODY, BASE_SHA and HEAD_SHA add the pull
 * request's own text. Without PRIVACY_DENYLIST (a fork's pull request) only the public
 * rules run, and it says so.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// the words of the rule written so that this file does not trip it; and no text in that script at all (U+0980 to U+09FF)
const REGION_WORDS = ['Bang' + 'la', 'Beng' + 'ali', 'Dha' + 'ka', 'Dhan' + 'mondi'];
const REGION = new RegExp(`(?<![\\p{L}\\p{N}_])(${REGION_WORDS.join('|')})(?![\\p{L}\\p{N}_])|\\+${'88'}0|[\\u0980-\\u09FF]`, 'iu');

// a North American number: optional +1, the area code, the exchange and the line, in any of the usual spellings;
// after a + it must be +1 (+64 9 555 1234 is another country's)
const PHONE = /(?<![\d\w+])(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?![\d\w])/g;
/** Fictional numbers only: 555-0100 to 555-0199, and Twilio's documented test numbers (+1 500 555 ....). */
const fictional = (area, exchange, line) => (exchange === '555' && /^01\d\d$/.test(line)) || (area === '500' && exchange === '555');
/** Ten digits that are not a phone number: 2^32, and a value inside Svix's published webhook test vector. */
const NOT_PHONES = new Set(['4294967296', '2432232314']);

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![\w-])/g;
const MADE_UP_DOMAINS = ['example.com', 'example.org', 'getattendra.com', 'users.noreply.github.com'];
const madeUpDomain = (domain, local) => {
  const d = domain.toLowerCase();
  if (MADE_UP_DOMAINS.some((m) => d === m || d.endsWith(`.${m}`))) return true;
  if (d.endsWith('.test') || d.endsWith('.example') || d === 'test' || d === 'example') return true;
  // OpenAI's SIP host, with a made-up project in front of it
  return d.endsWith('openai.com') && /^proj_[a-z_]+$/.test(local);
};
// a made-up project id is a plain lower-case word (proj_x, proj_abc, proj_example); real ones mix cases and digits
const PROJECT = /proj_[A-Za-z0-9]+/g;
const madeUpProject = (id) => /^proj_[a-z_]+$/.test(id);

/** The private list: one entry a line, # for comments. Numbers are matched by their digits, whatever the spelling. */
export function parseDenylist(text) {
  return (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((entry, i) => {
    const digits = entry.replace(/\D/g, '');
    if (/^[\d\s().+-]+$/.test(entry) && digits.length >= 7) return { n: i + 1, digits };
    const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return { n: i + 1, re: new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu') };
  });
}

const digitRuns = (line) => [...line.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].map((m) => m[0].replace(/\D/g, ''));

/** What is wrong with one line, as rule names (and for the private list, the entry's number only). */
export function checkLine(line, denylist = []) {
  const found = [];
  for (const m of line.matchAll(PHONE)) if (!fictional(m[1], m[2], m[3]) && !NOT_PHONES.has(m[1] + m[2] + m[3])) { found.push('a phone number outside 555-0100 to 555-0199'); break; }
  if (REGION.test(line)) found.push('a word or code from the region rule');
  for (const m of line.matchAll(EMAIL)) {
    const local = m[0].slice(0, m[0].indexOf('@'));
    // a SIP address whose user is a phone number: the phone rule checks the number
    if (/^\+?\d+$/.test(local)) continue;
    if (!madeUpDomain(m[1], local)) { found.push('an email address outside the made-up domains'); break; }
  }
  for (const m of line.matchAll(PROJECT)) if (!madeUpProject(m[0])) { found.push('a project id that is not made up'); break; }
  const runs = denylist.some((d) => d.digits) ? digitRuns(line) : [];
  for (const d of denylist) {
    if (d.digits ? runs.some((r) => r.endsWith(d.digits)) : d.re.test(line)) found.push(`denylisted entry #${d.n}`);
  }
  return found;
}

/** Every finding in a text, as "where:line: rule". */
export function checkText(where, text, denylist = []) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => { for (const rule of checkLine(line, denylist)) out.push(`${where}:${i + 1}: ${rule}`); });
  return out;
}

// this file and its test spell the rules out; everything else is checked
const SKIP = new Set(['pnpm-lock.yaml', 'scripts/privacy-check.mjs', 'scripts/test/privacy-check.test.ts']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|mp3|mp4|wav|ogg|webm|woff2?|ttf|otf|pdf|zip|gz|wasm)$/i;

function main() {
  const secret = process.env.PRIVACY_DENYLIST;
  const denylist = parseDenylist(secret);
  if (!secret) console.log('::notice::PRIVACY_DENYLIST is not set (a fork\'s pull request): checking the public rules only');
  const findings = [];
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && !SKIP.has(f) && !BINARY.test(f));
  for (const file of files) {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    findings.push(...checkText(file, buf.toString('utf8'), denylist));
  }
  if (process.env.PR_TITLE) findings.push(...checkText('pull request title', process.env.PR_TITLE, denylist));
  if (process.env.PR_BODY) findings.push(...checkText('pull request body', process.env.PR_BODY, denylist));
  if (process.env.BASE_SHA && process.env.HEAD_SHA) {
    const shas = execFileSync('git', ['rev-list', `${process.env.BASE_SHA}..${process.env.HEAD_SHA}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const sha of shas) findings.push(...checkText(`commit ${sha.slice(0, 7)}`, execFileSync('git', ['log', '-1', '--format=%B', sha], { encoding: 'utf8' }), denylist));
  }
  for (const f of findings) console.log(f);
  console.log(findings.length ? `privacy: ${findings.length} finding(s); see CONTRIBUTING.md, Privacy` : `privacy: ${files.length} files clean`);
  process.exit(findings.length ? 1 : 0);
}

// run as a command (through a symlinked path too), not when a test imports it
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
