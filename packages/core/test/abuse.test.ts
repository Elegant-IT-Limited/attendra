import { describe, expect, it } from 'vitest';
import { isAbusive } from '../src';

describe('abusive language', () => {
  it('is an insult or a threat aimed at the person on the line', () => {
    for (const t of ['Fuck you.', 'You are a stupid idiot', "you're useless", 'Stupid robot!', 'Shut up', 'Go to hell', "I'll find you",
      'Vete a la mierda', 'Eres un idiota', 'Cállate', 'Te voy a matar', 'maldita máquina']) expect(isAbusive(t), t).toBe(true);
  });

  it('is not a caller swearing because they are upset, or a word for a female dog', () => {
    for (const t of ['What the fuck you are doing?', 'What the hell is going on', 'This is so frustrating', 'Damn it, I forgot', "She's a bitch, a spayed one",
      'My dog is stupid sometimes', 'I just told you a couple of minutes ago', 'Qué carajo pasa', 'No, gracias']) expect(isAbusive(t), t).toBe(false);
  });
});
