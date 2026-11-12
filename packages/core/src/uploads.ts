// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a knowledge upload that is not a PDF, a text or a markdown file is told, in Settings and by the API alike.
 * Clinics often keep their price lists and policies in Word (note 52 C15): the way through is in the same sentence.
 * Reading Word files is for after launch.
 */
export const UNSUPPORTED_UPLOAD = 'Upload a PDF, a text file or a markdown file. A Word file? Save it as PDF from Word, then upload it.';

/** A file that a person will recognise as a Word document by its name (.docx, .doc, .odt, .rtf, .pages). */
export const isWordFile = (name: string) => /\.(docx?|odt|rtf|pages)$/i.test(name.trim());
