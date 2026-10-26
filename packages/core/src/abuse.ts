// SPDX-License-Identifier: AGPL-3.0-only
import { normalise } from './locales/types';

/**
 * Insults or threats aimed at the person on the line, in English and Spanish. A caller
 * swearing out of frustration ("what the hell is going on", "what the fuck are you
 * doing") is upset, not abusive, and is helped like anyone else; so is a word that only
 * sounds rude in a clinic for animals ("she's a bitch", of a female dog). Matched on
 * the whole caller turn, after `normalise` (lower case, accents removed).
 */
const ABUSIVE: RegExp[] = [
  // at the listener
  /(?<!\bthe )\bf+u+c+k+ (you|u|off)\b/,
  /\b(screw|damn) you\b/,
  /\bgo to hell\b/,
  /\bshut (the f\w* )?up\b/,
  /\byou(?:'re| are)? (?:a |an |such a |fucking |stupid |useless |damn )*(idiot|moron|stupid|dumb|useless|retard\w*|bitch|asshole|bastard|piece of (shit|crap)|loser|scumbag|cunt|dick|prick|jerk)\b/,
  /\b(stupid|dumb|useless|fucking|damn|bloody) (bot|robot|machine|computer|ai|thing)\b/,
  /\b(motherfucker|cunt)\b/,
  // threats
  /\bi(?:'ll| will| am going to|'m going to|'m gonna| gonna) (kill|hurt|beat|shoot|stab|find) (you|u)\b/,
  // Spanish, tu and usted
  /\b(vete|vayase) a la (mierda|chingada)\b|\b(vete|vayase) al (diablo|carajo|infierno)\b/,
  /\b(callate|callese|callense)\b/,
  /\b(chinga tu madre|chingate|jodete|que te jodan|que lo jodan)\b/,
  /\b(eres|es usted|usted es) (un |una )?(idiota|estupid[oa]|imbecil|pendej[oa]|inutil|tont[oa])\b/,
  /\b(idiota|imbecil|pendej[oa]|cabron|hijo de puta|hija de puta|malparid[oa])\b/,
  /\bte voy a (matar|golpear|encontrar)\b|\bvoy a (matarte|golpearte)\b/,
  /\b(maldit[oa]|estupid[oa]|pinche|inutil) (robot|bot|maquina|computadora)\b/,
  /\b(robot|bot|maquina|computadora) (estupid[oa]|inutil|idiota|de mierda|maldit[oa])\b/,
];

export function isAbusive(text: string): boolean {
  const t = normalise(text);
  return ABUSIVE.some((p) => p.test(t));
}
