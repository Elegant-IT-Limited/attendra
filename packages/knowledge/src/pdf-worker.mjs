// SPDX-License-Identifier: AGPL-3.0-only
// Reads a PDF's text in its own thread, so a hostile or broken PDF can use up only this
// thread's memory and time, never the service's. Plain JavaScript on purpose: a worker
// thread starts without the TypeScript loader. It answers once, with { text } or
// { error: code }, and never with anything from the document in an error.
import { parentPort, workerData } from 'node:worker_threads';
import { extractText, getDocumentProxy } from 'unpdf';

const { bytes, maxPages, maxChars } = workerData;
let answer;
try {
  // no eval: a PDF's fonts and functions are never compiled into code
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false });
  if (pdf.numPages > maxPages) answer = { error: 'too_many_pages' };
  else {
    const { text } = await extractText(pdf, { mergePages: false });
    const joined = (Array.isArray(text) ? text : [text]).join('\n\n');
    answer = joined.length > maxChars ? { error: 'too_much_text' } : { text: joined };
  }
} catch {
  answer = { error: 'pdf_unreadable' };
}
parentPort.postMessage(answer);
