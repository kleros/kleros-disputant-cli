import { describe, expect, it } from "vitest";
import { contractsFor } from "../deployment.js";
import { DEFAULT_DEPLOYMENT } from "../deployments.js";
import type {
  ChainFacts,
  EvidenceChainFacts,
  PreflightFacts,
  RequestedDispute,
} from "../preflight.js";
import { checkEvidenceAddressable, checkEvidencePreflight, checkPreflight } from "../preflight.js";
import { EXTRA_DATA_VECTORS } from "./vectors.js";

/** The default deployment. The suite is not a matrix — `spec/05 §1.6b`. */
const contracts = contractsFor(DEFAULT_DEPLOYMENT);

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
  deployment: DEFAULT_DEPLOYMENT.slug,
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

/**
 * The evidence path — `spec/01 §9`, `spec/02 §4.2`, ADR-0011.
 *
 * The governing fact is that `submitEvidence` has **no access control, no
 * payment and no period gate**: it succeeds by `eth_call` against a dispute in
 * the `execution` period, and against a core dispute ID that does not exist at
 * all. So every check below is a warning, and the assertion that matters most is
 * that none of them is ever a refusal.
 */
/**
 * `spec/02 §4.2` — the check that decides which identifier is signed, kept apart
 * from the period policy so ADR-0011's "warn, never refuse" stays literally true
 * of `checkEvidencePreflight`.
 */
