import { describe, expect, it } from 'vitest';
import { readDoctors, RIVERBEND_CLINIC } from '../src';

// the vet import's row messages in the file's own words (note 52 C2): the day column and a time, never the stored shape
const vets = { ...RIVERBEND_CLINIC, industry: 'vet' as const, providers: [] };
const message = (csv: string, clinic: Parameters<typeof readDoctors>[1] = vets) => {
  const [row] = readDoctors(csv, clinic);
  return row!.ok ? null : row!.message;
};

describe('import messages a practice manager can act on', () => {
  it('a working hour that is not a time of day names the day column and the cell, as a time like 08:00-12:00', () => {
    expect(message('name,phone,mon\nTessa Brook,(303) 555-0171,25:00-26:00\n')).toBe('mon: 25:00-26:00 is not a time like 08:00-12:00');
    expect(message('name,phone,tue\nTessa Brook,(303) 555-0171,9am to 5pm\n')).toBe('tue: 9am to 5pm is not a time like 08:00-12:00');
    expect(message('name,phone,wed\nTessa Brook,(303) 555-0171,08:60-12:00\n')).toBe('wed: 08:60-12:00 is not a time like 08:00-12:00');
    expect(message('name,phone,thu\nTessa Brook,(303) 555-0171,13:00-12:00\n')).toBe('thu: 13:00-12:00 closes before it opens');
    // never a schema path
    expect(message('name,phone,mon\nTessa Brook,(303) 555-0171,25:00-26:00\n')).not.toMatch(/hours\.\d|expected HH:MM/);
  });

  it('says veterinarian at a vet clinic and doctor at a medical one', () => {
    const twice = readDoctors('name,phone\nTessa Brook,(303) 555-0171\nTessa Brook,(303) 555-0172\n', vets);
    expect(twice[1]).toMatchObject({ ok: false, message: 'this veterinarian is in the file twice' });
    expect(message('id,name,phone\nprov_nobody,Tessa Brook,(303) 555-0171\n')).toBe('no veterinarian on file has the id prov_nobody; leave id empty to add them');
    const medical = readDoctors('name,phone\nLee Park,(303) 555-0173\nLee Park,(303) 555-0174\n', { ...vets, industry: 'clinic' });
    expect(medical[1]).toMatchObject({ ok: false, message: 'this doctor is in the file twice' });
  });
});

describe('imported list items follow the one display rule (note 52 C3)', () => {
  it('a kind of animal or a category an import adds is kept in sentence case, like the starter list', async () => {
    const { listItemCase, managedList, withListValues } = await import('../src');
    const clinic = { ...vets, lists: { species: ['Dog', 'Cat'] } };
    const next = withListValues(clinic, 'species', ['rabbit', 'hedgehog', 'dog']);
    expect(next.lists?.species).toEqual(['Dog', 'Cat', 'Rabbit', 'Hedgehog']);
    expect(managedList(withListValues({ ...vets, lists: { categories: ['Dogs'] } }, 'categories', ['exotic birds']), 'categories')).toEqual(['Dogs', 'Exotic birds']);
    // only the first letter changes; what was typed after it is kept
    expect(listItemCase('  MRI scans ')).toBe('MRI scans');
    expect(listItemCase('ñandú')).toBe('Ñandú');
  });
});

describe('a Word file at the knowledge upload (note 52 C15)', () => {
  it('is named as one, and the message gives the way through', async () => {
    const { isWordFile, UNSUPPORTED_UPLOAD } = await import('../src');
    expect(['prices.docx', 'old.DOC', 'notes.odt', 'menu.rtf', 'list.pages'].every(isWordFile)).toBe(true);
    expect(['prices.pdf', 'notes.txt', 'faq.md', 'docx.pdf'].some(isWordFile)).toBe(false);
    expect(UNSUPPORTED_UPLOAD).toBe('Upload a PDF, a text file or a markdown file. A Word file? Save it as PDF from Word, then upload it.');
  });
});
