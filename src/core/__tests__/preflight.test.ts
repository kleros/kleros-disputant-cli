import { describe, expect, it } from "vitest";
import type { ChainFacts, PreflightFacts, RequestedDispute } from "../preflight.js";
import { checkPreflight } from "../preflight.js";
import { EXTRA_DATA_VECTORS } from "./vectors.js";

/**
 * `spec/05 §1.2` — the safety core. **The single most important test file in the
 * repository**: it is the only thing standing between a typo and a paid mistake,
 * and on this write surface it has no on-chain backstop. Every row of X5 quotes
 * 0.015 ETH and simulates cleanly **[live]**, so nothing downstream catches any
 * of them.
 *
 * Nothing here touches the network. `checkPreflight` takes a facts struct and
 * returns a decision; there is no client to pass it.
 */

/**
 * `spec/01 §4.1`, live: `disputeKits(5)` reverts. Courts have no length to compare
 * against — existence comes from `getTimesPerPeriod(courtID)` reverting, so it
 * arrives as a boolean rather than a bound (`spec/01 §8`).
 */
const DISPUTE_KITS_LENGTH = 5n;

/** X1's request: General Court, three jurors, Classic, two ruling options. */
const requested = (over: Partial<RequestedDispute> = {}): RequestedDispute => ({
  courtID: 1n,
  jurors: 3n,
  disputeKitID: 1n,
  numberOfRulingOptions: 2n,
  ...over,
});

/** Everything the reads found, with nothing wrong. */
const chain = (over: Partial<ChainFacts> = {}): ChainFacts => ({
  courtExists: true,
  disputeKitsLength: DISPUTE_KITS_LENGTH,
  courtDisabled: false,
  kitSupported: true,
  ...over,
});

const facts = (
  over: { requested?: Partial<RequestedDispute>; chain?: Partial<ChainFacts> } = {},
): PreflightFacts => ({
  requested: requested(over.requested),
  chain: chain(over.chain),
});

const refusalOf = (input: PreflightFacts) => {
  const result = checkPreflight(input);
  if (result.success) throw new Error("expected a refusal, got a pass");
  return result;
};

