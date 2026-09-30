// SPDX-License-Identifier: AGPL-3.0-only
import { fold, type LanguagePack, words } from './types';

/*
 * Bangla, experimental. Standard spoken Bangla (cholito bhasha), always "apni",
 * never "tumi". Callers mix Bangla and English ("test er report kobe pabo"), and a
 * transcriber may return either script, so every phrase below is written in
 * Bengali script and in the romanised spellings people and transcribers use.
 * A native speaker must check the voice before this is used with patients
 * (docs/languages.md).
 */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
const DIGIT_WORDS = ['শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়'];
const DAYS = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'];
// in Dhaka the months of a date are said in English
export const BN_MONTHS = ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'];

export const bnDigits = (s: string | number) => String(s).replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);
/** Bengali digits back to ASCII, for anything a caller says that code must read. */
export const asciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

/** সকাল, দুপুর, বিকেল, সন্ধ্যা or রাত: the part of the day a Dhaka time is said with. */
function partOfDay(hour24: number) {
  if (hour24 >= 4 && hour24 < 12) return 'সকাল';
  if (hour24 >= 12 && hour24 < 15) return 'দুপুর';
  if (hour24 >= 15 && hour24 < 18) return 'বিকেল';
  if (hour24 >= 18 && hour24 < 20) return 'সন্ধ্যা';
  return 'রাত';
}

/** "সোমবার, ৬ অক্টোবর, বিকেল ৩টা" or "সকাল ৯টা ৩০ মিনিট". */
function when(start: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', day: 'numeric', month: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(start).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  const h24 = Number(parts.hour);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const minutes = Number(parts.minute);
  const time = `${partOfDay(h24)} ${bnDigits(h12)}টা${minutes ? ` ${bnDigits(minutes)} মিনিট` : ''}`;
  return `${DAYS[weekday]}, ${bnDigits(parts.day!)} ${BN_MONTHS[Number(parts.month) - 1]}, ${time}`;
}

