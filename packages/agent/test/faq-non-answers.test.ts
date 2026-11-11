// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { answerFromFaqs, isNonAnswer } from '../src/knowledge';

// Note 49 B5: a common question saved by a website import with "The website does not specify…" as its answer is
// never said to a caller: the question counts as not answered, and the assistant offers the team instead.
describe('a saved non-answer', () => {
  const faqs = [
    { id: 'faq_pay', question: 'What payment methods do you accept?', answer: 'The website does not specify payment methods or insurance information.' },
    { id: 'faq_bring', question: 'What should I bring?', answer: 'The website does not provide information about what to bring.' },
    { id: 'faq_board', question: 'Do you offer boarding?', answer: 'Yes, we offer boarding.' },
  ];
  it('is never the answer, and a real one still is', () => {
    expect(answerFromFaqs(faqs, 'How can I pay?')).toBeNull();
    expect(answerFromFaqs(faqs, 'What do I bring to the visit?')).toBeNull();
    expect(answerFromFaqs(faqs, 'Do you do boarding?')?.id).toBe('faq_board');
  });
  it.each(['El sitio web no especifica los métodos de pago.', "The site doesn't mention grooming."])('"%s" is no answer', (a) => expect(isNonAnswer(a)).toBe(true));
  it.each(['We do not offer grooming.', 'Our website has the new client form.'])('"%s" is an answer', (a) => expect(isNonAnswer(a)).toBe(false));
});
