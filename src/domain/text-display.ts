/**
 * Display-text primitives.
 *
 * Measuring, wrapping, shortening, and de-fanging text are pure text problems
 * with no CLI opinion in them, so they live in the domain and the projections
 * compose them. The alternative — a renderer that also owns what a character is
 * worth — puts a second answer to "how wide is this" one copy away from the
 * first, and the two disagree the first time an emoji arrives.
 *
 * Two rules the functions enforce rather than document:
 *
 * - **Width is display width, never length.** A combining mark occupies no
 *   cell and a CJK ideograph occupies two, so `"日本".length` is 2 and its
 *   width is 4. Laying out by length draws a box that does not close.
 * - **Untrusted text is data.** {@link sanitizeTerminalText} is the one place a
 *   value from a file, an environment variable, or a provider stops being able
 *   to move the cursor, repaint the screen, or hide what follows it. Everything
 *   that renders a value someone else wrote passes it through here first.
 *
 * Nothing here knows about colour, renderer handles, or layout state. It takes
 * strings and numbers and returns strings and numbers. For joined emoji it uses
 * Bun's width primitive, the same one the pinned OpenTUI renderer selects on
 * Bun, so this arithmetic remains the answer the frame actually spends.
 */

/**
 * The widest layout this module will lay out to.
 *
 * A bound rather than a belief: a caller that hands over a width from a
 * terminal that reported something absurd gets a wrap, not an allocation the
 * size of the number it was given.
 */
export const MAX_DISPLAY_WIDTH = 10_000;

/** Characters that occupy no cell: combining marks and format controls. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Code-point ranges that occupy two cells.
 *
 * The East Asian Wide and Fullwidth ranges a terminal actually double, plus the
 * emoji blocks. Deliberately a documented subset rather than the full Unicode
 * table: the whole table is a generated artifact that would have to be
 * regenerated per Unicode release, and every character outside these ranges
 * that a terminal doubles is a character this build has no case for yet.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana through CJK compatibility
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi syllables and radicals
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Miscellaneous symbols, pictographs, emoticons
  [0x1f680, 0x1f6ff], // Transport and map symbols
  [0x1f900, 0x1f9ff], // Supplemental symbols and pictographs
  [0x20000, 0x3fffd], // CJK unified ideographs extensions B onward
];

function isWide(code: number): boolean {
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * The cells one character occupies.
 *
 * A control character is zero because it is not drawn — but a caller should
 * have sanitized it away before measuring anything, and this answer exists so
 * measurement of unsanitized text is merely wrong rather than unbounded.
 */
function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
    return 0;
  }
  if (ZERO_WIDTH.test(character)) {
    return 0;
  }
  return isWide(code) ? 2 : 1;
}

/**
 * The cells one grapheme cluster occupies.
 *
 * Most clusters retain the explicit Falryn policy above, including its
 * treatment of control text before sanitization. A zero-width-joiner cluster
 * is different: its constituent emoji are one rendered glyph, so summing
 * their code-point widths overestimates the cells the renderer consumes.
 * OpenTUI 0.4.5 delegates that measurement to `Bun.stringWidth` on Bun; using
 * the same primitive at this narrow seam keeps width, truncation, and wrapping
 * aligned with the pinned renderer without importing presentation code into the
 * domain or changing the policy for other text.
 */
function graphemeWidth(grapheme: string): number {
  if (grapheme.includes("\u200d")) {
    return Bun.stringWidth(grapheme);
  }

  let width = 0;
  for (const character of grapheme) {
    width += characterWidth(character);
  }
  return width;
}

/**
 * The user-perceived characters in this text.
 *
 * A grapheme cluster is what a person means by "a character" and what a cursor
 * has to move over: `é` written as `e` plus a combining accent is one of them
 * over two code points, a flag is one over two, and a family emoji is one over
 * seven joined by zero-width joiners. Moving by code point through any of those
 * puts the cursor inside a character, and deleting one leaves a fragment that
 * renders as something the user never typed.
 *
 * `Intl.Segmenter` is the platform's own answer and is the reason this is four
 * lines rather than a table nobody can maintain across Unicode releases — the
 * same argument the width ranges above make in the opposite direction, where a
 * generated table would have to be regenerated per release for characters this
 * build has no case for.
 *
 * Lives here rather than in the composer because it is a pure text fact with no
 * interface opinion in it, beside the width rule it is the counterpart to. A
 * second segmenter in a view would be a second answer to what a character is.
 */
export function graphemes(text: string): readonly string[] {
  if (text === "") {
    return [];
  }
  return [...SEGMENTER.segment(text)].map((entry) => entry.segment);
}

/** Locale-independent on purpose: a cursor does not move differently in French. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Where each word starts, as grapheme offsets.
 *
 * The counterpart to {@link graphemes} for a cursor that moves by word, and it
 * is the platform's answer for the same reason: what separates a word from the
 * punctuation and spaces around it is a Unicode question that changes between
 * releases, and `Intl.Segmenter` already tracks it. A `split(" ")` here would
 * disagree with the rest of this module the first time it met `don't`, a CJK
 * run with no spaces in it, or an emoji.
 *
 * Only word-like segments count. `isWordLike` is what the segmenter uses to
 * separate a word from the run of punctuation or whitespace beside it, so a
 * cursor moving by word steps between words rather than pausing on every comma.
 *
 * Offsets are counted in *graphemes* rather than code units, because that is
 * what a cursor position is everywhere else in this codebase. A boundary
 * reported in code units would be a second coordinate system, and the first
 * character outside the basic plane would put a word motion inside a character.
 */
