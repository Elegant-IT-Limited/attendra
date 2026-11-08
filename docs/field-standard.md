# The field standard

Every form field in the dashboard (`apps/web`), the rule it follows and the test that holds it there. Note 15 of the
2026-11-02 feedback: the right type, a limit, the right `autoComplete`, trimmed and checked again on the server, an
inline error that says what to type, read by screen readers, and a save that never silently does nothing. Note 14 is
the phone part of it. Audited 2026-11-08 (batch 4b): 269 rows below, one per field (a field repeated in a list counts
once).

The hosted sign-up and setup pages are in the hosting layer's own repository: **cloud, not changed here**. Their fields
are listed at the end so the standard covers them too.

## The rules

| Kind | In the browser | On the server | Shared code | Tests |
| --- | --- | --- | --- | --- |
| Phone | `PhoneInput`: `type="tel"`, `inputMode="tel"`, max 30 (100 for several numbers); letters and a `+` past the first character are dropped as typed and on paste, with "Use numbers only, for example (555) 555-0123." under the field. A transfer may also be a SIP address (`sip:`). `autoComplete="tel"` only for the person's own number; "off" for anyone else's (an owner, a vet, a hospital), so the browser never fills in the staff member's own phone | `PHONE_TYPED` refuses letters with `PHONE_NUMBERS_ONLY` (also in Settings, `phoneTypingIssues`, and imports), then the one normaliser `asE164` keeps E.164 | `packages/core/src/phones.ts` (`cleanPhoneField`, `PHONE_TYPED`, `PHONE_NUMBERS_ONLY`, `asE164`), `apps/web/components/ui/phone-input.tsx` | `packages/core/test/phone-typing.test.ts`, `apps/web/e2e/phone-fields.spec.ts`, `apps/web/e2e/patients.spec.ts`, `apps/api/test/live.test.ts` |
| The emergency number (911) | digits only, max 5; letters dropped with "Digits only, like 911." in the hint | `^\d{2,5}$` and the country's own numbers | `cleanDigitsTyping`, `DIGITS_ONLY` | `phone-typing.test.ts`, `phone-fields.spec.ts` |
| Email | `type="email"`, max 254, `autoComplete="username"` on sign-in | trimmed, lowercased (team invites, `team.controller.ts`), `z.email()` | | `team.spec.ts`, `field-standard.spec.ts` |
| Names (people, pets, vets, clinics, hospitals) | trimmed max length; digits allowed (pet and clinic names have them) | trimmed; must have a letter or a digit (`HAS_NAME`): "type a name, not only spaces or symbols" | `HAS_NAME` in `packages/core/src/clinic.ts`; `NOT_A_NAME` in `apps/api/src/contracts.ts` | `apps/api/test/field-rules.test.ts`, `packages/core/test/settings-fields.test.ts` |
| Numbers (minutes, hours, days, counts) | `type="number"`, `inputMode="numeric"`, the server's min and max | `z.number().int().min().max()` | | the screen's spec |
| Dates and times | `type="date"` / `type="time"` pickers; days that must be to come have `min` = the clinic's today, and a past one is said under the field | a real date (`realDate`: not 2026-02-31) for holidays and special days, checked on save | `realDate` | `settings-fields.test.ts`, `field-standard.spec.ts` |
| URLs | `type="url"`, the server's max, placeholder `https://` | `^https://` (map, text links, menu links, webhooks: public addresses only) | | `webhooks.spec.ts`, `field-standard.spec.ts` |
| Searches | `type="search"`, max 100 | trimmed, max 100 | `SEARCH_MAX` | the screen's spec |
| A clinic's own dropdown choice | max 40 | max 40, no `\|`, no repeats | `CHOICE_MAX` | `fields.test.ts` |
| Every free-text field | a visible label (or an `aria-label` in a row of a list) tied to the input (one id on the page); the server's max length; `autoComplete="off"` unless it is the person's own (the shared `Input` and `Textarea` default to off); an error under the field with `aria-invalid` and `aria-describedby` | trimmed, the same max | `apps/web/components/ui/input.tsx`, `apps/web/components/settings/section.tsx` | `field-standard.spec.ts` (no id twice on Settings) |
| Saving | never silent: a refused save lists each problem by its field's name in the section and in a dialog (Settings), or under the field (forms) | each problem by its field's path | `saveProblem` in `apps/web/lib/api.ts` | the screen's spec |

Passwords have no `maxLength` on purpose: a paste longer than 128 characters would be cut without a word. The length
is checked on submit and said ("Use at most 128 characters."), as Better Auth refuses it.

## Every field

"Before" is what the audit found; "After" what batch 4b did. "Meets the standard" had nothing to fix.

### Sign in

Files: app/sign-in/page.tsx. Tests: e2e/auth.setup.ts, e2e/account.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Email | Input type=email required; autoComplete username | Better Auth `/api/auth/sign-in/email` (library email schema); client trims (:69). No app-level lowercasing in the repo | no maxLength (AddMember allows 200); lowercasing relies on the library | Fixed: maxLength 254 (the longest address there is) |
| Password | PasswordInput (password) required; autoComplete current-password | Better Auth, min 12 (`apps/api/src/auth.ts:63`), library max 128 | no maxLength (server 128), minor | Kept: no maxLength on passwords. A pasted 129th character would be cut silently; the length is checked on submit with "Use at most 128 characters." |

### Forgot password

Files: app/forgot-password/page.tsx. Tests: e2e/account.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Your email | Input type=email required; autoComplete username | Better Auth `/request-password-reset` (5/h, auth.ts:76); client trims (:29) | no maxLength | Fixed: maxLength 254 |

### Reset password

Files: app/reset-password/page.tsx. Tests: e2e/account.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| New password | PasswordInput minLength=12 required; autoComplete new-password | Better Auth reset-password, min 12 (auth.ts:63), max 128 | Alert not tied to the field; no maxLength 128 | Kept: no maxLength (see Sign in); the 12 to 128 rule is said in the Alert |
| New password again | PasswordInput required; autoComplete new-password | client only (:33) | Alert not tied | Kept: no maxLength (see Sign in); the 12 to 128 rule is said in the Alert |

