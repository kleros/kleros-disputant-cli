import { describe, expect, it } from "vitest";
import type { ErrorCode } from "../../core/result.js";
import { err, ok } from "../../core/result.js";
import { ctaFor, exitCodeFor, finish, prepareLocal } from "../shared.js";

/**
 * The command layer's seam — `spec/03 §4`, `§5.4`, `§6`.
 *
 * Offline: nothing here reads the chain, a key file it did not write, or the
 * network.
 */

/**
 * Every member of the union, written out.
 *
 * The exhaustiveness `spec/03 §4` demands is enforced at **compile time** by
 * `Record<ErrorCode, number>` in `shared.ts` — this list is the other half of
 * the same guard, and the `satisfies` below is what fails to compile if the two
 * ever drift. A runtime `Object.keys` over the map could not do that: it would
 * agree with a map that had gained a key the union never had.
 */
const ALL_CODES = [
  "WRONG_CHAIN",
  "DEPLOYMENT_INCONSISTENT",
  "RPC_ERROR",
  "KEY_FILE_MISSING",
  "KEY_FILE_PERMISSIONS",
  "KEY_FILE_UNREADABLE",
  "KEY_FILE_INVALID",
  "COURT_OUT_OF_RANGE",
  "COURT_DISABLED",
  "JURORS_INVALID",
  "DISPUTE_KIT_OUT_OF_RANGE",
  "DISPUTE_KIT_NOT_SUPPORTED",
  "TEMPLATE_INVALID",
  "RULING_OPTIONS_INVALID",
  "POLICY_URI_INVALID",
  "EVIDENCE_INVALID",
  "COST_CEILING_EXCEEDED",
  "INSUFFICIENT_BALANCE",
  "DISPUTE_NOT_FOUND",
  "EFFECTIVE_MISMATCH",
  "SIMULATION_REVERTED",
  "TRANSACTION_REVERTED",
  "BROADCAST_FAILED",
  "NUMBER_INVALID",
] as const satisfies readonly ErrorCode[];

/** The other direction: every listed code is real, and none is missing. */
type Missing = Exclude<ErrorCode, (typeof ALL_CODES)[number]>;
const _exhaustive: Missing extends never ? true : Missing = true;

describe("exit codes", () => {
  it("gives every error code one of the five meanings in spec/03 §4", () => {
    for (const code of ALL_CODES) {
      expect(exitCodeFor(code), code).toBeGreaterThanOrEqual(1);
      expect(exitCodeFor(code), code).toBeLessThanOrEqual(4);
    }
    expect(_exhaustive).toBe(true);
  });

  it("puts every pre-flight refusal in bucket 1, so nothing-was-sent reads as one thing", () => {
    for (const code of [
      "COURT_OUT_OF_RANGE",
      "COURT_DISABLED",
      "JURORS_INVALID",
      "DISPUTE_KIT_OUT_OF_RANGE",
      "DISPUTE_KIT_NOT_SUPPORTED",
      "TEMPLATE_INVALID",
      "RULING_OPTIONS_INVALID",
      "POLICY_URI_INVALID",
      "EVIDENCE_INVALID",
      "COST_CEILING_EXCEEDED",
      "INSUFFICIENT_BALANCE",
      "DISPUTE_NOT_FOUND",
      "NUMBER_INVALID",
    ] as const) {
      expect(exitCodeFor(code), code).toBe(1);
    }
  });

  it("separates a key failure from a validation failure", () => {
    for (const code of [
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "KEY_FILE_UNREADABLE",
      "KEY_FILE_INVALID",
    ] as const) {
      expect(exitCodeFor(code), code).toBe(4);
    }
  });

  it("does not report a refused broadcast as a revert: nothing was submitted", () => {
    expect(exitCodeFor("BROADCAST_FAILED")).toBe(2);
    expect(exitCodeFor("SIMULATION_REVERTED")).toBe(3);
    expect(exitCodeFor("TRANSACTION_REVERTED")).toBe(3);
  });

  it("keeps EFFECTIVE_MISMATCH out of bucket 1, where the money would read as unspent", () => {
    expect(exitCodeFor("EFFECTIVE_MISMATCH")).toBe(3);
    expect(exitCodeFor("EFFECTIVE_MISMATCH")).not.toBe(exitCodeFor("COURT_OUT_OF_RANGE"));
  });
});