export function wordStarts(text: string): readonly number[] {
  if (text === "") {
    return [];
  }
  // One pass over graphemes, mapping each code-unit index to its grapheme
  // index. The segmenter reports both kinds of boundary against the same
  // string, so the two are aligned by construction rather than by arithmetic.
  const byCodeUnit = new Map<number, number>();
  let grapheme = 0;
  for (const entry of SEGMENTER.segment(text)) {
    byCodeUnit.set(entry.index, grapheme);
    grapheme += 1;
  }

  const starts: number[] = [];
  for (const entry of WORD_SEGMENTER.segment(text)) {
    if (!entry.isWordLike) {
      continue;
    }
    const at = byCodeUnit.get(entry.index);
    // A word starting inside a grapheme cluster is not a position a cursor can
    // hold, so it is skipped rather than rounded to a neighbour.
    if (at !== undefined) {
      starts.push(at);
    }
  }
  return starts;
}

/** The same platform answer, at word granularity. */
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

/** How many terminal cells this text occupies. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(text)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

/**
 * Untrusted text with every way it could control a terminal removed.
 *
 * C0 controls, DEL, C1 controls, and lone surrogates are replaced by a visible
 * ASCII escape of the code point they were. That covers the escape character
 * itself, which is the first byte of every ANSI sequence — a value carrying
 * `\x1b[2J` renders as those eight characters instead of clearing the screen.
 *
 * Newlines and tabs are escaped too, because everything this repository renders
 * puts a value on a line beside a label, and a value that can insert a line
 * break can forge a line the renderer never wrote.
 *
 * The escape is a lossy, one-way rendering, not an encoding: text containing a
 * literal backslash-x-one-b is indistinguishable from an escape afterwards.
 * That is acceptable and the injection property is not, so ambiguity is the
 * side that gives.
 */
export function sanitizeTerminalText(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    // A surrogate reached one at a time is unpaired: the iterator yields a
    // valid pair as one character, so anything left here cannot form one.
    if (code >= 0xd800 && code <= 0xdfff) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += character;
  }
  return out;
}

/**
 * Text shortened to a width, with a marker saying that it was.
 *
 * The marker is the caller's, because whether `…` or `...` is legible is a
 * capability fact this module does not hold. A marker that does not itself fit
 * is dropped rather than overflowing the width it was meant to respect.
 */
export function truncateToWidth(text: string, width: number, ellipsis = ""): string {
  const limit = boundedWidth(width);
  if (limit <= 0) {
    return "";
  }
  if (displayWidth(text) <= limit) {
    return text;
  }

  const marker = displayWidth(ellipsis) <= limit ? ellipsis : "";
  const budget = limit - displayWidth(marker);
  let kept = "";
  let used = 0;
  for (const grapheme of graphemes(text)) {
    const next = graphemeWidth(grapheme);
    if (used + next > budget) {
      break;
    }
    kept += grapheme;
    used += next;
  }
  return kept + marker;
}

/**
 * Text laid out as lines no wider than a width.
 *
 * Breaks at spaces where it can and inside a word where it must, so a URL wider
 * than the terminal wraps rather than deciding the layout. Existing newlines
 * are kept as paragraph breaks; an empty paragraph stays an empty line, so
 * deliberate spacing survives.
 *
 * The width is clamped rather than trusted: a zero, a negative, a fraction, and
 * a `NaN` all resolve to a usable number, because this is a pure function and
 * the alternative is a loop that never ends over a value nobody validated.
 */
export function wrapToWidth(text: string, width: number): readonly string[] {
  const limit = Math.max(1, boundedWidth(width));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    lines.push(...wrapParagraph(paragraph, limit));
  }
  return lines;
}

function wrapParagraph(paragraph: string, limit: number): readonly string[] {
  const words = paragraph.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= limit) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
    }
    // The word did not fit beside anything. If it does not fit alone either it
    // is split by width, which is the only break available.
    const pieces = splitToWidth(word, limit);
    for (const piece of pieces.slice(0, -1)) {
      lines.push(piece);
    }
    current = pieces[pieces.length - 1] ?? "";
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines;
}

/** One word cut into pieces no wider than a limit. Always returns at least one. */
function splitToWidth(word: string, limit: number): readonly string[] {
  const pieces: string[] = [];
  let current = "";
  let used = 0;
  for (const grapheme of graphemes(word)) {
    const next = graphemeWidth(grapheme);
    // A character wider than the whole line still gets its own piece rather
    // than being dropped or looped on.
    if (used > 0 && used + next > limit) {
      pieces.push(current);
      current = "";
      used = 0;
    }
    current += grapheme;
    used += next;
  }
  pieces.push(current);
  return pieces;
}

/** A width this module is willing to lay out to. */
function boundedWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return MAX_DISPLAY_WIDTH;
  }
  return Math.min(MAX_DISPLAY_WIDTH, Math.floor(width));
}