describe("addressability", () => {
  const facts = (over: Partial<EvidenceChainFacts> = {}): EvidenceChainFacts => ({
    coreDisputeID: 58n,
    courtID: 8n,
    arbitrable: contracts.disputeResolver.address,
    disputeResolver: contracts.disputeResolver.address,
    localDisputeID: 33n,
    periodIndex: 0,
    ruled: false,
    lastPeriodChange: 1_000n,
    timesPerPeriod: [280_800n, 100n, 100n, 100n],
    now: 1_000n,
    ...over,
  });

  it("returns the local dispute ID, not the core one", () => {
    const result = checkEvidenceAddressable(facts());
    expect(result).toEqual({ success: true, data: 33n });
  });

  /**
   * Local ID 0 is a real dispute **[live]** — on the v2 testnet core dispute 0 is
   * the resolver's local dispute 0 — so zero must pass. This is the assertion
   * that would fail if the check were ever written against the raw mapping value
   * instead of the `null` the read layer substitutes.
   */
  it("accepts local dispute ID zero, which is a real dispute", () => {
    const result = checkEvidenceAddressable(facts({ coreDisputeID: 0n, localDisputeID: 0n }));
    expect(result).toEqual({ success: true, data: 0n });
  });

  /**
   * Measured on the v2 testnet **[live]**: core dispute 98 belongs to a foreign
   * arbitrable, and the mapping answers 0 for it — the same 0 the case above
   * proves is a real dispute.
   */
  /**
   * The read layer substitutes `null` for a foreign dispute, so this state cannot
   * occur today — which is the point. It is what the check looks like after
   * someone removes that substitution as a redundant branch, and it must still
   * refuse (`spec/03 §8`: judgement belongs in the pure layer).
   */
  it("refuses a foreign arbitrable even when a local ID was resolved anyway", () => {
    const foreign = "0xDfa9E40FcBf4f37aa09996eAF39962742299B7Bc" as const;
    const result = checkEvidenceAddressable(facts({ arbitrable: foreign, localDisputeID: 33n }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_ADDRESSABLE");
  });

  it("refuses a dispute another arbitrable created, and names the owner", () => {
    const foreign = "0xDfa9E40FcBf4f37aa09996eAF39962742299B7Bc" as const;
    const result = checkEvidenceAddressable(
      facts({ coreDisputeID: 98n, arbitrable: foreign, localDisputeID: null }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_ADDRESSABLE");
    // The caller must be able to see the case is real and this tool is the limit.
    expect(result.message).toContain(foreign);
    expect(result.message).toContain("exists");
    // Distinct from DISPUTE_NOT_FOUND precisely so a caller does not retry.
    expect((result.details as { hint: string }).hint).toContain("Retrying will not help");
  });
});

describe("the evidence pre-flight", () => {
  /** Court 1's real evidence period **[live]**: 280 800 s, 3.25 days. */
  const GENERAL_COURT_EVIDENCE = 280_800n;
  const TIMES = [GENERAL_COURT_EVIDENCE, 100n, 100n, 100n] as const;

  const evidenceFacts = (over: Partial<EvidenceChainFacts> = {}): EvidenceChainFacts => ({
    coreDisputeID: 216n,
    courtID: 1n,
    arbitrable: contracts.disputeResolver.address,
    disputeResolver: contracts.disputeResolver.address,
    localDisputeID: 216n,
    periodIndex: 0,
    ruled: false,
    lastPeriodChange: 1_000_000n,
    timesPerPeriod: [...TIMES],
    now: 1_000_000n,
    ...over,
  });

  it("is quiet at the start of the evidence period", () => {
    const result = checkEvidencePreflight(evidenceFacts());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe("evidence");
    expect(result.data.secondsRemaining).toBe(GENERAL_COURT_EVIDENCE);
    expect(result.data.warnings).toEqual([]);
  });

  /**
   * The threshold is a quarter of the **court's own** period, because the
   * periods span 600 s to 540 000 s and a fixed second count is meaningless
   * across that range (`spec/01 §9`, closing `appendix-a §4.3`).
   */
  it("says nothing at just over a quarter remaining, and warns at exactly a quarter", () => {
    const quarter = GENERAL_COURT_EVIDENCE / 4n;

    const quiet = checkEvidencePreflight(
      evidenceFacts({ now: 1_000_000n + GENERAL_COURT_EVIDENCE - quarter - 1n }),
    );
    expect(quiet.success && quiet.data.warnings).toEqual([]);

    const tight = checkEvidencePreflight(
      evidenceFacts({ now: 1_000_000n + GENERAL_COURT_EVIDENCE - quarter }),
    );
    expect(tight.success).toBe(true);
    if (!tight.success) return;
    expect(tight.data.warnings).toHaveLength(1);
    expect(tight.data.warnings[0]).toContain(`${quarter}s`);
    expect(tight.data.warnings[0]).toContain(`${GENERAL_COURT_EVIDENCE}s`);
  });

  /**
   * A fraction is only a *trigger*. The warning quotes the actual seconds and the
   * period's own length, so a consumer that disagrees with a quarter can still
   * act on the numbers — which is what makes the threshold a cheap choice.
   */
  it("scales to a court whose whole evidence period is ten minutes", () => {
    // Court 34, Agentic Commerce: 600 s **[live]**. 150 s left is tight here and
    // would be nothing at all in the General Court.
    const result = checkEvidencePreflight(
      evidenceFacts({ courtID: 34n, timesPerPeriod: [600n, 100n, 100n, 100n], now: 1_000_450n }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.secondsRemaining).toBe(150n);
    expect(result.data.warnings[0]).toContain("150s of court 34's 600s evidence period");
  });

  /**
   * The deadline is an upper bound, never an entitlement: `passPeriod` is
   * permissionless, so the nominal end can pass without the period changing, and
   * the period can equally end early. Remaining time floors at zero rather than
   * going negative.
   */
  it("floors the remaining time at zero when the nominal deadline has passed", () => {
    const result = checkEvidencePreflight(evidenceFacts({ now: 9_000_000n }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe("evidence");
    expect(result.data.secondsRemaining).toBe(0n);
    expect(result.data.warnings[0]).toContain("passPeriod is permissionless");
  });

  it.each([
    [1, "commit"],
    [2, "vote"],
    [3, "appeal"],
    [4, "execution"],
  ])("warns and never refuses past the evidence period (period %i)", (periodIndex, name) => {
    const result = checkEvidencePreflight(evidenceFacts({ periodIndex }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe(name);
    expect(result.data.warnings[0]).toContain(`is in the ${name} period`);
    expect(result.data.warnings[0]).toContain("still recorded on chain");
  });

  /** `execution` has no duration: `timesPerPeriod` has four entries, not five. */
  it("reports no remaining time in the execution period", () => {
    const result = checkEvidencePreflight(evidenceFacts({ periodIndex: 4 }));
    expect(result.success && result.data.secondsRemaining).toBeNull();
  });

  it("adds a second warning once the dispute has been ruled", () => {
    const result = checkEvidencePreflight(evidenceFacts({ periodIndex: 4, ruled: true }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.warnings).toHaveLength(2);
    expect(result.data.warnings[1]).toContain("cannot affect the outcome");
  });

  /**
   * The only refusal on this path, and it is not about the operator's request: a
   * period index outside the documented enum means the deployed shape is not the
   * one this tool was built against.
   */
  it("refuses a period index the deployed enum was not documented to have", () => {
    const result = checkEvidencePreflight(evidenceFacts({ periodIndex: 5 }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DEPLOYMENT_INCONSISTENT");
  });

  it("never refuses on account of the period, at any period, ruled or not", () => {
    for (const periodIndex of [0, 1, 2, 3, 4]) {
      for (const ruled of [false, true]) {
        for (const now of [1_000_000n, 9_000_000n]) {
          expect(checkEvidencePreflight(evidenceFacts({ periodIndex, ruled, now })).success).toBe(
            true,
          );
        }
      }
    }
  });
});
