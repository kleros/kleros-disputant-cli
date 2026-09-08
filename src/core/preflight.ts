import type { Hex } from "viem";
import { encodeExtraData } from "./extra-data.js";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The safety core — `spec/02 §1.1`, verified by `spec/05 §1.2`.
 *
 * A **pure function over a facts struct**, with zero network calls. Reading is
 * split from judging (`spec/03 §8`): `read-preflight.ts` performs the I/O and
 * produces `ChainFacts` with no judgement applied; everything that decides
 * whether to spend money is here, and is therefore testable without an RPC.
 *
 * This is the only thing standing between a typo and a paid mistake. A wrong
 * court ID, a zero juror count or an out-of-range kit **does not revert**: the
 * deployed decoder substitutes General Court / the default juror count / Classic
 * and creates a paid dispute in the wrong court (`spec/01 §4.4`). Every refusal
 * vector in `spec/02 §1.3` X5 quotes 0.015 ETH and simulates cleanly, so
 * `simulateContract` is not a backstop for any of them.
 *
 * Fail closed. A fact that was not read is a refusal, never a pass.
 */

/**
 * The three `extraData` words the operator asked for, already parsed.
 * `spec/03 §3.2`.
 *
 * Split out from `RequestedDispute` because `arbitration-cost` quotes without a
 * template and so has no ruling-option count to check — and quoting is not
 * exempt from any of the other five checks. A quote for court 99 comes back as
 * the General Court's price, silently (`spec/01 §4.4`), so a command that
 * skipped them would report a number for a court the operator did not name.
 */
export type RequestedExtraData = {
  courtID: bigint;
  jurors: bigint;
  disputeKitID: bigint;
};

/** What the operator asked for, already parsed. `spec/03 §3.2`. */
export type RequestedDispute = RequestedExtraData & {
  /**
   * Derived from the template's own `answers` array, never accepted as an
   * option — the two cannot disagree (`spec/02 §1.1`). Re-checked here because
   * it arrives from another module.
   */
  numberOfRulingOptions: bigint;
};

/**
 * What the chain said, with no judgement applied.
 *
 * The three facts a read can fail to produce are **required and nullable**
 * rather than optional: `undefined` means "not read" and is refused, and making
 * the key mandatory means a read layer has to say so deliberately instead of
 * omitting it and being waved through. A safety check the caller can forget to
 * supply is not a safety check.
 */
export type ChainFacts = {
  /**
   * Whether `courtID` resolves at all, from `getTimesPerPeriod(courtID)` — which
   * reverts with a decodable `Array index is out of bounds.` panic past the end of
   * the array. **[live]**
   *
   * KlerosCore exposes no courts-length call, so there is no bound to compare
   * against and none to quote back in a refusal; `getTimesPerPeriod` is already
   * read for the evidence-period warning, so this costs nothing extra.
   * `spec/01 §8`.
   */
  courtExists: boolean | undefined;
  /** `disputeKits.length`. */
  disputeKitsLength: bigint;
  /** `courts(courtID).disabled`. `undefined` when the court is out of range and the read reverted. */
  courtDisabled: boolean | undefined;
  /** `isSupported(courtID, kitID)`. Read on **every** invocation — court configuration is
   * governance-mutable, so a cached support table is a stale table (`spec/01 §4.2`). */
  kitSupported: boolean | undefined;
};

export type ExtraDataFacts = {
  requested: RequestedExtraData;
  chain: ChainFacts;
};

export type PreflightFacts = {
  requested: RequestedDispute;
  chain: ChainFacts;
};

export type ExtraDataResult = RequestedExtraData & {
  /**
   * Built here and nowhere else. The blob only exists once its three words have
   * been validated, so there is no unvalidated blob for a later step to pick up
   * by mistake, and one invocation quotes and sends the same bytes
   * (`spec/02 §1`).
   */
  extraData: Hex;
};

export type PreflightResult = ExtraDataResult & { numberOfRulingOptions: bigint };

/** `kleros`, the peer read-plane CLI — verified against agentkit's own command tree. */
const COURT_LIST_HINT = "kleros court list --chain arbitrum-one";

/**
 * Refusal ordering is a diagnosis quality, not style: an out-of-range court is
 * reported as an out-of-range court, never as an unsupported kit. The order
 * follows `spec/02 §1.1`'s table top to bottom, and `spec/05 §1.2` asserts it.
 */