### Change password

Files: app/change-password/page.tsx. Tests: e2e/account.spec.ts, e2e/team.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Temporary / Current password | PasswordInput required; autoComplete current-password | Better Auth changePassword | Alert not tied | Open (see "Still open" below) |
| New password | PasswordInput minLength=12 required; autoComplete new-password | Better Auth min 12 / max 128; client checks both (:35,37) | Alert not tied; no maxLength 128 | Kept: no maxLength (see Sign in) |
| New password again | PasswordInput required; autoComplete new-password | client only | Alert not tied | Kept: no maxLength (see Sign in) |

### Two-step sign-in

Files: app/two-factor/page.tsx. Tests: apps/api/test/two-factor-by-role.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Code / Backup code | Input (text) required; autoComplete one-time-code; inputMode numeric (text for a backup code) | Better Auth twoFactor verifyTotp / verifyBackupCode; client strips spaces / trims (:39-40) | no maxLength (6 for TOTP) and no pattern | Fixed: maxLength 64 (a pasted code with spaces still fits) |

### Set up two-step sign-in

Files: app/setup-two-factor/page.tsx. Tests: apps/api/test/two-factor-by-role.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Confirm your password | PasswordInput required; autoComplete current-password | Better Auth twoFactor.enable | Alert not tied | Open (see "Still open" below) |
| Code from the app | Input (text) required; autoComplete one-time-code; inputMode numeric | Better Auth verifyTotp; client strips spaces (:61) | Alert not tied; no maxLength 6 | Fixed: maxLength 64; the error is tied to the field (aria-invalid, aria-describedby) |

### Your account

Files: app/profile/page.tsx. Tests: e2e/profile.spec.ts, apps/api/test/field-rules.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Your password, to … (two-step changes) | PasswordInput required; autoComplete current-password | Better Auth twoFactor | Alert not tied | Open (see "Still open" below) |
| Picture (Upload a picture) | raw input type=file, hidden, accept jpeg/png/webp | `PUT /me/avatar`: ≤200 KB (`AVATAR_MAX_BYTES`, packages/db/src/repositories/profile.ts:9; apps/api/src/me/me.controller.ts:86); real type from magic bytes (:87, avatar.ts) | none (resized in the browser first) | Meets the standard |
| Your name | Input (text) in ui Field; max 80; autoComplete name | ProfileName contracts:766, trim, min 2, max 80 | server doesn't reject names made only of spaces or symbols (no HAS_NAME) | Fixed: server refuses a name with no letter or digit |

### Settings: General

