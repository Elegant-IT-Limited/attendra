// SPDX-License-Identifier: AGPL-3.0-only
import { clinic } from './clinic';
import { type Industry, type IndustryPack, INDUSTRIES } from './types';

export * from './types';

export const INDUSTRY_PACKS: Record<Industry, IndustryPack> = { clinic };

/** The pack for an account's industry; anything unknown gets the clinic pack, the default. */
export const industryPack = (id: string | undefined): IndustryPack =>
  (INDUSTRIES as readonly string[]).includes(id ?? '') ? INDUSTRY_PACKS[id as Industry] : clinic;

/** "Doctors" from "doctors": for headings and menu items. */
export const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