describe("CTA blocks", () => {
  /**
   * `spec/03 §5.4`: incur prefixes the binary name onto every CTA command, so a
   * CTA can only ever name a subcommand of this CLI. Citing a command a peer CLI
   * does not have is the juror repo's known defect; this is what stops it here.
   */
  const REGISTERED = ["arbitration-cost", "status", "create-dispute", "submit-evidence"];

  it("only ever names a command this CLI registers", () => {
    for (const code of ALL_CODES) {
      for (const entry of ctaFor(code, { court: "1", jurors: "3", dispute: "215" })?.commands ??
        []) {
        expect(REGISTERED, `${code} suggests ${entry.command}`).toContain(
          entry.command.split(" ")[0],
        );
      }
    }
  });

  it("never puts a shell remedy in a CTA, where incur would prefix the binary name", () => {
    for (const code of ALL_CODES) {
      const rendered = JSON.stringify(ctaFor(code, {}) ?? {});
      expect(rendered, code).not.toMatch(/chmod|kleros court|\bsudo\b/);
    }
  });

  it("keeps the words that were fine and blanks the one that was refused", () => {
    expect(
      ctaFor("COURT_OUT_OF_RANGE", { court: "99", jurors: "7", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --court <id> --jurors 7 --kit 1");
    expect(
      ctaFor("JURORS_INVALID", { court: "1", jurors: "0", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --court 1 --jurors <n> --kit 1");
    expect(
      ctaFor("DISPUTE_KIT_NOT_SUPPORTED", { court: "1", jurors: "3", kit: "2" })?.commands[0]
        ?.command,
    ).toBe("arbitration-cost --court 1 --jurors 3 --kit <id>");
  });

  /**
   * The consumer is an agent with no human above it. These five are the codes
   * `arbitration-cost` raises about itself, so a CTA that re-offered the same
   * three words would read as an instruction to run the failing command again,
   * would fail identically, and nothing in that loop would break it.
   *
   * The key and cost codes are deliberately not in this list: they are raised by
   * `create-dispute`, and the same three words under `arbitration-cost` succeed
   * — that is exactly why they are the suggestion.
   */
  it("never re-offers the words that were just refused about themselves", () => {
    const typed = { court: "99", jurors: "0", kit: "2" };
    const verbatim = `arbitration-cost --court ${typed.court} --jurors ${typed.jurors} --kit ${typed.kit}`;

    for (const code of [
      "COURT_OUT_OF_RANGE",
      "COURT_DISABLED",
      "JURORS_INVALID",
      "DISPUTE_KIT_OUT_OF_RANGE",
      "DISPUTE_KIT_NOT_SUPPORTED",
    ] as const) {
      for (const entry of ctaFor(code, typed)?.commands ?? []) {
        expect(entry.command, code).not.toBe(verbatim);
        expect(entry.command, code).toContain("<");
      }
    }
  });

  it("quotes what it can when the refusal was not about any of the three words", () => {
    expect(
      ctaFor("COST_CEILING_EXCEEDED", { court: "1", jurors: "3", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --court 1 --jurors 3 --kit 1");
  });

  it("offers a key-less command when the key is what failed", () => {
    for (const code of [
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "KEY_FILE_UNREADABLE",
      "KEY_FILE_INVALID",
    ] as const) {
      expect(ctaFor(code, { court: "1", jurors: "3" })?.commands[0]?.command, code).toContain(
        "arbitration-cost",
      );
    }
  });
});

describe("finish", () => {
  const context = () => {
    const seen: { ok?: unknown; error?: Record<string, unknown> } = {};
    return {
      seen,
      c: {
        ok: ((data: unknown) => {
          seen.ok = data;
          return undefined as never;
        }) as (data: never) => never,
        error: ((options: Record<string, unknown>) => {
          seen.error = options;
          return undefined as never;
        }) as never,
      },
    };
  };

  it("passes a success through untouched", () => {
    const { seen, c } = context();
    finish(c as never, ok({ command: "status" }));
    expect(seen.ok).toEqual({ command: "status" });
    expect(seen.error).toBeUndefined();
  });

  it("appends details.hint and nothing else from details", () => {
    const { seen, c } = context();
    finish(
      c as never,
      err("DISPUTE_NOT_FOUND", "No such dispute.", {
        hint: "Use the core dispute ID.",
        coreDisputeID: "999999",
      }),
    );
    expect(seen.error?.message).toBe("No such dispute. Use the core dispute ID.");
    expect(JSON.stringify(seen.error)).not.toContain("999999");
  });

  it("carries the exit code and the CTA for the code", () => {
    const { seen, c } = context();
    finish(c as never, err("COURT_OUT_OF_RANGE", "No such court."), { court: "99", jurors: "3" });
    expect(seen.error?.code).toBe("COURT_OUT_OF_RANGE");
    expect(seen.error?.exitCode).toBe(1);
    expect(seen.error?.cta).toBeDefined();
  });

  it("omits the CTA rather than inventing one for a code that has none", () => {
    const { seen, c } = context();
    finish(c as never, err("RPC_ERROR", "The endpoint did not answer."));
    expect(seen.error?.cta).toBeUndefined();
  });
});

describe("prepareLocal", () => {
  it("refuses a missing key on a write path and never names a key file it did not open", () => {
    const result = prepareLocal({ requireSigner: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_MISSING");
  });

  it("lets a read command run with no key at all", () => {
    const result = prepareLocal({ requireSigner: false });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.account).toBeNull();
  });

  it("defaults the endpoint rather than reading one from the environment", () => {
    const before = { ...process.env };
    process.env.ARBITRUM_RPC = "https://example.invalid";
    try {
      const result = prepareLocal({ requireSigner: false });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.rpcUrls).toEqual(["https://arb1.arbitrum.io/rpc"]);
    } finally {
      process.env = before;
    }
  });

  it("splits a comma-separated endpoint list for fallback", () => {
    const result = prepareLocal({ requireSigner: false, rpcUrl: "https://a.test, https://b.test" });
    expect(result.success && result.data.rpcUrls).toEqual(["https://a.test", "https://b.test"]);
  });
});