Files: app/c/[clinicId]/settings/page.tsx. Tests: e2e/field-standard.spec.ts, e2e/phone-fields.spec.ts, packages/core/test/settings-fields.test.ts, packages/core/test/phone-typing.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Clinic name | Input (text) required; max 100; autoComplete organization | `name: z.string()` clinic:352 + SFP clinic:693 (HAS_NAME, ≤100 on the trimmed value) | server saves the value untrimmed; hosting rename `ClinicName` contracts:832 caps at 60, not 100; `organization` offers the staff member's own employer, should be off | Fixed: autoComplete off (was organization, which offered the staff member's employer). Hosting rename caps at 60: cloud, not changed here |
| Address | Input (text); max 200 | clinic:354 trim, max 200 | ac-off missing (the browser may offer a home address) | Fixed: autoComplete off |
| Website | Input type=url; max 200 | clinic:355 trim, max 200, regex `^https?://` | browser and server both accept `http://` (standard: https only); ac-off missing | Fixed: autoComplete off. Still takes http:// on both sides: making it https only would refuse a clinic's next save of anything while an old http address is stored, so it waits for a decision (below) |
| Greeting | Textarea; max 400 (SETTINGS_LIMITS) | clinic:384 max 400, no trim; AI-disclosure check clinic:480-483 | server doesn't trim | Fixed: server trims it (ClinicConfig) |
| Voice | Select | clinic:396 `z.string()` default `marin` | server accepts any string (no enum of voices) | Open (see "Still open" below) |
| Time zone | TimeZonePicker (button role=combobox + listbox) | clinic:358-360 IANA zone check | — | Meets the standard |
| Pace | Select | TalkStyle clinic:324 enum | — | Meets the standard |
| Style | Select | clinic:325 enum | — | Meets the standard |
| Small acknowledgements | Switch | clinic:327 boolean | — | Meets the standard |
| Transfer emergencies to on-call (people clinics only) | Switch | clinic:419 boolean | — | Meets the standard |
| Record calls | Switch | clinic:441-443 (a notice is required when on) | — | Meets the standard |
| Recording notice | Input (text) inside a wrapper div; max 300 | clinic:441 `z.string().optional()` (no trim, no max) + SFP clinic:696 (≤300) | label not tied (duplicate id); server doesn't trim; the 300 limit is only in SFP | Fixed: label and hint reach the input (the Settings Field no longer puts the id on its wrapper); server trims it |
| Monday… opens | Input type=time | `hhmm` clinic:6; open < close clinic:10-11 | — | Meets the standard |
| Monday… closes | Input type=time | same | — | Meets the standard |
| While you are closed | Select | clinic:427 enum | — | Meets the standard |
| Holiday date | Input type=date | `holidays` clinic:365, `isoDate` regex only (clinic:7) | no `min` (past days accepted); server checks the format, not that the date exists | Fixed: min = the clinic's today; a past day says "Pick today or a day to come." under the field (aria-invalid, aria-describedby) and Add holiday is off; the server refuses a day not on the calendar (2026-02-31) |
| Visit type: Name | Input (text); max 60 | `VisitType.name z.string()` clinic:91 + SFP clinic:694 (HAS_NAME, ≤60 trimmed) | server saves the value untrimmed; ac-off missing | Fixed: server trims it; autoComplete off (the shared Input and Textarea now default to off) |
| Visit type: Minutes | Input type=number min=5 max=240 step=5; inputMode numeric | clinic:93 int 5–240 | an emptied field sends 0 (`Number('')`), which only the section message catches | Open (see "Still open" below) |
| Visit type: What it includes | Input (text); max 300 | clinic:97 trim, max 300 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| Visit type: In Spanish (LocalNames) | Input (text) lang=es | `LocalNames` clinic:19, min 1 max 80, **no trim** | no maxLength (server 80); server doesn't trim | Fixed: maxLength 80 (the server's), autoComplete off |
| More options: Who can book it | Select | clinic:95 enum | — | Meets the standard |
| More options: Team books it | Switch | clinic:99 | — | Meets the standard |
| More options: Book at least ___ ahead (notice) | Input type=number min=0 max=720 (or 30 days) inside a wrapper div; inputMode numeric | clinic:101 int 0–720; configProblems clinic:554 | duplicate id; the visible hint is not read with the input | Fixed: one id on the page; the hint is read with the input as well as the no-day error |
| More options: notice unit (hours/days) | Select | client only | — | Meets the standard |
| More options: Book at most ___ days ahead | Input type=number min=1 max=365; inputMode numeric | clinic:103 int 1–365 | the no-day error isn't tied to this field as well | Open (see "Still open" below) |
| More options: Break after (minutes) | Input type=number min=0 max=120; inputMode numeric | clinic:105 int 0–120 | — | Meets the standard |
| Booking rules: When the caller has no vet in mind | RadioGroup (Radix) | clinic:310 enum | — | Meets the standard |
| Booking rules: Wait for the usual vet up to, in days | Input type=number min=1 max=30; inputMode — (type=number) | clinic:312 int 1–30 | out-of-range text reverts on blur without a message | Open (see "Still open" below) |
| Booking rules: When several vets are free | RadioGroup | clinic:314 enum | — | Meets the standard |
| Booking rules: Appointment start times every… | Select | clinic:318 literal 5/10/15/20/30 | — | Meets the standard |
| Booking rules: Match the kind of animal | Switch | clinic:316 | — | Meets the standard |
| Special day date | Input type=date | SpecialDay.date clinic:39 (regex); duplicates / holiday clash clinic:450-454 | no `min` (past dates accepted) | Fixed: min = today; a past day or a date already listed is said under the field, tied to it; the server refuses a day not on the calendar |
| Special day: closed or open | Select | windows ≤4 clinic:40 | — | Meets the standard |
| Special day: opens | Input type=time | hhmm, open<close clinic:451 | — | Meets the standard |
| Special day: closes | Input type=time | same | — | Meets the standard |
| Special day: note | Input (text); max 60 | clinic:42 trim, max 60 | ac-off missing | Fixed: autoComplete off |
| Special day: vets who still work their own hours | raw input type=checkbox (inside a label) | clinic:44 array ≤200 | — | Meets the standard |
| Transfers: Who it reaches | Select | clinic:112 enum | — | Meets the standard |
| Transfers: Phone number | PhoneInput mode=transfer (type=tel); max 200; autoComplete off; inputMode tel | RoutingRule.uri clinic:114 (`tel:+E.164` or `sip:`), letters refused by phoneTypingIssues, normalised by withPhonesAsE164 | server has no length cap for a `sip:` address (browser allows 200) | Fixed: now PhoneInput mode=transfer: letters dropped as typed and pasted with the note, a SIP address kept (was type=tel with letters dropped silently) |
| Transfers: When | Select | clinic:115 enum | — | Meets the standard |
| VIP callers: Who | Input (text); max 60 | VipCaller.name clinic:335 trim, 1–60 + SFP clinic:698 HAS_NAME | ac-off missing | Fixed: autoComplete off |
| VIP callers: Phone number | PhoneInput; max 30; autoComplete off; inputMode tel | VipCaller.phone e164 clinic:336 after normaliser; phoneTypingIssues | — | Meets the standard |
| Common questions: Question | Input (text); max 200 | `Faq.question z.string()` clinic:341 + SFP clinic:695 (not blank, ≤200) | server doesn't trim; the schema has no max (only SFP) | Fixed: server trims it |
| Common questions: Answer | Textarea; max 600 | clinic:342 max 600, no trim | server doesn't trim; an empty answer is accepted | Fixed: server trims it |
| Offers: Title | Input (text); max 80 | Offer.title clinic:122 trim, 2–80 | ac-off missing | Fixed: autoComplete off |
| Offers: From | Input type=date | clinic:124 isoDate; from≤to clinic:126 | — | Meets the standard |
| Offers: To | Input type=date min={from} | clinic:125 | no `min` of today: an offer that has already ended can be saved | Fixed: min = the later of From and today |
| Offers: Details | Textarea; max 400 | clinic:123 trim, 2–400 | — | Meets the standard |
| Menu links: Label (behind SHOW_MENU_LINKS) | Input (text); max 30 | MenuLink.label clinic:137 trim, 1–30 | ac-off missing | Fixed: autoComplete off |
| Menu links: Web address | Input type=url | clinic:138 trim, max 500, regex `^https://` | no maxLength (server 500); type=url accepts `http://`, which the server refuses | Fixed: maxLength 500 (the server's), hint "Starts with https://", autoComplete off |
| Keep transcripts and summaries for | Select | clinic:440 int 30–3650, capped at 1095 | — | Meets the standard |
| Your clinic's own line | PhoneInput; max 30; autoComplete off; inputMode tel | phoneNumbers e164 clinic:361; settings.controller.ts:191-203 (assistant numbers untouched, ≤3 own lines, in the clinic's country) | — | Fixed: now PhoneInput: letters dropped with the note (was dropped silently, a tooltip only) |

### Settings: Assistant and languages

