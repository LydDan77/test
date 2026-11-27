// Getting pasted text into a shape the readers can work on: one clean line per line, quoted
// email markers and forwarded headers taken off, and the "sent" date of the email kept aside.

export type Prepared = {
  /** The cleaned text, lines joined with "\n". */
  text: string;
  /** The cleaned lines, trimmed, with empty ones removed. */
  lines: string[];
  /** The raw words of the email's own "Date:" or "Sent:" header, when it was forwarded with one. */
  sentHeader?: string;
};

const HEADER_LINE = /^(from|to|cc|bcc|reply-to|sent|date|subject)\s*:\s*(.*)$/i;
const FORWARD_MARKER = /^-{2,}\s*(forwarded message|original message)\s*-{2,}$|^begin forwarded message:?$/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * Cleans pasted confirmation text.
 *  - "> " quote markers (any depth) are removed from the start of lines;
 *  - a block of email headers (From, Date, Subject, To …) is removed, so the day the email was
 *    SENT is never mistaken for a travel date; the subject's words are kept as a line;
 *  - non-breaking and zero-width spaces, tabs and runs of spaces become one space.
 */
export function prepare(raw: string): Prepared {
  const normalised = decodeEntities(raw)
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[   \t]/g, " ");
  const rawLines = normalised.split("\n").map((line) => line.replace(/^(\s*>)+\s?/, "").replace(/ {2,}/g, " ").trim());

  // Find header blocks: two or more header lines in a row that look like an email's (an
  // address, or a Subject line). "From: Seattle / To: Orlando" in a ticket is left alone.
  const isHeaderBlock = new Array<boolean>(rawLines.length).fill(false);
  for (let i = 0; i < rawLines.length; i++) {
    if (!HEADER_LINE.test(rawLines[i])) continue;
    let end = i;
    while (end + 1 < rawLines.length && HEADER_LINE.test(rawLines[end + 1])) end++;
    const run = rawLines.slice(i, end + 1);
    const emailLike = run.some((line) => /^subject\s*:/i.test(line) || /@|<[^>]+>/.test(line));
    if (run.length >= 2 && emailLike) for (let j = i; j <= end; j++) isHeaderBlock[j] = true;
    i = end;
  }

  let sentHeader: string | undefined;
  const lines: string[] = [];
  rawLines.forEach((line, index) => {
    if (!line || FORWARD_MARKER.test(line)) return;
    if (isHeaderBlock[index]) {
      const match = HEADER_LINE.exec(line);
      const name = match?.[1].toLowerCase();
      if ((name === "date" || name === "sent") && !sentHeader) sentHeader = match?.[2];
      if (name === "subject" && match?.[2]) {
        const subject = match[2].replace(/^((fwd?|re)\s*:\s*)+/i, "").trim();
        if (subject) lines.push(subject);
      }
      return;
    }
    lines.push(line);
  });
  return { text: lines.join("\n"), lines, sentHeader };
}

/** The text after a label on its own line, or on the next line when the label line ends there. */
export function valueAfterLabel(lines: readonly string[], label: RegExp): { value: string; line: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const match = label.exec(lines[i]);
    if (!match || match.index > 3) continue;
    const rest = lines[i].slice(match.index + match[0].length).replace(/^[\s:#\-–—]+/, "").trim();
    if (rest) return { value: rest, line: i };
    if (i + 1 < lines.length) return { value: lines[i + 1], line: i + 1 };
  }
  return null;
}

/** Title case for a name printed in capitals: "LYDIA HARTLEY" becomes "Lydia Hartley". */
export function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
