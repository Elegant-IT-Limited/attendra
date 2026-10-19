// SPDX-License-Identifier: AGPL-3.0-only

/** A list in its new order after one item moved from one place to another. The list given is left as it was. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
