// SPDX-License-Identifier: AGPL-3.0-only
import { DEMO_CLINIC } from '@attendra/core';
import { type Database, KnowledgeRepository } from '@attendra/db';
import type { Embedder } from './embed';
import { indexDocument } from './ingest';

/** The demo clinic's own documents: invented policies for a fictional practice. */
export const DEMO_DOCUMENTS = [
  {
    title: 'Parking and directions',
    text: `# Parking
Parking is free in the lot behind the building. Enter from 3rd Avenue; the spaces marked Suite 3 are ours. There is no time limit during your visit.

# By bus
The 10 and 15 buses stop at Maple Street and 3rd Avenue, a two-minute walk from the front door.

# Getting in
The front door has a ramp, and the elevator goes to Suite 3 on the second floor. Check in at the front desk when you arrive.`,
  },
  {
    title: 'Insurance we accept',
    text: `# Plans we accept
We accept Aetna, Cigna, UnitedHealthcare, Anthem Blue Cross and Medicare. We do not accept Medicaid managed care plans at this time.

# What to bring
Bring your insurance card and a photo ID to every visit. If your plan has changed, tell the front desk when you book.

# Paying yourself
A sick visit without insurance is $120 and an annual physical is $240, paid at the visit.`,
  },
  {
    title: 'Preparing for blood work',
    text: `# Fasting
For fasting blood work, do not eat for 8 hours before your appointment. Water is fine, and so is black coffee without sugar.

# When to come
Morning appointments are best for fasting tests. Results are posted to the patient portal within three business days.`,
  },
  {
    title: 'Medications and refills',
    text: `# Refills
Refill requests are reviewed by the care team within two business days. Ask your pharmacy to send the request, or call us.

# Bring your list
Patients taking metformin or blood pressure medicine should bring an up-to-date list of their medications to every visit.

# Questions about doses
The front desk cannot answer questions about doses or side effects. The care team will call you back.`,
  },
] as const;

/** Uploads and indexes the demo documents. Safe to run twice: unchanged documents are left alone. */
export async function seedDemoKnowledge(db: Database, embedder: Embedder, uploadedBy = 'seed') {
  const repo = new KnowledgeRepository(db);
  for (const d of DEMO_DOCUMENTS) {
    const { id } = await repo.save(DEMO_CLINIC.id, { title: d.title, sourceType: 'markdown', content: Buffer.from(d.text), userId: uploadedBy });
    await indexDocument(repo, embedder, DEMO_CLINIC.id, id);
  }
}