export function checkExtraData({
  requested,
  chain,
}: ExtraDataFacts): KlerosResult<ExtraDataResult> {
  const { courtID, jurors, disputeKitID } = requested;

  // 1. Court in range. Court 0 is the Forking Court: it does not revert and
  //    reads all-zero, and the decoder maps it to General alongside any
  //    out-of-range ID (`spec/01 §4.1`). It is refused before the existence
  //    probe because the probe would pass on it.
  if (courtID === 0n) {
    return err(
      "COURT_OUT_OF_RANGE",
      "Court 0 is the Forking Court and is never a valid target: KlerosCore would create the " +
        "dispute in the General Court instead. Court IDs start at 1. Nothing was sent.",
      { courtID: courtID.toString(), hint: COURT_LIST_HINT },
    );
  }
  if (chain.courtExists === undefined) {
    return err(
      "COURT_OUT_OF_RANGE",
      `Court ${courtID} could not be confirmed to exist: KlerosCore.getTimesPerPeriod(${courtID}) ` +
        "was not read. Nothing was sent.",
      { courtID: courtID.toString(), hint: COURT_LIST_HINT },
    );
  }
  if (!chain.courtExists) {
    return err(
      "COURT_OUT_OF_RANGE",
      `Court ${courtID} does not exist on KlerosCore. A dispute asking for it would be created ` +
        "in the General Court and paid for. Nothing was sent.",
      { courtID: courtID.toString(), hint: COURT_LIST_HINT },
    );
  }

  // 2. Court enabled.
  if (chain.courtDisabled === undefined) {
    return err(
      "COURT_DISABLED",
      `Court ${courtID} could not be confirmed enabled: KlerosCore.courts(${courtID}) was not ` +
        "read. Nothing was sent.",
      { courtID: courtID.toString() },
    );
  }
  if (chain.courtDisabled) {
    return err(
      "COURT_DISABLED",
      `Court ${courtID} is disabled and cannot take new disputes. Nothing was sent.`,
      { courtID: courtID.toString(), hint: COURT_LIST_HINT },
    );
  }

  // 3. Juror count. Zero is silently replaced by the deployment's default.
  if (jurors < 1n) {
    return err(
      "JURORS_INVALID",
      "At least one juror is required: KlerosCore replaces a zero juror count with its own " +
        "default and charges for it. Nothing was sent.",
      { jurors: jurors.toString() },
    );
  }

  // 4. Kit in range. `disputeKits(0)` is the zero address (`spec/01 §4.1`).
  if (disputeKitID === 0n || disputeKitID >= chain.disputeKitsLength) {
    return err(
      "DISPUTE_KIT_OUT_OF_RANGE",
      `Dispute kit ${disputeKitID} does not exist: KlerosCore has kits 1 through ` +
        `${chain.disputeKitsLength - 1n}. A dispute asking for it would be created with the ` +
        "Classic kit and paid for. Nothing was sent.",
      {
        disputeKitID: disputeKitID.toString(),
        disputeKitsLength: chain.disputeKitsLength.toString(),
      },
    );
  }

  // 5. Kit supported by that court. This one does revert on chain
  //    (`DisputeKitNotSupportedByCourt()`); refusing it here first is what gives
  //    the failure a name instead of a 4-byte selector (`spec/01 §4.2`).
  if (chain.kitSupported === undefined) {
    return err(
      "DISPUTE_KIT_NOT_SUPPORTED",
      `Dispute kit ${disputeKitID} could not be confirmed supported by court ${courtID}: ` +
        "KlerosCore.isSupported was not read. Nothing was sent.",
      { courtID: courtID.toString(), disputeKitID: disputeKitID.toString() },
    );
  }
  if (!chain.kitSupported) {
    return err(
      "DISPUTE_KIT_NOT_SUPPORTED",
      `Court ${courtID} does not support dispute kit ${disputeKitID}. On Arbitrum One the ` +
        "General Court supports Classic (kit 1) only. Nothing was sent.",
      { courtID: courtID.toString(), disputeKitID: disputeKitID.toString() },
    );
  }

  return ok({
    courtID,
    jurors,
    disputeKitID,
    extraData: encodeExtraData({ courtID, jurors, disputeKitID }),
  });
}

