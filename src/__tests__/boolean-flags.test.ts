/**
 * What incur's boolean flags do with a following word — `spec/03 §3.1`.
 *
 * Every irreversible action in this CLI is gated behind a boolean: `--broadcast`
 * spends the arbitration cost, `--publish` puts bytes on a public network under a
 * CID that cannot be withdrawn. The dangerous case is not the flag; it is the
 * *off* switch. `--broadcast false` sets it to **true**, because incur never reads
 * a following word as a boolean's value and no command here declares `args`, so
 * the word is parsed as a positional and discarded in silence.
 *
 * The trap is asserted here on purpose. If incur ever starts consuming the word,
 * this file fails — which is exactly when the warning in
 * `skills/kleros-disputant/SKILL.md` and the option descriptions should be
 * removed rather than left to mislead in the other direction.
 *
 * Offline: nothing here reads the chain, a key, or the network. It drives the
 * parser directly, because proving `--broadcast false` broadcasts by broadcasting
 * would cost real ETH.
 */
import { Parser, z } from "incur";
import { describe, expect, it } from "vitest";
import { writeOptions } from "../commands/shared.js";

/** Parses `argv` against `options` and returns the parsed option bag. */
function parse(argv: string[], options: z.ZodObject<Record<string, z.ZodType>>) {
  return Parser.parse(argv, { options }) as { options?: Record<string, unknown> };
}

describe("a boolean flag never reads the next word as its value", () => {
  // The real gate, imported rather than reconstructed: if `broadcast` stops being
  // a defaulted boolean, this suite is testing the wrong thing and should fail.
  const gate = z.object({ broadcast: writeOptions.broadcast });

  it.each([
    { argv: [], expected: false, why: "the default, and the only thing a dry run relies on" },
    { argv: ["--broadcast"], expected: true, why: "the confirmation" },
    { argv: ["--no-broadcast"], expected: false, why: "incur's negation prefix" },
    { argv: ["--broadcast=true"], expected: true, why: "the equals form" },
    { argv: ["--broadcast=false"], expected: false, why: "the equals form is the only value form" },
  ])("$argv -> $expected ($why)", ({ argv, expected }) => {
    expect(parse(argv, gate).options?.broadcast).toBe(expected);
  });

  it("treats `--broadcast false` as TRUE, which is the trap this repo documents", () => {
    // Not a typo, and not an assertion that this is desirable: it is what the
    // parser does, and a caller who writes it spends the arbitration cost.
    expect(parse(["--broadcast", "false"], gate).options?.broadcast).toBe(true);
  });

  it("discards the stray word silently rather than refusing the command", () => {
    // The word is not reported anywhere, which is why the CLI cannot warn about it
    // and the skill has to. If incur ever surfaces it, prefer refusing over warning.
    const parsed = parse(["--broadcast", "false"], gate) as Record<string, unknown>;
    expect(JSON.stringify(parsed)).not.toContain("false");
  });

  it("applies the same rule to a default-true boolean, as `--verify` is", () => {
    // `upload-file`'s `verify` is named for this reason: an option *named*
    // `no-verify` is unreachable, because `--no-` is the negation prefix.
    const verify = z.object({ verify: z.boolean().default(true) });
    expect(parse([], verify).options?.verify).toBe(true);
    expect(parse(["--no-verify"], verify).options?.verify).toBe(false);
    expect(parse(["--verify=false"], verify).options?.verify).toBe(false);
    expect(parse(["--verify", "false"], verify).options?.verify).toBe(true);
  });
});
