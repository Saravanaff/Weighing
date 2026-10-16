/**
 * Whether a line is maize.
 *
 * The PLC output is wired to the maize line alone, so this test has to survive
 * however the item was typed when it was created: "Maize", "MAIZE", " maize ",
 * "mAiZe", or the same word pasted with a full-width or a zero-width character
 * in it. It is also the one rule that decides whether a machine moves, so it
 * errs towards a strict match: only the item that *is* maize passes -- an
 * ingredient that merely contains the word, "Maize Bran" or "Maize Gluten",
 * does not.
 */

/**
 * Fold a name to the form the maize test compares: width-, case- and
 * whitespace-insensitive, with zero-width characters (the kind a copy-paste
 * drags in) removed. NFKC turns full-width letters into their ASCII
 * equivalents, so "MAIZE" typed in a full-width font compares equal to the
 * plain spelling.
 */
export const normalizeItemKey = (value: string | null | undefined): string =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** The normalised form of the one item name that switches the PLC on. */
export const MAIZE_KEY = 'maize';

/**
 * True when a name is maize in any casing, spacing or width the operator may
 * have used when the item was created.
 */
export const isMaizeName = (value: string | null | undefined): boolean =>
  normalizeItemKey(value) === MAIZE_KEY;

/**
 * True for a master item or a cart line that is maize. The name is checked
 * first; the slug is a fallback for a name the item master stored with
 * punctuation, such as "Maize." -- which the server slugs to `maize`.
 */
export const isMaizeItem = (
  item: { name?: string | null; slug?: string | null } | null | undefined,
): boolean => item != null && (isMaizeName(item.name) || isMaizeName(item.slug));
