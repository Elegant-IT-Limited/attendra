// SPDX-License-Identifier: AGPL-3.0-only
// Writes the two PDFs the chunking tests read: a price list with no punctuation and no blank lines over 3 pages, and a
// 12-page policy document in paragraphs. Made-up content for an invented clinic. Built by hand (fonts, pages, an xref
// table), as real PDFs are, so they need no PDF library. Run once after a change, and commit the files:
//   pnpm exec tsx packages/knowledge/test/fixtures/make-pdfs.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A PDF with these pages, each a list of lines set in Helvetica from the top of the page down. */
export function pdfOf(pages: string[][], fontSize = 9, leading = 11): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  // objects 1 to 3: catalog, page tree, font; then a content stream and a page for each page
  const first = 4;
  const pageIds = pages.map((_, i) => first + i * 2 + 1);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((lines, i) => {
    const stream = `BT /F1 ${fontSize} Tf ${leading} TL 50 760 Td\n${lines.map((l) => `(${escape(l)}) Tj T*`).join('\n')}\nET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${first + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The line that answers "what's in the price?", on the price list's second page. */
export const DENTAL_LINE = 'Dental cleaning price includes exam anaesthesia scaling and polishing 350';
/** Words from the policy document's callback page, which answers "call me back". */
export const CALLBACK_WORDS = 'a member of the front desk team will call you back within one business day';

/** 195 lines of services and prices, 65 a page: no sentence ends, no blank lines, as a price list comes out of a PDF. */
export function priceList(): string[][] {
  const services = [
    'Wellness exam', 'Sick visit exam', 'Recheck exam', 'Rabies vaccine', 'Distemper parvo vaccine', 'Leptospirosis vaccine', 'Bordetella vaccine', 'Feline leukemia vaccine',
    'Heartworm test', 'Fecal test', 'Blood panel basic', 'Blood panel senior', 'Urinalysis', 'Microchip with registration', 'Nail trim', 'Anal gland expression',
    'Ear cleaning', 'Spay surgery', 'Neuter surgery', 'Tooth extraction simple', 'Digital x-ray two views', 'Ultrasound abdomen', 'Health certificate for travel',
    'Overnight hospital stay', 'Boarding per night', 'Bath and brush', 'Euthanasia private', 'Cremation communal', 'Allergy injection', 'Weight check',
  ];
  const kinds = ['small dog under 20 lb', 'medium dog 20 to 50 lb', 'large dog over 50 lb', 'cat any size', 'rabbit or small pet', 'senior pet over 8 years', 'puppy or kitten under 6 months'];
  const lines: string[] = [];
  for (let i = 0; lines.length < 194; i++) {
    const service = services[i % services.length]!;
    const kind = kinds[Math.floor(i / services.length) % kinds.length]!;
    lines.push(`${service} ${kind} ${35 + ((i * 37) % 400)}`);
  }
  lines.splice(80, 0, DENTAL_LINE);
  lines.unshift('Willowbrook Veterinary Clinic price list 2026');
  return [lines.slice(0, 65), lines.slice(65, 130), lines.slice(130, 195)];
}

/** Twelve pages of policies, a topic a page, in wrapped paragraphs; the callback policy is on page 9. */
export function policies(): string[][] {
  const topics: [string, string[]][] = [
    ['Booking a visit', ['Visits can be booked online or with the front desk during opening hours.', 'New clients are asked to arrive ten minutes early to fill in a short form about their pet.']],
    ['Cancelling a visit', ['Please cancel at least 24 hours before the visit so another pet can be seen.', 'A visit missed without notice twice in a year may need a deposit to book again.']],
    ['Arriving late', ['If you arrive more than 15 minutes late, the vet may ask you to rebook so the next pet is seen on time.', 'Late arrivals for surgery drop-off are rebooked for the next free morning.']],
    ['Paying for care', ['Payment is due when the visit ends, by card, cash or a mobile wallet.', 'Estimates for surgery are given in writing before the day and are valid for thirty days.']],
    ['Deposits for surgery', ['Surgery is booked with a deposit of half the estimate, refunded in full when cancelled two days ahead.', 'The deposit is taken off the final bill on the day of surgery.']],
    ['Vaccines for boarding', ['Dogs that board with us need rabies, distemper parvo and bordetella vaccines at least a week before the stay.', 'Cats that board need rabies and the core feline vaccines.']],
    ['Puppy and kitten visits', ['The first puppy or kitten visit includes an exam, the first vaccines and a talk about feeding and training.', 'Bring any records from the breeder or shelter to the first visit.']],
    ['After hours', ['When the clinic is closed, emergencies go to the Lakeside Animal Emergency Hospital on Harbor Road.', 'The emergency hospital sends us a report the next morning, and we follow up with you.']],
    ['Callbacks', ['If you ask for a callback, ' + CALLBACK_WORDS + '.', 'A callback about test results comes from the vet who ordered them, usually the same afternoon.', 'Tell us the best number and the hours you can take the callback, and we will call you back then.']],
    ['Medical records', ['A copy of your pet\'s records is sent to you or to another clinic within three business days of asking.', 'Records are kept for at least seven years after the last visit.']],
    ['Preparing for surgery', ['No food after midnight before surgery, but water is fine until the morning.', 'Drop-off is between seven and eight in the morning, and most pets go home the same evening.']],
    ['Our vets', ['Dr. Rosa Lindqvist sees cats and small pets, and Dr. Omar Pellegrino sees dogs and does most surgery.', 'Both vets see emergencies during opening hours.']],
  ];
  // the rest of each page: plain sentences about the topic, enough to fill it, that never mention calling
  const filler = [
    'The team explains this policy at the front desk and on our website.', 'Questions about it are welcome at any visit.', 'We review this policy every year and post any change in the waiting room.',
    'It applies to every pet and every owner in the same way.', 'Exceptions are made only by the practice manager.', 'The policy helps the clinic run on time for every pet.',
    'Our staff are glad to go through it with you in person.', 'A printed copy is kept at reception.', 'This policy was last updated in January 2026.',
  ];
  return topics.map(([title, own], p) => {
    const sentences = [...own];
    for (let i = 0; sentences.join(' ').length < 2600; i++) sentences.push(`${title}: ${filler[(i + p) % filler.length]!.replace(/^./, (c) => c.toLowerCase())}`);
    return [title, ...wrap(sentences.join(' '), 90)];
  });
}

/** Text in lines of at most `width` characters, broken at spaces. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL('./price-list.pdf', import.meta.url), pdfOf(priceList()));
  writeFileSync(new URL('./policies.pdf', import.meta.url), pdfOf(policies()));
  process.stdout.write('wrote price-list.pdf and policies.pdf\n');
}
