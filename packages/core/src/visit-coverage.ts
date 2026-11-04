// SPDX-License-Identifier: AGPL-3.0-only
import { type ClinicConfig, localName, type Provider, type VisitType } from './clinic';
import { industryPack } from './industries';
import { type Language, packFor } from './locales';
import { bookableProviders } from './providers';

/**
 * Who does which visit type (2026-11-15). A vet who doesn't do a type is passed by when a caller asks for it, so a
 * type nobody does can't be booked at all: Settings warns about it, and a new vet starts with every type.
 */

/** Every visit type at the clinic: what a new vet, or an imported one with no visit types column, starts with. */
export const allVisitTypeIds = (clinic: Pick<ClinicConfig, 'visitTypes'>): string[] => clinic.visitTypes.map((v) => v.id);

/** Whether they do every visit type the clinic has ("All visit types" on their card). */
export const doesEveryVisitType = (provider: Pick<Provider, 'visitTypeIds'>, clinic: Pick<ClinicConfig, 'visitTypes'>): boolean =>
  clinic.visitTypes.every((v) => provider.visitTypeIds.includes(v.id));

/**
 * How many of the providers a caller can be offered do each visit type, in Settings' order. The stand-in a new clinic
 * starts with counts only while nobody else is listed, as everywhere else.
 */
export function visitTypeCoverage(clinic: Pick<ClinicConfig, 'providers' | 'visitTypes'>): { visitType: VisitType; providers: number }[] {
  const offered = bookableProviders(clinic.providers);
  return clinic.visitTypes.map((visitType) => ({ visitType, providers: offered.filter((p) => p.visitTypeIds.includes(visitType.id)).length }));
}

/** The visit types no bookable provider does: nobody can book them, on a call or at the desk. Unnamed new rows are left out. */
export const visitTypesWithNoProvider = (clinic: Pick<ClinicConfig, 'providers' | 'visitTypes'>): VisitType[] =>
  visitTypeCoverage(clinic).filter((c) => !c.providers && c.visitType.name.trim()).map((c) => c.visitType);

/**
 * Settings' warning for each visit type no provider does: "No vet does Dental care: callers can't book it". The one
 * source of these words: the API sends them with the list of vets, and Settings shows them from the same function.
 */
export function noProviderWarnings(clinic: Pick<ClinicConfig, 'providers' | 'visitTypes'> & Partial<Pick<ClinicConfig, 'industry'>>, language: Language = 'en'): { visitTypeId: string; message: string }[] {
  const pets = industryPack(clinic.industry).identity === 'pet';
  return visitTypesWithNoProvider(clinic).map((v) => ({ visitTypeId: v.id, message: packFor(language).noProviderForVisit({ visit: localName(v, language), pets }) }));
}
