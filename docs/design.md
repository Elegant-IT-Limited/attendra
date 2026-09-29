# Design

The dashboard is clinic software, used for hours at a time by people who are also on the phone. It should feel calm, fast and exact: no gradients on data, no glass, no bouncing, no tricks. This page is the reference for how it looks and reads.

## Tokens

Everything is in `apps/web/app/globals.css`, as Tailwind `@theme` variables. Pages and components use the names below and never a colour value of their own, so light and dark are one set of names with two sets of values.

| Token | Class | Use |
|---|---|---|
| `background` | `bg-background` | The page behind everything |
| `surface` | `bg-surface` | Cards, the sidebar, tables |
| `surface-raised` | `bg-surface-raised` | Dialogs, panels, menus, toasts |
| `surface-sunken` | `bg-surface-sunken` | Hover fills, skeletons, quiet wells |
| `border`, `border-strong` | `border-border`, `border-border-strong` | Dividers; control outlines |
| `text`, `text-muted` | `text-text`, `text-text-muted` | Body text; secondary text |
| `primary`, `on-primary`, `primary-soft` | `bg-primary` and so on | The one action colour (teal), text on it, and its tint |
| `success`, `warning`, `danger`, `info`, each with `-soft` | `text-danger`, `bg-warning-soft` | States. Soft variants are backgrounds for badges and alerts |
| `focus` | the `focus-ring` utility | The one focus ring |

Every text and background pair passes WCAG 2.2 AA in both themes. The e2e suite runs axe on every main page, in light and dark, and fails on a serious or critical issue.

**Type.** Inter, self-hosted with `next/font/local`, with Noto Sans Bengali next in the stack so a line that mixes Bangla and English renders each script properly. One scale: `text-xs` 12, `text-sm` 13, `text-base` 14 (body), `text-md` 16, `text-lg` 20, `text-xl` 24 (page titles), `text-2xl` 30. Figures, times and counts are tabular everywhere.

**Shape.** A 4 px grid (Tailwind's spacing). Three radii: `rounded-sm` 6, `rounded-md` 8, `rounded-lg` 12. Two shadows: `shadow-xs` for things on the page, `shadow-lg` for things above it.

**Motion.** 150 to 200 ms, ease out, for panels, popovers, toasts and hover only. Numbers count to a new value when it changes, never on first load. `prefers-reduced-motion` turns all of it off.

**Themes.** System, light or dark, chosen in the account menu or the command palette and kept in this browser. A script in `<head>` applies it before the first paint.

## Components

All in `apps/web/components/ui`.

| Component | When |
|---|---|
| `Button` | Every action. `primary` for the one main action on a screen, `outline` for the rest, `ghost` in rows and toolbars, `danger` only to confirm something destructive. `loading` while it works. |
| `Input`, `Select`, `Textarea`, `DatePicker`, `Field` | Forms. `Field` ties a label, a hint and an inline error to its control. |
| `Checkbox`, `Switch`, `RadioGroup` | A choice to confirm; a setting that is on or off; one of a few visible options. |
| `Badge`, `StatusPill` | A short label on a row; a state with a dot (`live` pulses). |
| `Card` | A group of related content on a page. |
| `Table`, `SortTH` | Lists of records. Sticky header, row hover, `density="compact"` for long lists, sorting where it helps. |
| `Tabs` | Views of one thing, like a patient's appointments, calls and requests. |
| `Panel` | A side panel (`side="right"`) for one record, or a centred dialog for a short task or a confirmation. Focus is trapped, Escape closes, focus returns. |
| `Popover`, `Menu`, `Tooltip` | Extra detail by its trigger; a few actions on one thing; a name for an icon or the exact time behind "12 min ago". |
| `useToast` | What just happened, in a live region, with Undo where undoing makes sense. |
| `Skeleton`, `Empty` | Loading; nothing here yet. An empty state says what will appear and offers one next step. |
| `Avatar`, `Kbd`, `StatCard`, `Sparkline`, `RelativeTime`, `AnimatedNumber` | People, keys, figures with a trend in plain SVG, and times. |

## Layout

Every page starts with `PageHeader`: a title, one line saying what the page is for, and its main action on the right. Content sits in one column width. The sidebar is full from 1280 px, icons only from 1024 px to a tablet, and on a phone a bottom bar with Today, Schedule, Requests and More. Touch targets are at least 44 px on a phone.

Changes show at once and put themselves back if the server refuses (claim, done, assign, notes). Anything destructive asks first, or offers Undo in the toast.

## Writing

- Plain, short and human. Say what happened and what to do next.
- Name things the way a front desk does: requests, not tasks; the assistant, not the model.
- No em dashes, no exclamation marks, no emoji, no jargon.
- Errors say what went wrong and the next step: "That time was just taken. Pick another one."

## Shortcuts

| Keys | Does |
|---|---|
| Cmd+K or Ctrl+K | Search and jump: pages, patients, New booking, a test call, the theme |
| G then T, S, P, R or C | Today, Schedule, Patients, Requests, Calls |
| N | New booking |
| ? | This list |

Letters do nothing while you type in a field or a dialog is open.