/**
 * `checkExtraData`, then the one check that belongs to dispute creation alone.
 *
 * The refusal order is unchanged by the split: the ruling-option check was
 * always last, because it is an assertion over a value this tool derived rather
 * than a check on something the operator typed.
 */
export function checkPreflight({
  requested,
  chain,
}: PreflightFacts): KlerosResult<PreflightResult> {
  const words = checkExtraData({ requested, chain });
  if (!words.success) return words;

  // 6. Ruling options. Derived from the template, so this is an assertion over a
  //    value built elsewhere rather than a check on operator input. The contract
  //    refuses fewer than two with a reason string; it does **not** check that
  //    the count matches the template (`spec/02 §1.1`).
  const { numberOfRulingOptions } = requested;
  if (numberOfRulingOptions < 2n) {
    return err(
      "RULING_OPTIONS_INVALID",
      `A dispute needs at least two ruling options; the template offers ${numberOfRulingOptions}. ` +
        "Nothing was sent.",
      { numberOfRulingOptions: numberOfRulingOptions.toString() },
    );
  }

  return ok({ ...words.data, numberOfRulingOptions });
}

/* ------------------------------------------------------------------------- *
 * After the send — `spec/02 §1.2`.
 * ------------------------------------------------------------------------- */

/**
 * What the dispute that now exists actually says about itself, with no
 * judgement applied. Read back from chain state, never echoed from the inputs
 * (`spec/05 §5` criterion 8).
 */
export type EffectiveDispute = {
  coreDisputeID: bigint;
  /** `disputes(coreDisputeID).courtID`. */
  courtID: bigint;
  /** `getRoundInfo(coreDisputeID, 0).nbVotes` — the juror count the core recorded. */
  jurors: bigint;
  /** `getRoundInfo(coreDisputeID, 0).disputeKitID`. */
  disputeKitID: bigint;
};

/**
 * The only check on the one failure pre-flight cannot prevent.
 *
 * `KlerosCore` decodes `_arbitratorExtraData` with bounds checks that substitute
 * defaults rather than revert (`spec/01 §4.4`), so a dispute can be created,
 * paid for and mined in a court nobody asked for. `checkExtraData` is what stops
 * that happening; this is what notices if it did anyway — a governance change to
 * the court set between the read and the send, or a decoder that no longer
 * behaves as `spec/01` describes.
 *
 * A difference is an **error, not a warning** (`spec/02 §1.2`): the money is
 * already spent, and a warning invites a consumer to treat the dispute as the
 * one it asked for.
 */
export function checkEffective({
  requested,
  effective,
}: {
  requested: RequestedExtraData;
  effective: EffectiveDispute;
}): KlerosResult<EffectiveDispute> {
  const differences = (
    [
      ["court", requested.courtID, effective.courtID],
      ["juror count", requested.jurors, effective.jurors],
      ["dispute kit", requested.disputeKitID, effective.disputeKitID],
    ] as const
  ).filter(([, asked, got]) => asked !== got);

  if (differences.length > 0) {
    return err(
      "EFFECTIVE_MISMATCH",
      `Dispute ${effective.coreDisputeID} was created, paid for and mined, but it is not the ` +
        `dispute that was requested: ${differences
          .map(([label, asked, got]) => `${label} ${got} was recorded, ${asked} was requested`)
          .join("; ")}. The arbitration fee is spent and this cannot be undone. Do not create a ` +
        "replacement without deciding what to do with this one.",
      {
        coreDisputeID: effective.coreDisputeID.toString(),
        requested: {
          court: requested.courtID.toString(),
          jurors: requested.jurors.toString(),
          disputeKit: requested.disputeKitID.toString(),
        },
        effective: {
          court: effective.courtID.toString(),
          jurors: effective.jurors.toString(),
          disputeKit: effective.disputeKitID.toString(),
        },
      },
    );
  }

  return ok(effective);
}

/* ------------------------------------------------------------------------- *
 * The evidence path — `spec/02 §4.2`, `spec/01 §9`, ADR-0011.
 * ------------------------------------------------------------------------- */

/**
 * `disputes().period`, a `uint8` over these five in this order (`spec/01 §9`).
 * Named rather than numbered because the index reaches an LLM consumer.
 */
export const PERIODS = ["evidence", "commit", "vote", "appeal", "execution"] as const;

export type Period = (typeof PERIODS)[number];

