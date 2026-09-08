import type { Address, Hex } from "viem";
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

/** What the operator asked for, already parsed. `spec/03 §3.2`. */
export type RequestedDispute = {
  courtID: bigint;
  jurors: bigint;
  disputeKitID: bigint;
  /**
   * Derived from the template's own `answers` array, never accepted as an
   * option — the two cannot disagree (`spec/02 §1.1`). Re-checked here because
   * it arrives from another module.
   */
  numberOfRulingOptions: bigint;
};

/** A contract this CLI refuses to act on, by address. `spec/01 §1`. */
export type RefusedAddress = { address: Address; name: string };

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
  /** `courts.length`. Court IDs run `0 .. courtsLength - 1`, and `0` is never valid. */
  courtsLength: bigint;
  /** `disputeKits.length`. */
  disputeKitsLength: bigint;
  /** `courts(courtID).disabled`. `undefined` when the court is out of range and the read reverted. */
  courtDisabled: boolean | undefined;
  /** `isSupported(courtID, kitID)`. Read on **every** invocation — court configuration is
   * governance-mutable, so a cached support table is a stale table (`spec/01 §4.2`). */
  kitSupported: boolean | undefined;
  /** `disputeKits(kitID)`, the resolved kit address. */
  kitAddress: Address | undefined;
  /** The governance override contracts, refused by name. `spec/01 §1`. */
  refusedAddresses: readonly RefusedAddress[];
};

export type PreflightFacts = {
  requested: RequestedDispute;
  chain: ChainFacts;
};

export type PreflightResult = {
  courtID: bigint;
  jurors: bigint;
  disputeKitID: bigint;
  numberOfRulingOptions: bigint;
  /**
   * Built here and nowhere else. The blob only exists once its three words have
   * been validated, so there is no unvalidated blob for a later step to pick up
   * by mistake, and one invocation quotes and sends the same bytes
   * (`spec/02 §1`).
   */
  extraData: Hex;
};

/** `kleros`, the peer read-plane CLI — verified against agentkit's own command tree. */
const COURT_LIST_HINT = "kleros court list --chain arbitrum-one";

/**
 * Refusal ordering is a diagnosis quality, not style: an out-of-range court is
 * reported as an out-of-range court, never as an unsupported kit. The order
 * follows `spec/02 §1.1`'s table top to bottom, and `spec/05 §1.2` asserts it.
 */
export function checkPreflight({
  requested,
  chain,
}: PreflightFacts): KlerosResult<PreflightResult> {
  const { courtID, jurors, disputeKitID, numberOfRulingOptions } = requested;
  const lastCourt = chain.courtsLength - 1n;

  // 1. Court in range. Court 0 is the Forking Court: it does not revert and
  //    reads all-zero, and the decoder maps it to General alongside any
  //    out-of-range ID (`spec/01 §4.1`).
  if (courtID === 0n) {
    return err(
      "COURT_OUT_OF_RANGE",
      "Court 0 is the Forking Court and is never a valid target: KlerosCore would create the " +
        `dispute in the General Court instead. Courts are 1 through ${lastCourt}. Nothing was sent.`,
      { courtID: courtID.toString(), hint: COURT_LIST_HINT },
    );
  }
  if (courtID >= chain.courtsLength) {
    return err(
      "COURT_OUT_OF_RANGE",
      `Court ${courtID} does not exist: KlerosCore has courts 1 through ${lastCourt}. ` +
        "A dispute asking for it would be created in the General Court and paid for. " +
        "Nothing was sent.",
      {
        courtID: courtID.toString(),
        courtsLength: chain.courtsLength.toString(),
        hint: COURT_LIST_HINT,
      },
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

  // 6. The kit is not a governance override contract (`spec/01 §1`).
  if (chain.refusedAddresses.length > 0) {
    if (chain.kitAddress === undefined) {
      return err(
        "DISPUTE_KIT_REFUSED",
        `Dispute kit ${disputeKitID} could not be checked against the governance override ` +
          "contracts: its address was not read. Nothing was sent.",
        { disputeKitID: disputeKitID.toString() },
      );
    }
    const kit = chain.kitAddress.toLowerCase();
    const refused = chain.refusedAddresses.find((r) => r.address.toLowerCase() === kit);
    if (refused !== undefined) {
      return err(
        "DISPUTE_KIT_REFUSED",
        `Dispute kit ${disputeKitID} resolves to ${refused.name}, a governance override ` +
          "contract this tool refuses to act on. Nothing was sent.",
        { disputeKitID: disputeKitID.toString(), contract: refused.name },
      );
    }
  }

  // 7. Ruling options. Derived from the template, so this is an assertion over a
  //    value built elsewhere rather than a check on operator input. The contract
  //    refuses fewer than two with a reason string; it does **not** check that
  //    the count matches the template (`spec/02 §1.1`).
  if (numberOfRulingOptions < 2n) {
    return err(
      "RULING_OPTIONS_INVALID",
      `A dispute needs at least two ruling options; the template offers ${numberOfRulingOptions}. ` +
        "Nothing was sent.",
      { numberOfRulingOptions: numberOfRulingOptions.toString() },
    );
  }

  return ok({
    courtID,
    jurors,
    disputeKitID,
    numberOfRulingOptions,
    extraData: encodeExtraData({ courtID, jurors, disputeKitID }),
  });
}