export const bn: LanguagePack = {
  code: 'bn',
  name: 'Bangla',
  nativeName: 'বাংলা',
  experimental: true,
  locale: 'bn-BD',
  prompt: [
    'If the caller speaks Bangla, answer in standard spoken Bangla (cholito bhasha). Always say "apni", never "tumi". Be polite and warm, as a good front desk in Dhaka would be.',
    'Callers often mix Bangla and English, for example "test er report kobe pabo". Understand both, and answer in the language the caller mostly uses. Test names and doctor names can stay in English.',
    'Say dates and times the way they are given to you, read phone numbers digit by digit, and say prices in taka.',
    'When you pass a name to the backend, write it in English letters, as the clinic\'s register does: "Rahima Khatun", not "রহিমা খাতুন".',
  ],
  greeting: ({ assistantName, clinicName }) => `${clinicName}-এ ফোন করার জন্য ধন্যবাদ। ${assistantName ? `আমি ${assistantName}, এখানকার এআই সহকারী।` : 'আমি এখানকার এআই সহকারী।'} আপনাকে কীভাবে সাহায্য করতে পারি?`,
  disclosure: words('(এআই|এ আই|কৃত্রিম বুদ্ধিমত্তা|ভার্চুয়াল) ?(সহকারী|অ্যাসিস্ট্যান্ট|রিসেপশনিস্ট)|ai (assistant|shohokari|sohokari)'),
  speakWhen: when,
  speakPhone: (e164) => e164.replace(/\D/g, '').replace(/^880/, '0').split('').map((d) => DIGIT_WORDS[Number(d)]).join(' '),
  readbackBooking: ({ when: w, provider, visit, replacing }) => `${w}, ${provider}-এর কাছে, ${visit}${replacing ? `, আগের ${replacing}-এর বদলে` : ''}`,
  readbackCancel: ({ when: w }) => `${w}-এর অ্যাপয়েন্টমেন্ট বাতিল করা`,
  sms: {
    booking_confirmed: (v) => `${v.clinic}: আপনার অ্যাপয়েন্টমেন্ট ${v.when}। বদলাতে বা বাতিল করতে ${v.clinicPhone} নম্বরে ফোন করুন।`,
    booking_cancelled: (v) => `${v.clinic}: ${v.when}-এর অ্যাপয়েন্টমেন্ট বাতিল হয়েছে। নতুন সময় নিতে ${v.clinicPhone} নম্বরে ফোন করুন।`,
  },
  emergencyScript: (n) =>
    'The caller may be describing a medical emergency. Stop the current task now. Say, in Bangla, calmly and clearly: ' +
    `"এটা যদি জরুরি অবস্থা হয়, দয়া করে এখনই ফোন রেখে ${bnDigits(n)} নম্বরে কল করুন।" ` +
    'Do not give medical advice, do not ask about symptoms, and do not continue booking. ' +
    'If the caller says they are safe and it is not an emergency, you may continue.',
  selfHarmScript: (n, crisis) =>
    'The caller may be at risk of harming themselves. Stop the current task. Say, in Bangla, calmly and kindly: ' +
    `"আপনি ফোন করেছেন, এতে আমি সত্যিই খুশি। আপনি যদি এখনই বিপদে থাকেন, দয়া করে ${bnDigits(n)} নম্বরে কল করুন।"` +
    (crisis ? ` Then give the crisis line ${crisis}.` : '') +
    ' Stay warm and brief. Do not give medical advice.',
  emergencyPhrases: [
    ['cardiac', words('বুকে (খুব |অনেক )?ব্যথা|বুক ব্যথা|বুকে চাপ|হার্ট অ্যাটাক|buke (khub |onek )?(betha|bytha|batha|byatha|bettha)|buk (betha|bytha|batha|byatha)|buke chap')],
    ['breathing', words('শ্বাস নিতে (পারছি|পারছে|পারছেন|পারি|পারে) না|শ্বাস নিতে কষ্ট( হচ্ছে)?|শ্বাসকষ্ট|(shash|shas|swash|sas) (nite|nete) (kosto|koshto|kashto)|দম (বন্ধ|আটকে)|(shash|shas|swash|sas) (nite|nete) (parchi|parche|parchen|pari|pare) na|(shash|shas|swas|sas)(h)?ko(sh)?to|dom (bondho|atke)')],
    ['stroke', words('স্ট্রোক( করেছে| হয়েছে)?|মুখ বেঁকে (গেছে|যাচ্ছে)|হাত পা অবশ|(stroke) (koreche|korse|hoyeche)|mukh (beke|benke) (geche|gese|jacche)|hat pa obosh')],
    ['allergic', words('গলা ফুলে (যাচ্ছে|গেছে)|জিভ ফুলে (যাচ্ছে|গেছে)|gola (fule|phule) (jacche|jache|geche)|jib (fule|phule) (jacche|geche)')],
    ['overdose', words('বিষ খেয়েছে|বিষ খেয়ে ফেলেছে|অনেকগুলো ওষুধ খেয়ে ফেলেছে|(bish|bis) (kheyeche|kheyese|kheye felse|kheye felche)')],
    ['unresponsive', words('অজ্ঞান|জ্ঞান (নেই|হারিয়েছে|হারিয়ে ফেলেছে|ফিরছে না)|সাড়া দিচ্ছে না|খিঁচুনি|(o)?gg?y?an( hoye)?|(g|gy)an (nei|harie|hariye)|sara dicche na|khichuni')],
    ['bleeding', words('(অনেক|প্রচুর) রক্ত|রক্ত (পড়ছে )?(থামছে|বন্ধ হচ্ছে) না|রক্তবমি|(onek|prochur) (rokto|rakto)|(rokto|rakto) (porche )?(thamche|bondho hocche) na|rokto ?bomi')],
    ['self_harm', words('আত্মহত্যা|মরে যেতে চাই|বাঁচতে চাই না|নিজেকে শেষ করে|নিজের ক্ষতি|at+o?m?ohot+a|a(t|th)mo ?hot+a|more jete chai|bach?te chai na|nijeke shesh kore|nijer (khoti|kkhoti)')],
    ['general', words('জরুরি|ইমার্জেন্সি|অ্যাম্বুলেন্স|৯৯৯|999|joruri|jaruri|emergency|ambulance')],
  ],
  notAnEmergency: words('জরুরি (না|নয়)|joruri (na|noy)|emergency na'),
  yes: words('জি|জ্বি|হ্যাঁ|ঠিক আছে|করুন|ji|jee|hya|hyan|haan|thik ache|thik ase|korun'),
  // short words that mean yes alone, and something else inside a sentence
  yesAlone: new RegExp(`^(${fold('হাঁ|হ্যা|আচ্ছা|কনফার্ম|ha|haa|accha|acha|achha|confirm|ji confirm|জি কনফার্ম')})$`, 'u'),
  hedge: new RegExp(`${words('না|দাঁড়ান|দাড়ান|পরে|মনে হয়|অন্য দিন|একটু|কিন্তু|তবে|আর একটা|তাহলে|na|daran|darao|pore|mone hoy|onno din|ektu|kintu|tobe|ar ekta|tahole').source}|[?]`, 'u'),
  markers: /[ঀ-৿]+|\b(ami|apni|apnar|amar|ki|kobe|kothay|koto|ache|nai|nei|chai|korte|pabo|diben|bolen|report er|test er|na|ji|hobe|kalke|aj|bhai|apa)\b/g,
};
