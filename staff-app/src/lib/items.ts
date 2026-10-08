import type { LangCode, NameBearing } from './types.ts';

export type { Item, LangCode, NameBearing } from './types.ts';

export const VOICE_LANGS: Array<{ code: LangCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi / हिन्दी' },
  { code: 'bn', label: 'Bengali / বাংলা' },
  { code: 'ta', label: 'Tamil / தமிழ்' },
];

/** Falls back to the English name when a translation is missing. */
export function localizedName(item: NameBearing, lang: LangCode): string {
  return (item.names && item.names[lang]) || item.name;
}
