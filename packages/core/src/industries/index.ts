// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from 'zod';
import { ToolArgs, type ToolName } from '../tools';
import { clinic } from './clinic';
import { vet } from './vet';
import { type Industry, type IndustryPack, INDUSTRIES } from './types';

export * from './types';

export const INDUSTRY_PACKS: Record<Industry, IndustryPack> = { clinic, vet };

/** The pack for an account's industry; anything unknown gets the clinic pack, the default. */
export const industryPack = (id: string | undefined): IndustryPack =>
  (INDUSTRIES as readonly string[]).includes(id ?? '') ? INDUSTRY_PACKS[id as Industry] : clinic;

/** "Doctors" from "doctors": for headings and menu items. */
export const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** The arguments each tool takes in this industry: the clinic's, with the pack's own where it has them. */
export function toolArgsFor(id: string | undefined): Record<ToolName, z.ZodType> {
  return { ...ToolArgs, ...industryPack(id).toolArgs };
}