describe("checkPreflight", () => {
  it("passes X1 and builds the vector's own extraData", () => {
    const x1 = EXTRA_DATA_VECTORS[0];
    const result = checkPreflight(facts());
    if (!result.success) throw new Error(`unexpected refusal: ${result.code}`);
    expect(result.data.extraData).toBe(x1.blob);
    expect((result.data.extraData.length - 2) / 2).toBe(96);
    expect(result.data).toMatchObject({
      courtID: 1n,
      jurors: 3n,
      disputeKitID: 1n,
      numberOfRulingOptions: 2n,
    });
  });

  describe("X5 — the refusal vectors", () => {
    it("refuses --court 0, the Forking Court", () => {
      expect(refusalOf(facts({ requested: { courtID: 0n } })).code).toBe("COURT_OUT_OF_RANGE");
    });

    it("refuses --court 99, which the existence probe did not resolve", () => {
      expect(
        refusalOf(facts({ requested: { courtID: 99n }, chain: { courtExists: false } })).code,
      ).toBe("COURT_OUT_OF_RANGE");
    });

    it("refuses --jurors 0", () => {
      expect(refusalOf(facts({ requested: { jurors: 0n } })).code).toBe("JURORS_INVALID");
    });

    it("refuses --kit 0", () => {
      expect(refusalOf(facts({ requested: { disputeKitID: 0n } })).code).toBe(
        "DISPUTE_KIT_OUT_OF_RANGE",
      );
    });

    it("refuses --kit 99, out of range", () => {
      expect(refusalOf(facts({ requested: { disputeKitID: 99n } })).code).toBe(
        "DISPUTE_KIT_OUT_OF_RANGE",
      );
    });

    it("refuses --kit 2 with --court 1, which the General Court does not support", () => {
      // This one does revert on chain, with `DisputeKitNotSupportedByCourt()`.
      // Refusing it here first is what gives it a name instead of a selector.
      const refusal = refusalOf(
        facts({ requested: { disputeKitID: 2n }, chain: { kitSupported: false } }),
      );
      expect(refusal.code).toBe("DISPUTE_KIT_NOT_SUPPORTED");
    });

    it("cannot emit a blob shorter than 96 bytes", () => {
      // The seventh X5 row is unreachable by construction rather than refused:
      // the only blob this tool can emit comes from a passing `checkPreflight`,
      // and three fixed-width words cannot encode to any other length.
      const result = checkPreflight(facts());
      if (!result.success) throw new Error("unexpected refusal");
      expect((result.data.extraData.length - 2) / 2).toBe(96);
    });
  });

  describe("bounds", () => {
    it("accepts the last kit", () => {
      const result = checkPreflight(
        facts({ requested: { disputeKitID: DISPUTE_KITS_LENGTH - 1n } }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts any court the probe resolved, however high the ID", () => {
      // There is no bound to be at the end of: `getTimesPerPeriod` answers for the
      // court asked about and nothing else.
      expect(checkPreflight(facts({ requested: { courtID: 34n } })).success).toBe(true);
    });

    it("refuses one past the last kit", () => {
      expect(refusalOf(facts({ requested: { disputeKitID: DISPUTE_KITS_LENGTH } })).code).toBe(
        "DISPUTE_KIT_OUT_OF_RANGE",
      );
    });

    it("accepts a single juror", () => {
      expect(checkPreflight(facts({ requested: { jurors: 1n } })).success).toBe(true);
    });
  });

  describe("refusal ordering", () => {
    // Ordering is a diagnosis quality: an out-of-range court is reported as an
    // out-of-range court, never as an unsupported kit.
    it("reports the court before anything else", () => {
      const refusal = refusalOf(
        facts({
          requested: { courtID: 99n, jurors: 0n, disputeKitID: 99n, numberOfRulingOptions: 1n },
          chain: { courtExists: false, kitSupported: false },
        }),
      );
      expect(refusal.code).toBe("COURT_OUT_OF_RANGE");
    });

    it("reports a disabled court before the juror count", () => {
      const refusal = refusalOf(
        facts({ requested: { jurors: 0n }, chain: { courtDisabled: true } }),
      );
      expect(refusal.code).toBe("COURT_DISABLED");
    });

    it("reports the juror count before the kit", () => {
      const refusal = refusalOf(facts({ requested: { jurors: 0n, disputeKitID: 99n } }));
      expect(refusal.code).toBe("JURORS_INVALID");
    });

    it("reports an out-of-range kit before an unsupported one", () => {
      const refusal = refusalOf(
        facts({ requested: { disputeKitID: 99n }, chain: { kitSupported: false } }),
      );
      expect(refusal.code).toBe("DISPUTE_KIT_OUT_OF_RANGE");
    });

    it("reports the kit before the ruling options", () => {
      const refusal = refusalOf(
        facts({ requested: { disputeKitID: 0n, numberOfRulingOptions: 1n } }),
      );
      expect(refusal.code).toBe("DISPUTE_KIT_OUT_OF_RANGE");
    });
  });

  describe("fails closed on a fact that was not read", () => {
    // A fact the read layer could not supply is a refusal, never a pass. This is
    // the difference between a safety function and a formality.
    it("refuses when the court's disabled flag is missing", () => {
      const refusal = refusalOf(facts({ chain: { courtDisabled: undefined } }));
      expect(refusal.code).toBe("COURT_DISABLED");
      expect(refusal.message).toContain("not");
    });

    it("refuses when isSupported was not read", () => {
      // Never cached, so "not read" is a real state on every invocation.
      const refusal = refusalOf(facts({ chain: { kitSupported: undefined } }));
      expect(refusal.code).toBe("DISPUTE_KIT_NOT_SUPPORTED");
    });

    it("refuses when court existence was not established", () => {
      const refusal = refusalOf(facts({ chain: { courtExists: undefined } }));
      expect(refusal.code).toBe("COURT_OUT_OF_RANGE");
      expect(refusal.message).toContain("getTimesPerPeriod");
    });
  });

  describe("ruling options", () => {
    it("refuses fewer than two", () => {
      expect(refusalOf(facts({ requested: { numberOfRulingOptions: 1n } })).code).toBe(
        "RULING_OPTIONS_INVALID",
      );
      expect(refusalOf(facts({ requested: { numberOfRulingOptions: 0n } })).code).toBe(
        "RULING_OPTIONS_INVALID",
      );
    });
  });

  it("never mentions a court it was not asked about", () => {
    // The message is what an agent acts on. A refusal naming the General Court
    // when the operator asked for court 99 is worse than no message at all.
    const refusal = refusalOf(
      facts({ requested: { courtID: 99n }, chain: { courtExists: false } }),
    );
    expect(refusal.message).toContain("99");
  });
});
