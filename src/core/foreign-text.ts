/**
 * Bounding text this repo did not write — `spec/03 §5.1`, `ADR-0017`.
 *
 * Three fragments of an error message arrive from outside: the reason string a
 * contract chose, the raw data of a revert nothing in our ABIs names, and the
 * sentence viem or the endpoint produced for a failure. All three are
 * concatenated into a `message` an LLM agent reads and a human may see in a
 * terminal, and none of them has a length this repo controls — an 8 KiB revert
 * string measured at **8250 characters of `message`** through the built binary
 * (`.scratch/revert-message-bounds/spec.md`).
 *
 * **The limit is shared with `ADR-0013`'s cause summary on purpose.** That
 * decision bounded the first of these fragments and picked 160; a second number
 * for the second fragment would mean the rule is "whatever each call site
 * remembered". One helper and one constant is what makes the next foreign
 * fragment meet the rule by construction rather than by review.
 */

/** The longest fragment of foreign text that still keeps the payload small. */
export const FOREIGN_TEXT_LIMIT = 160;

/**
 * Flatten and cap a string that came off the wire.
 *
 * **Control characters go first, and the reason is the consumer.** The measured
 * payload carried newlines, a `"` and an ANSI `ESC [ 2 J`: rendered to a
 * terminal that clears the screen, and inside a `message` it forged a second
 * JSON envelope that reads as a successful result. `format: "json"` escapes
 * both on the way out, so the envelope stays parseable — but the agent reading
 * the parsed string receives them intact, and `formatHumanError` writes them
 * raw. A message is one line of prose; nothing in it needs to move a cursor.
 *
 * Each control character becomes a space rather than being deleted, so two
 * words separated only by a newline do not fuse into one; runs then collapse.
 *
 * Truncation is **visible**. A caller that cannot tell a bounded message from a
 * short one would read the cut as the whole of what the chain said.
 */
export function boundForeign(text: string): string {
  const flattened = Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    // C0 and DEL, then C1 — the ranges that steer a terminal rather than say anything.
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  })
    .join("")
    /**
     * The format characters, which steer a terminal without being controls:
     * U+202E RIGHT-TO-LEFT OVERRIDE reverses the rendered tail of the line —
     * including this repo's own `Nothing was sent.` — and U+200B ZERO WIDTH
     * SPACE is invisible. Same argument as the ANSI escape above, different
     * Unicode class.
     */
    .replace(/\p{Cf}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flattened.length <= FOREIGN_TEXT_LIMIT) return flattened;

  /**
   * The cap counts UTF-16 units, so a cut can land between the halves of a
   * surrogate pair and leave a lone high surrogate — which renders as U+FFFD
   * and makes the string not well-formed for anything re-encoding it. Dropping
   * the orphan costs one character of a string already being truncated.
   */
  const cut = flattened.slice(0, FOREIGN_TEXT_LIMIT - 1);
  const last = cut.charCodeAt(cut.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${whole}…`;
}
