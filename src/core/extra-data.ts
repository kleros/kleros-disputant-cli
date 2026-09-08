import { encodeAbiParameters, type Hex } from "viem";

/**
 * `_arbitratorExtraData` — `spec/02 §1`.
 *
 * Three 32-byte words: court ID, juror count, dispute kit ID. This blob decides
 * which court a paid dispute lands in, and **a wrong value does not revert**: the
 * deployed decoder substitutes General Court / the default juror count / Classic
 * and creates a paid dispute somewhere the operator did not ask for
 * (`spec/01 §4.4`). Simulation cannot catch it. Everything that protects against
 * that lives in `preflight.ts`, which is why this module is only ever reached
 * through it.
 *
 * `encodePacked` MUST NOT be used. The 44-byte packed form in the published
 * Kleros documentation quotes and creates against the General Court whichever
 * court it names — verified live across two different court IDs (`spec/01 §4.4`).
 */

/** Exactly 96 bytes, for the kits in scope. `spec/02 §1`. */
export const EXTRA_DATA_BYTES = 96;

export type ExtraDataWords = {
  courtID: bigint;
  jurors: bigint;
  disputeKitID: bigint;
};

const WORDS = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

/**
 * The three words, ABI-encoded. Structurally 96 bytes: three fixed-width
 * `uint256`s cannot encode to any other length, which is why the length is
 * asserted in the vector test rather than re-checked here.
 *
 * The returned blob is byte-identical for identical inputs, so the same value
 * can be handed to `arbitrationCost` and to `createDisputeForTemplate` in one
 * invocation. It MUST NOT be rebuilt between the quote and the send.
 */
export function encodeExtraData({ courtID, jurors, disputeKitID }: ExtraDataWords): Hex {
  return encodeAbiParameters(WORDS, [courtID, jurors, disputeKitID]);
}