/**
 * What the chain said about a dispute, with no judgement applied.
 *
 * `now` is **chain time**, from `getBlock().timestamp`. `Date.now()` MUST NOT be
 * used for any of the arithmetic below (`spec/01 §8`): the two disagree by
 * whatever the node is lagging by, and the answer here is reported to an agent
 * that will act on it.
 */
export type EvidenceChainFacts = {
  coreDisputeID: bigint;
  courtID: bigint;
  /** Raw `disputes().period`. Out of range means the deployed enum grew. */
  periodIndex: number;
  ruled: boolean;
  lastPeriodChange: bigint;
  /** `getTimesPerPeriod(courtID)` — four durations, one per non-terminal period. */
  timesPerPeriod: readonly bigint[];
  now: bigint;
};

export type EvidenceAssessment = {
  coreDisputeID: bigint;
  courtID: bigint;
  period: Period;
  /**
   * Seconds to the nominal end of the current period, floored at zero. `null` in
   * `execution`, which has no duration — `timesPerPeriod` has four entries, not
   * five.
   *
   * **An upper bound, never an entitlement.** `passPeriod` is permissionless and
   * a period can end early, so this is the most time there could be, not the
   * time there is.
   */
  secondsRemaining: bigint | null;
  warnings: string[];
};

/**
 * The fraction of the court's own evidence period below which submitting is
 * called out as tight.
 *
 * A fixed number of seconds is meaningless here: evidence periods on Arbitrum
 * One span 600 s (court 34) to 540 000 s (court 24), three orders of magnitude,
 * so `spec/01 §9` rules one out and asks for a fraction instead. A quarter is
 * the choice, and it is only a *trigger* — the warning always states the actual
 * seconds remaining and the period's full length, so a consumer that disagrees
 * with the threshold can still act on the numbers. Closes `appendix-a §4.3`.
 */
export const EVIDENCE_PRESSURE_NUMERATOR = 1n;
export const EVIDENCE_PRESSURE_DENOMINATOR = 4n;

/**
 * Pure, and it **never refuses**. `submitEvidence` has no access control, no
 * payment and no period gate — it succeeds by `eth_call` against a dispute in
 * the `execution` period — so any period discipline is this CLI's own policy and
 * ADR-0011 fixes that policy at "warn". The one hard refusal on this path lives
 * in the read layer, where a dispute ID that `disputes()` cannot resolve is
 * named `DISPUTE_NOT_FOUND`.
 */
export function checkEvidencePreflight(
  facts: EvidenceChainFacts,
): KlerosResult<EvidenceAssessment> {
  const period = PERIODS[facts.periodIndex];
  if (period === undefined) {
    return err(
      "DEPLOYMENT_INCONSISTENT",
      `Dispute ${facts.coreDisputeID} reports period ${facts.periodIndex}, and KlerosCore is ` +
        `documented to have ${PERIODS.length}. The deployed period enum is not the one this ` +
        "tool was built against. Nothing was sent.",
      { periodIndex: facts.periodIndex, known: [...PERIODS] },
    );
  }

  const duration = facts.timesPerPeriod[facts.periodIndex];
  const secondsRemaining =
    duration === undefined ? null : max(facts.lastPeriodChange + duration - facts.now, 0n);

  const warnings: string[] = [];

  if (period !== "evidence") {
    warnings.push(
      `Dispute ${facts.coreDisputeID} is in the ${period} period; the evidence period is over. ` +
        "The submission is still recorded on chain and indexed against the dispute, but jurors " +
        "may already have voted and are under no obligation to revisit it.",
    );
  } else if (
    duration !== undefined &&
    secondsRemaining !== null &&
    secondsRemaining * EVIDENCE_PRESSURE_DENOMINATOR <= duration * EVIDENCE_PRESSURE_NUMERATOR
  ) {
    warnings.push(
      `At most ${secondsRemaining}s of court ${facts.courtID}'s ${duration}s evidence period ` +
        "remain. The period can also end early — passPeriod is permissionless — so this is an " +
        "upper bound, not time in hand.",
    );
  }

  if (facts.ruled) {
    warnings.push(
      `Dispute ${facts.coreDisputeID} has already reached its ruling. Evidence submitted now ` +
        "cannot affect the outcome.",
    );
  }

  return ok({
    coreDisputeID: facts.coreDisputeID,
    courtID: facts.courtID,
    period,
    secondsRemaining,
    warnings,
  });
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
