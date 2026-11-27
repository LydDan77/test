// A check for the words this folder writes for people, used by its tests. The rules are the
// build spec's section 3: plain words, sentence case, no exclamation marks, en dashes for ranges,
// and none of the internal vocabulary.

/** Internal words a person must never see, with what they see instead. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/!/, "an exclamation mark"],
  [/—/, "an em dash"],
  [/\bshipments?\b/i, '"shipment" (say box, bag or package)'],
  [/\blodging\b/i, '"lodging" (say stay, or name the place)'],
  [/\bhand-?off\b/i, '"hand-off"'],
  [/\bitinerary\b/i, '"itinerary" (say schedule)'],
  [/\bbriefing\b/i, '"briefing" (say heads up)'],
  [/\bundefined\b|\bnull\b|\bNaN\b|\[object/, "a value that leaked into the text"],
  [/\d\s?-\s?\d+ (business |delivery |calendar )?(days|weeks|lb)\b/, "a hyphen in a range (use an en dash)"],
  [/ {2,}/, "a double space"],
  [/\b(utilize|leverage|please note|be aware|may potentially)\b/i, "jargon or filler"],
];

/**
 * What is wrong with a sentence written for a person, as a list of plain descriptions. Empty
 * when the text follows the rules.
 */
export function copyProblems(text: string): string[] {
  const problems: string[] = [];
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(text)) problems.push(what);
  }
  if (text.trim() !== text) problems.push("space at the start or end");
  if (text.length === 0) problems.push("empty text");
  return problems;
}

/** True for a full sentence: starts with a capital or a digit and ends with a full stop or question mark. */
export function isSentence(text: string): boolean {
  return /^[A-Z0-9"“$]/.test(text) && /[.?]$/.test(text);
}