Files: components/settings/assistant.tsx, inside settings/page.tsx:313. Tests: e2e/phone-fields.spec.ts, e2e/languages.spec.ts, packages/core/test/phone-typing.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Assistant name | Input (text); max 24 | clinic:390 trim, regex `^[\p{L}\p{M}]{2,24}$` | ac-off missing (the browser may offer the staff member's own first name); no inline error | Fixed: autoComplete off |
| Country | Select | clinic:363 regex `^[A-Z]{2}$` | — | Meets the standard |
| Emergency number | Input (text); max 5; autoComplete off; inputMode numeric | clinic:395 regex `^\d{2,5}$` + emergencyNumberProblem (settings.controller.ts:209) | — | Fixed: letters dropped with "Digits only, like 911." in the hint (was dropped silently) |
| Languages the assistant speaks | Checkbox ×N | clinic:392 + superRefine clinic:445-448 | — | Meets the standard |
| Primary language | Select | clinic:393 | — | Meets the standard |
| Greeting in another language | Textarea lang=…; max 400 | clinic:386 trim, 10–400; disclosure check clinic:469-474 | error not tied; the 10-character minimum isn't stated | Fixed: its error has an id and is in the field's aria-describedby |

### Settings: Texting

Files: app/c/[clinicId]/settings/texting/page.tsx, components/settings/texts-editor.tsx. Tests: e2e/field-standard.spec.ts, apps/api/test/texts.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Send texts during calls | Switch | Texting.enabled clinic:271 | — | Meets the standard |
| What the assistant may text (×7 kinds) | Switch | clinic:272-281 | — | Meets the standard |
| Map link (optional) | Input type=url | mapUrl clinic:283 trim, max 300, `^https://` | no maxLength (server 300); type=url accepts `http://` | Fixed: maxLength 300 (the server's); the server still refuses http:// with its message |
| Links: What the text calls it | Input (text); max 40 | TextLink.label clinic:251 trim, 2–40 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| Links: Link | Input type=url; max 300 | clinic:252 trim, max 300, `^https://` | type=url accepts `http://`, which the server refuses | Fixed: hint "Starts with https://"; the server refuses http:// with its message |
| Links: When to offer it | Input (text); max 120 | clinic:254 trim, 2–120 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| Send appointment reminders | Switch | clinic:288 | — | Meets the standard |
| Hours before the visit | Input type=number min=**3** max=168 | clinic:289 int **2**–168 | the browser min (3) disagrees with the hint and the server (2) | Fixed: min 2, the hint's and the server's (was 3); inputMode numeric |
| Quiet hours (from) | Input type=time inside a wrapper div | clinic:291 hhmm | label not tied (duplicate id) | Fixed: label and hint reach the input (one id on the page) |
| Quiet hours end | Input type=time | clinic:292 hhmm | — | Meets the standard |
| Ask callers when booking | Switch | clinic:294 | — | Meets the standard |
| Your words: lead, after your name | Input (text); max 40 | TextWording clinic:261-266 trim, max 40, no link shorteners, no sales words | error not tied; ac-off missing | Fixed: the error has an id; both boxes get aria-invalid and aria-describedby; autoComplete off |
| Your words: line before "Reply STOP" | Input (text); max 100 | clinic:261-266 trim, max 100 | same | Fixed: the error has an id; both boxes get aria-invalid and aria-describedby; autoComplete off |

### Settings: Emergencies

Files: app/c/[clinicId]/settings/emergencies/page.tsx. Tests: e2e/emergencies.spec.ts, apps/api/test/emergency-review.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| How this location handles emergencies | RadioGroup | EmergencySettings clinic:213-217 | — | Meets the standard |
| Hospital name | Input (text); max 80 | EmergencyHospital.name clinic:189 trim, 2–80 | no HAS_NAME (a name made only of symbols is accepted); ac-off missing | Fixed: the server refuses a name with no letter or digit when Settings are saved (settingsFieldProblems); autoComplete off (the shared Input and Textarea now default to off) |
| Phone | PhoneInput; max 30; autoComplete off; inputMode tel | clinic:190 e164 after normaliser; phoneTypingIssues | — | Meets the standard |
| Address | Input (text); max 200 | clinic:191 trim, 5–200; SFP clinic:697 | the minimum of 5 isn't stated; ac-off missing | Open (see "Still open" below) |
| Open around the clock | Switch | clinic:192 hours optional | — | Meets the standard |
| Hospital opens | Input type=time | hhmm (overnight allowed) | — | Meets the standard |
| Hospital closes | Input type=time | hhmm | — | Meets the standard |
| Emergency line | PhoneInput; max 30; autoComplete off; inputMode tel | clinic:215-216 e164 | — | Meets the standard |
| Backup hospital | Switch | clinic:215 | — | Meets the standard |
| Own emergency hours | Switch | clinic:216 | — | Meets the standard |
| Emergency hours: day | Checkbox | WeeklyHours clinic:14 | — | Meets the standard |
| Emergency hours: from | Input type=time | hhmm, open<close | — | Meets the standard |
| Emergency hours: to | Input type=time | same | — | Meets the standard |

### Settings: Fields and lists

Files: app/c/[clinicId]/settings/fields/page.tsx; FieldsEditor ×3 at :91/:106/:122; ListEditor ×3 at :97/:111/:114. Tests: e2e/dashboard.spec.ts, apps/api/test/fields.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| List: Add to {list} | Input (text); max 40 | ListChange contracts:662 trim, 1–40, ≤60 values; ManagedList duplicate check clinic:171 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| List: New name for {value} | Input (text); max 40 | same | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| Kind of request: Name | Input (text); max 60 | RequestTopic.name clinic:131 trim, 2–60 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| Kind of request: What to ask the caller | Input (text); max 300 | clinic:132 trim, max 300 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |

### Settings: Knowledge

Files: app/c/[clinicId]/settings/knowledge/page.tsx. Tests: e2e/knowledge.spec.ts, apps/api/test/knowledge.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Title | Input (text); max 200 | KnowledgeUpload.title contracts:205 trim, 1–200 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| File | Input type=file accept pdf/txt/md | apps/api/src/knowledge/knowledge.controller.ts:65 (MAX_BYTES 5 MB, packages/knowledge/src/extract.ts:6), 415 for other types | — | Meets the standard |
| Ask a question | Input (text); max 300 | KnowledgeAsk contracts:209 trim, 2–300 | — | Meets the standard |

### Settings: API keys

Files: app/c/[clinicId]/settings/api-keys/page.tsx. Tests: e2e/api-keys.spec.ts, apps/api/test/api-keys.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Name | Input (text); max 100 | ApiKeyInput.name contracts:282 trim, 1–100 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| What it may do (scopes) | Checkbox ×N | contracts:283 enum, at least 1 | — | Meets the standard |
| Expires after | Select (7/30/90/365) | contracts:285 int 7–365 | — | Meets the standard |

### Settings: Integrations

Files: app/c/[clinicId]/settings/integrations/page.tsx. Tests: e2e/field-standard.spec.ts, e2e/webhooks.spec.ts, apps/api/test/webhooks.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| URL | Input (**no type**); max **—** | WebhookEndpointInput.url contracts:230 trim, max 2000; then `resolveEndpoint` (apps/api/src/webhooks/webhooks.controller.ts:146-148): https only, no credentials in the URL, public address | no type=url; no maxLength (server 2000); ac-off missing; the browser doesn't require `https://` | Fixed: type=url, inputMode url, maxLength 2000 (the server's), autoComplete off; https and a public address are still checked by the server, with its message |
| Description | Input (text); max 200 | contracts:231 trim, max 200 | ac-off missing | Fixed: autoComplete off |
| Events | Checkbox ×9 | contracts:232 at least 1 | — | Meets the standard |
| Leave out record ids (new endpoint) | Checkbox | contracts:233 | — | Meets the standard |
| On (per endpoint) | Switch | WebhookEndpointPatch.enabled contracts:241 | the label "On" doesn't say which endpoint | Open (see "Still open" below) |
| Leave out record ids (per endpoint) | Checkbox | contracts:240 | same: the label doesn't name the endpoint | Open (see "Still open" below) |

### Settings: someone saved since

Files: components/settings/settings-conflict.tsx. Tests: apps/api/test/config.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Whose to keep (per setting) | Select | client-side merge, then Settings PUT | — | Meets the standard |

### Doctors / Veterinarians list

Files: app/c/[clinicId]/doctors/page.tsx. Tests: e2e/doctors.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Find a vet | Input type=search; autoComplete off | none (filters in the browser, :72-74) | — | Meets the standard |
| Specialty filter | Select | client only | — | Meets the standard |
| Sees filter | Select | client only | — | Meets the standard |
| Sort | Select | client only | — | Meets the standard |

### Doctor panel: add or edit

Files: doctors/page.tsx DoctorPanel. Tests: e2e/doctors.spec.ts, e2e/phone-fields.spec.ts, apps/api/test/doctors.test.ts, apps/api/test/field-rules.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Name | Input (text) required minLength=2; max 80 | DoctorInput.name contracts:690 trim, max 80 → bareName → min 2 | no HAS_NAME on the server (for example "!!" passes); error not tied; ac-off missing | Fixed: autoComplete off; the server refuses a name with no letter or digit ("!!") |
| Is a | Select | clinic:59 enum | — | Meets the standard |
| Title | Select | clinic:86 enum | — | Meets the standard |
| Name in Spanish (LocalNames) | Input (text) | DoctorInput.names contracts:691 trim, max 80, bareName | no maxLength (server 80) | Fixed: maxLength 80, autoComplete off |
| Gender | Select required | Gender enum contracts:692 | error not tied | Open (see "Still open" below) |
| Phone (private) | PhoneInput; max 30; autoComplete off; inputMode tel | contracts:694 trim, max 30, PHONE_TYPED; providerPhoneIssues (E.164, one per clinic) via apps/api/src/doctors/doctors.controller.ts:49-52 | — | Meets the standard |
| Other numbers | PhoneInput mode=several; max 100; autoComplete off; inputMode tel | contracts:695 each trim, max 30, PHONE_TYPED, ≤3 | — | Fixed: now PhoneInput mode=several: letters dropped as typed and pasted with the note (was dropped silently) |
| Specialty | Combobox (list only; typing narrows); max 60 (filter text); autoComplete off | clinic:63 trim, max 60; notOnListProblem doctors.controller.ts:43 | — | Meets the standard |
| Specialty: Add a specialty | Input (text); max 40 | ListChange 40 | add error not tied to the add box | Open (see "Still open" below) |
| What they see / Sees | ChipsPicker (filter box); max 40; autoComplete off | clinic:65 trim, 1–40, ≤12; notOnList doctors.controller.ts:44 | — | Meets the standard |
| Sees: Add one to the list | Input (text); max 40 | ListChange 40 | add error not tied to the add box | Open (see "Still open" below) |
| Qualifications and certifications | Input (text), split on , ;; max **—** | Provider.credentials clinic:77 each trim, 2–60, ≤8 items | no maxLength; per-item and count limits not stated; ac-off missing | Fixed: maxLength 500, autoComplete off, the hint says "up to 8, each 2 to 60 characters" and is tied to the input |
| More details (custom fields) | see "Custom fields" |  | — | Meets the standard |
| Ages they see: From | Input type=number min=0 max=120 | AgeRange clinic:49 int 0–120, max ≥ min | — | Meets the standard |
| Ages they see: to | Input type=number min=0 max=120 | same | — | Meets the standard |
| Takes new patients/pets | raw checkbox (wrapping label) | clinic:69 | — | Meets the standard |
| All visit types | raw checkbox | — | — | Meets the standard |
| Visit type (×N) | raw checkbox | contracts:697 at least 1 | error not tied to the group | Open (see "Still open" below) |
| Their own hours | raw checkbox | clinic:71 | — | Meets the standard |
| Weekly hours: from | Input type=time | WeeklyHours hhmm, open<close | — | Meets the standard |
| Weekly hours: until | Input type=time | same | — | Meets the standard |
| Days off: First day off / Day | Input type=date, `min=today` only for a **new** doctor | TimeOff clinic:29-35 isoDate, from ≤ to | for an existing doctor a new row has no min (past days accepted); no server past-date check | Fixed: min = today for every row not already in the past (was for a new vet only) |
| Days off: Away from | Input type=time | clinic:32,35 | — | Meets the standard |
| Days off: Back at | Input type=time | same | — | Meets the standard |
| Days off: Last day off | Input type=date min={from} | clinic:34 | — | Meets the standard |
| Days off: Part of the day | raw checkbox | — | — | Meets the standard |
| Days off: Note | Input (text); max 80 | clinic:30 trim, max 80 | ac-off missing | Fixed: autoComplete off |

### Hand over a leaving vet's visits

Files: components/schedule/handover-dialog.tsx. Tests: apps/api/test/handover.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Who takes them | Select | HandoverQuery / HandoverInput contracts:719 | — | Meets the standard |
| Text the owners | Checkbox | contracts:721 | — | Meets the standard |

### Pets / Patients list

Files: app/c/[clinicId]/patients/page.tsx, components/patients/patient-search.tsx. Tests: e2e/patients.spec.ts, e2e/pets.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Which pets (All / New) | Segmented (aria-pressed buttons) | PatientListQuery status enum | — | Meets the standard |
| Find a pet / patient | Input type=search; max **—**; autoComplete off | PatientSearch contracts:576-577 trim, 1–100 | no maxLength (server 100) | Fixed: maxLength 100 = SEARCH_MAX, the server's |
| Kind of animal filter | Select | PatientFilter.species contracts:657 | — | Meets the standard |

### Pet / patient form

Files: components/patients/patient-form.tsx; Add at patients/page.tsx:165, Edit at patients/[patientId]/page.tsx:201. Tests: e2e/patients.spec.ts, e2e/pets.spec.ts, apps/api/test/patients.test.ts, apps/api/test/field-rules.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Pet's name | Input (text) required; max 80; autoComplete off | personName contracts:566 trim, 1–80, HAS_NAME | — | Meets the standard |
| Kind of animal | Combobox required (+ add box combobox.tsx:143); max 60 (filter); autoComplete off | PatientInput.species contracts:619 trim, max 40; list check apps/api/src/patients/patients.controller.ts:61 | — | Meets the standard |
| Birthday | Input type=date required min=1890-01-01 (no max, on purpose) | contracts:613 real date ≥1890; not in the future patients.controller.ts:52 | — | Meets the standard |
| Sex | Select required | Gender enum | — | Meets the standard |
| Owner's first name | Input (text) required; max 60; autoComplete off | guardianName contracts:617 trim, max 120 (first + last); required patients.controller.ts:57 | no HAS_NAME on the owner's name | Fixed: server: guardianName must have a letter or digit |
| Owner's last name (optional) | Input (text); max 60; autoComplete off | lastName contracts:611 trim, max 80 | no HAS_NAME; browser 60 vs server 80 (stricter, harmless) | Fixed: server refuses symbols alone (empty still fine) |
| Owner's phone | PhoneInput required minLength=10; max 30; autoComplete off; inputMode tel | phoneNumber contracts:569 trim, max 30, PHONE_TYPED, ≥10 digits | — | Meets the standard |
| First name | Input (text) required; max 80; autoComplete off | personName contracts:566 | — | Meets the standard |
| Last name | Input (text) required; max 80; autoComplete off | contracts:611 trim, max 80; required patients.controller.ts:64 | no HAS_NAME on the last name | Fixed: server refuses symbols alone |
| Date of birth | Input type=date required min=1890-01-01 | contracts:613 + :52 | — | Meets the standard |
| Gender | Select required | Gender enum | — | Meets the standard |
| Phone | PhoneInput required minLength=10; max 30; autoComplete off; inputMode tel | contracts:569 | — | Meets the standard |
| Parent or guardian | Input (text) required; max 120; autoComplete off | contracts:617 trim, max 120; required under 18 patients.controller.ts:66 | no HAS_NAME | Fixed: server refuses symbols alone |
| Texts OK (reminders) | Checkbox | contracts:621 | — | Meets the standard |

### Custom fields

Files: components/patients/custom-fields.tsx; on the pet form :239, pet page CustomFieldsForm [patientId]/page.tsx:211, doctor panel doctors/page.tsx:362, new request requests/page.tsx:659, request card :461. Tests: e2e/dashboard.spec.ts, apps/api/test/fields.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| {label} (yes/no) | Select | readCustomValues cf-core:44 | — | Fixed: aria-required when the field must be filled in |
| {label} (date) | DatePicker (input type=date) | cf-core:45 regex YYYY-MM-DD | server checks the format only, not that the date exists | Fixed: aria-required when required |
| {label} (dropdown, one) | Select | cf-core:47-52 | — | Fixed: aria-required when required |
| {label} (dropdown, several) | Checkbox group (role=group aria-label) | cf-core:53-59 | — | Meets the standard |
| {label} (text / number) | Input (text); max 200; autoComplete off; inputMode decimal for number | CustomFieldValues contracts:660 (max 400), then readCustomValues cf-core:41-46 (trim, max 200, number regex) | required fields have no `required` / aria-required; errors not tied | Fixed: aria-required when required |

### Schedule

Files: app/c/[clinicId]/schedule/page.tsx and components/schedule/*. Tests: e2e/schedule.spec.ts, e2e/schedule-scale.spec.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Date | Input type=date | ScheduleQuery.from contracts:449 | — | Meets the standard |
| Provider | Select | contracts:453 max 64 | — | Meets the standard |
| Show | Select | status enum | — | Meets the standard |
| Find a vet (vets picker) | Input type=search; autoComplete **—** | client filter only | ac-off missing (the only search box without it) | Fixed: maxLength 100, autoComplete off |
| Specialty (vets picker) | Select | client only | — | Meets the standard |
| Working today | Checkbox | client only | — | Meets the standard |
| Each vet | Checkbox ×N | client only | — | Meets the standard |
| Vet (agenda) | Combobox (list only); max 60 (filter); autoComplete off | client filter | — | Meets the standard |
| Specialty (agenda) | Select | client only | — | Meets the standard |
| Visit type (agenda) | Select | SlotQuery.visitTypeId | — | Meets the standard |
| Cancelled: Visits from | Input type=date max={to} | CancelledQuery contracts:458 isoDate | — | Meets the standard |
| Cancelled: to | Input type=date min={from} | same | — | Meets the standard |
| Cancelled: Sort | Select | enum | — | Meets the standard |
| Cancelled: Find a patient | Input type=search; max **—**; autoComplete off | contracts:465 trim, max 100 | no maxLength (server 100) | Fixed: maxLength 100 = SEARCH_MAX |
| Book: Find a pet (patient picker) | see the patients list row |  | — | Meets the standard |
| Book: Visit type | Select | BookAppointment.visitTypeId contracts:546 | — | Meets the standard |
| Book: Veterinarian / Provider | Select | contracts:545 | — | Meets the standard |
| Book: Squeeze in outside the hours | Checkbox | contracts:552 | — | Meets the standard |
| Book: Override vet | Select | contracts:545 | — | Meets the standard |
| Book: Override date | Input type=date min=today | startsAt contracts:547 | — | Meets the standard |
| Book: Override time | Input type=time | same | — | Meets the standard |
| Book: Why (required) | Input (text); max 120 | contracts:553 trim, 3–120; refine :554 | labelled "(required)" but no `required`/aria-required; the 3-character minimum isn't stated; error not tied; ac-off missing | Fixed: required, aria-required, minLength 3, hint "At least 3 characters" tied to it, autoComplete off |
| Book: Note for the team (optional) | Textarea; max 500 | contracts:548 trim, max 500 | — | Meets the standard |
| Visit: Why is it cancelled? | Select | CancelReason contracts:560 | — | Meets the standard |

### Requests

Files: app/c/[clinicId]/requests/page.tsx. Tests: e2e/requests.spec.ts, apps/api/test/desk.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Status (Open / Done) | Segmented | TaskQuery.status | — | Meets the standard |
| Type | Select | TaskQuery.type enum | — | Meets the standard |
| Assigned to | Select | TaskQuery.assignee | — | Meets the standard |
| Search requests | Input type=search; max **—**; autoComplete off | TaskSearch.q contracts:348 trim, max 100 | no maxLength (server 100) | Open: this screen is in the parallel batch (requests, call list); listed for it |
| Came in from | Input type=date max={to} | contracts:341 day() | — | Meets the standard |
| Came in to | Input type=date min={from} | same | — | Meets the standard |
| Card: Add a note for the team | Textarea; max 1000 | TaskNoteInput contracts:397 trim, 1–1000 | — | Meets the standard |
| Card: Outcome | Select | TaskOutcome contracts:373 | — | Meets the standard |
| Card: Assign to | Select | TaskAssign contracts:374 | — | Meets the standard |
| Card: Due | Input type=date | TaskPlan.dueOn contracts:396 `z.iso.date()` | no `min` (past due dates accepted in the browser and by the server) | Open: this screen is in the parallel batch (requests, call list); listed for it |
| New request: What kind (toggle buttons) | button aria-pressed ×N | NewTask.type/topic contracts:381, :386 | — | Meets the standard |
| New request: Find the pet or owner (picker) | see the patients list row |  | — | Meets the standard |
| New request: Name | Input (text) in ui Field; max 80; autoComplete off | NewTask.name contracts:390 trim, max 80 | no HAS_NAME; error not tied | Open: this screen is in the parallel batch (requests, call list); listed for it |
| New request: Call back on | PhoneInput in ui Field; max **30**; autoComplete off; inputMode tel | contracts:388 trim, PHONE_TYPED and `^\+?[\d\s().-]{7,20}$` (**20** characters) | browser maxLength 30 vs server 20; error not tied | Open: this screen is in the parallel batch (requests, call list); listed for it |
| New request: Medicine (refills) | Input (text); max 120 | contracts:383 trim, max 120 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| New request: Pharmacy (refills) | Input (text); max 120 | contracts:384 trim, max 120 | ac-off missing | Fixed: autoComplete off (the shared Input and Textarea now default to off) |
| New request: What it is about | Textarea; max 300 | contracts:387 trim, 3–300 | the 3-character minimum only disables the button and says nothing | Open: this screen is in the parallel batch (requests, call list); listed for it |
| New request: Urgent | raw checkbox (wrapping label) | contracts:393 | — | Meets the standard |
| New request: Due | Input type=date in ui Field | contracts:394 `z.iso.date()` | no `min` (past dates accepted) | Open: this screen is in the parallel batch (requests, call list); listed for it |
| Viewer: Status | Segmented | TaskQuery.status | — | Meets the standard |

### Calls

Files: app/c/[clinicId]/calls/page.tsx. Tests: e2e/dashboard.spec.ts, apps/api/test/search.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Find a call | Input type=search; max **—**; autoComplete off | CallSearch.query contracts:138 trim, 1–100 | no maxLength (server 100) | Open: this screen is in the parallel batch (requests, call list); listed for it |
| From | Input type=date | contracts:125 day() (real date 1900–2100) | no max=today and no from ≤ to link, in the browser or on the server | Open: this screen is in the parallel batch (requests, call list); listed for it |
| To | Input type=date | contracts:126 | same | Open: this screen is in the parallel batch (requests, call list); listed for it |
| Outcome | Select | contracts:127 enum | — | Meets the standard |
| Channel | Select | contracts:128 enum | — | Meets the standard |
| Emergencies only | raw checkbox (wrapping label) | contracts:129 | — | Meets the standard |

### Live call

Files: app/c/[clinicId]/calls/[callId]/live/page.tsx. Tests: e2e/live.spec.ts, apps/api/test/live.test.ts, apps/api/test/field-rules.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Note for the assistant | Textarea; max 300 | LiveCoach contracts:189 trim, 1–300 | — | Meets the standard |
| Transfer to | RadioGroup | LiveTakeOver.target enum | — | Meets the standard |
| Your number | PhoneInput; max 30; autoComplete tel (default: the person's own number, correct); inputMode tel | TransferNumber contracts:193 trim, max 30, PHONE_TYPED → asE164, isE164, clinic country (apps/api/src/calls/live.controller.ts:164-170) | — | Fixed: now PhoneInput (type=tel, autoComplete tel: the person's own number); the API takes it as typed, refuses letters with the one message and keeps it as E.164 in the clinic's country; the server's message is under the field (was a plain text box and a fixed message) |

### Test call

Files: app/c/[clinicId]/test-call/page.tsx, components/calls/call-as.tsx. Tests: e2e/test-call.spec.ts, apps/api/test/test-calls.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Call as | Select | CallAs contracts:311 | — | Meets the standard |
| Find a number in your records | Input type=search; max **—**; autoComplete off | TestCallNumbersQuery contracts:321 trim, max 100 | no maxLength (server 100) | Fixed: maxLength 100 = SEARCH_MAX |
| Number to call as | PhoneInput; max 30; autoComplete off; inputMode tel | contracts:314 trim, 1–30, PHONE_TYPED | error not tied | Open (see "Still open" below) |
| Record this test call | Checkbox | client only | — | Meets the standard |

### Team

Files: app/c/[clinicId]/team/page.tsx. Tests: e2e/team.spec.ts, e2e/field-standard.spec.ts, apps/api/test/field-rules.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Role for {member} | Select | ChangeMember contracts:804 | — | Meets the standard |
| {member} approves refills | raw checkbox | ChangeMember.approvesRefills | — | Meets the standard |
| Add people: Emails | Textarea required (several emails, optional "Name <email>"); max **—**; autoComplete **—** | client splits, lowercases and checks a regex (team/page.tsx:210-220); AddMember contracts:762 `z.email().max(200)`, name trim max 80; apps/api/src/team/team.controller.ts:77 trims and lowercases | no maxLength; no type=email possible (several addresses), so an email keyboard isn't offered; ac-off missing; error not tied; typed names aren't checked with HAS_NAME | Fixed: maxLength 5000, autoComplete off, "Not an email address" tied (aria-invalid, aria-describedby) |
| Add people: Role for {email} | Select | AddMember.role | — | Meets the standard |
| Add people: Approves refills | Checkbox | AddMember.approvesRefills | — | Meets the standard |
| Add people: Invite to all locations | Checkbox | AddMember.allLocations contracts:764 | — | Meets the standard |

### Pet page: delete and merge

Files: components/patients/record-tools.tsx. Tests: e2e/pets.spec.ts, apps/api/test/patient-removal.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Delete: this pet or the household | raw input type=radio (fieldset, sr-only legend) | PatientDelete contracts:629 | — | Meets the standard |
| Merge: kind | raw input type=radio | PatientMerge contracts:644 | — | Meets the standard |
| Merge: the other record (picker) | see the patients list row |  | — | Meets the standard |

### Import doctors / patients

Files: components/import-panel.tsx. Tests: e2e/doctors.spec.ts, apps/api/test/doctors.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Choose a CSV file | raw input type=file accept .csv (sr-only, inside a label) | ImportInput contracts:733 csv max 2,000,000 characters | the browser counts bytes and the server counts characters (slightly different limits) | Open (see "Still open" below) |

### Clinic switcher

Files: components/clinic-switcher.tsx. Tests: apps/web/test/clinic-switcher.test.ts.

| Field | Browser rule | Server rule | Before (gap) | After |
|---|---|---|---|---|
| Find a clinic | raw input type=search; autoComplete **—** | client filter only | ac-off missing (minor) | Fixed: maxLength 100, autoComplete off |
## Still open

Left for a later batch, each with what it needs:

- **Settings save errors sit in the section, not on the field.** A refused Settings save lists every problem by its
  field's name (in the section and in a dialog), so it is never silent, but no Settings input gets `aria-invalid`.
  Mapping each server path (`visitTypes.2.name`) to its input is one change across the Settings pages.
- **The Website field takes `http://`** in the browser and on the server, where every other address must be `https://`.
  Making it https only would refuse the next save of anything at a clinic with an old `http://` address stored: it
  needs a decision (refuse with a message, or turn `http://` into `https://` once).
- **Voice** is any string on the server; the browser offers a fixed list.
- **Visit type minutes** emptied sends 0, which the section message catches; **Wait for the usual vet** reverts an
  out-of-range number on leaving the field without a word.
- **Doctor panel:** the gender and visit-type errors open a dialog instead of sitting under their fields; the "Add a
  specialty" and "Add one to the list" boxes are not described by their own errors.
- **Integrations:** the per-endpoint "On" switch and "Leave out record ids" box do not name their endpoint.
- **Change password, set up two-step, profile password:** the Alert is not tied to the password field.
- **"Number to call as"** (test call): a refused start is said on the page, not under the field.
- **Import:** the browser counts the 2 MB in bytes, the server in characters (a little different for non-English text).
- **Requests and Calls** (marked "parallel batch" above): search boxes without the 100-character limit in the browser
  (the server has it, `SEARCH_MAX`), the new request's "Call back on" allowing 30 characters where the server takes 20,
  its errors in one Alert, past due dates, and the Calls date range with no from-before-to link. Those screens were
  changed by the parallel batch at the same time, so they were left to it.

## Cloud, not changed here

The hosting layer's sign-up page (`attendra-cloud`, `src/app/signup/form.tsx`) and setup wizard
(`src/app/setup/[clinicId]/wizard.tsx`). As read on 2026-11-08:

| Page | Field | Browser rule as read | Note |
| --- | --- | --- | --- |
| Sign-up | Invite code | max 40, autoComplete off | |
| Sign-up | Clinic name | max 100, autoComplete organization | the engine's rename caps at 60 (`ClinicName`) |
| Sign-up | Your name | max 100, autoComplete name | the engine's profile name is 80 |
| Sign-up | Work email | type email, max 254, autoComplete email | |
| Sign-up | Password | type password, 12 to 128, new-password | |
| Sign-up | Country, Time zone | select | |
| Sign-up | Clinic phone number | type tel, inputMode tel, autoComplete tel, a numbers-only input handler | |
| Sign-up | Terms | checkbox, required | |
| Setup | Address | 5 to 200, street-address | |
| Setup | Your clinic's own line | type tel, inputMode tel, autoComplete tel, letters dropped with the note | |
| Setup | Opening hours | time pickers | |
| Setup | Vet name, phone, gender, animals | name 2 to 80; phone type tel, autoComplete off, letters dropped; animals max 40 | |
| Setup | Emergency hospital name, phone, address, hours; emergency line | the engine's `EMERGENCY_LIMITS`; phones type tel, letters dropped | |
| Setup | Website to read from | text, required | not `type="url"` |
| Setup | Questions and answers | the engine's `SETTINGS_LIMITS` | |
| Setup | Document title, file | max 200; pdf, txt, md | |
| Setup | Assistant name, voice | the engine's limits and pattern; select | |
