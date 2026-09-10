import type { Hex } from "viem";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  size,
  slice,
  toFunctionSelector,
} from "viem";
import { contractsFor } from "./deployment.js";
import { DEPLOYMENT_SLUGS, DEPLOYMENTS } from "./deployments.js";
import { boundForeign } from "./foreign-text.js";

/**
 * Revert decoding — `spec/01 §5`, verified by `spec/05 §2.6`.
 *
 * **Decoding is not uniform here, and that is the trap.** `DisputeResolver`
 * declares *zero* custom errors **[abi]**, but its reverts are not anonymous:
 * its own guards are `require` statements carrying `Error(string)`, while the
 * failures it *forwards* from `KlerosCore` arrive as bare 4-byte selectors that
 * are named in `klerosCoreAbi` and appear nowhere in `disputeResolverAbi`.
 *
 * viem, given only the call target's ABI, therefore cannot name a forwarded core
 * error — it raises `AbiErrorSignatureNotFoundError` and hands back a signature.
 * So this module ignores viem's decoding entirely and works from
 * `ContractFunctionRevertedError.raw`, the untouched revert data, against **its
 * own selector table spanning all three ABIs**. `spec/01 §5` requires exactly
 * that.
 *
 * Nothing here is hand-copied. The table is computed from the imported ABIs
 * (ADR-0006), so an upstream error rename moves the selector and the fingerprint
 * test is what catches it.
 */

/**
 * What is said when the failure carries no sentence of its own.
 *
 * **This replaced `error.shortMessage || error.message`** (`ADR-0017`). viem's
 * full `message` is its `shortMessage` plus the request dump — the contract
 * address, the function, the arguments, the docs URL and, on a transport
 * failure, **the endpoint URL**, whose path on a paid endpoint *is* the
 * credential. Measured at 2283 characters carrying an API key. Nothing
 * establishes that a viem error can ship an empty `shortMessage` and reach the
 * right-hand side, and nothing needs to: a fixed sentence costs a caller
 * nothing that the code beside it does not already say.
 *
 * `client.ts` redacts URLs out of the RPC cause for the same reason; this path
 * declines to collect one in the first place.
 */
const NO_REASON = "The call failed and no reason was given.";

/** `Error(string)` — Solidity's `require` reason. `DisputeResolver`'s own guards. */
const ERROR_STRING = "0x08c379a0";
/** `Panic(uint256)` — what an out-of-range array getter raises (`spec/01 §8`). */
const PANIC = "0x4e487b71";

/** The panic codes this tool can actually provoke. Anything else is reported by number. */
const PANIC_REASONS: ReadonlyMap<string, string> = new Map([
  ["0x01", "an assertion failed"],
  ["0x11", "an arithmetic operation overflowed"],
  ["0x32", "an array index is out of bounds"],
]);

type AbiErrorEntry = { type: string; name?: string; inputs?: readonly { type: string }[] };

/**
 * Selector → error name, over `klerosCoreAbi`, `disputeResolverAbi` and
 * `evidenceModuleAbi` **of every deployment this tool serves**, at once. The
 * union is the point: the selector on the wire comes from whichever contract in
 * the call stack reverted, not from the one that was called.
 *
 * Spanning deployments as well as contracts is what keeps this module free of a
 * deployment argument. Decoding is a **lookup**, not a decision: a selector
 * present on one deployment and absent on another still names the same error
 * wherever it appears, and naming it can only improve a message. Threading a
 * deployment down to `decodeRevert` — through `broadcast.ts`, which has no other
 * reason to know one — would buy nothing but the ability to refuse to name an
 * error we can name.
 *
 * Names shared across ABIs (`AlreadyInitialized`, the UUPS pair) carry the same
 * selector by construction, so the merge cannot disagree with itself.
 *
 * **Measured when the second deployment was registered [abi]:** the union is not
 * merely a superset by luck. The v2 testnet's `KlerosCore` declares **no error
 * v2 Beta does not** — the difference runs the other way, four Beta-only errors
 * including `ArbitrableNotWhitelisted` (`spec/01 §1.0b`) — so every selector the
 * testnet can put on the wire was already in this table before it was served.
 */
const SERVED_ABIS = DEPLOYMENT_SLUGS.flatMap((slug) => {
  const contracts = contractsFor(DEPLOYMENTS[slug]);
  return [
    contracts.klerosCore.abi,
    contracts.disputeResolver.abi,
    contracts.evidenceModule.abi,
  ] as readonly (readonly unknown[])[];
});

export const ERROR_SELECTORS: ReadonlyMap<string, string> = new Map(
  SERVED_ABIS.flatMap((abi) =>
    (abi as readonly AbiErrorEntry[])
      .filter((entry): entry is AbiErrorEntry & { name: string } =>
        Boolean(entry.type === "error" && entry.name),
      )
      .map(
        (entry) =>
          [
            toFunctionSelector(
              `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(",")})`,
            ),
            entry.name,
          ] as const,
      ),
  ),
);

/**
 * Guidance for the failures this tool can actually cause, keyed by what the
 * chain says rather than by what provoked it. Every row is one of `spec/01 §5`'s
 * four observed conditions.
 *
 * **A `Map`, not an object literal, and that is load-bearing.** The key here
 * comes off the wire: a contract reverting with `require(false, "constructor")`
 * indexes an object literal straight into `Object.prototype`, which returns a
 * *function*. `??` does not fall through on it — it is neither `null` nor
 * `undefined` — so the bound is skipped and `guidance`, typed `string`, holds
 * `function Object() { [native code] }` at runtime. A `Map` has no prototype
 * chain to walk. `ERROR_SELECTORS` above was already one; the tables below
 * follow for the same reason, though only this one takes a wire-controlled key.
 *
 * `ShouldBeAtLeastTwoRulingOptions()` (`0x5fea5b86`) is deliberately **absent**.
 * It exists in the contracts package's Solidity, which is compiled from `master`
 * and is not the deployed code; the deployment reverts with the reason string
 * below instead (`spec/01 §2`, `§5`). Keying on it would silently stop matching
 * the day someone believed it.
 */
const GUIDANCE_BY_REASON: ReadonlyMap<string, string> = new Map([
  [
    "Should be at least 2 ruling options.",
    "The template offers fewer than two ruling options. Add answers to the template; the count " +
      "is derived from them and is never a flag.",
  ],
]);

const GUIDANCE_BY_ERROR: ReadonlyMap<string, string> = new Map([
  [
    "ArbitrationFeesNotEnough",
    "KlerosCore was sent less than arbitrationCost. The quote and the transaction must come from " +
      "one invocation with byte-identical extraData; a cost that moved between the two is the " +
      "usual cause. Nothing was created and the fee was not paid.",
  ],
  [
    "DisputeKitNotSupportedByCourt",
    "The court does not support the requested dispute kit. Pre-flight reads isSupported on every " +
      "invocation, so seeing this means court configuration changed between that read and this " +
      "call. Nothing was created and the fee was not paid.",
  ],
  [
    "ArbitrableNotWhitelisted",
    "KlerosCore accepts createDispute only from a whitelisted arbitrable, and an EOA is never " +
      "one. This tool writes through DisputeResolver, so this can only mean the call was aimed at " +
      "the core directly.",
  ],
]);

export type DecodedRevert = {
  /**
   * The reason string, the custom error name, or a panic description. `null`
   * when neither. **Unbounded**, like `data` and for the same reason.
   */
  reason: string | null;
  /**
   * The revert data, **verbatim and unbounded**. `spec/01 §5` requires unmapped
   * data be surfaced rather than swallowed, and this is where it survives —
   * `guidance` now carries only a bounded prefix of it (`ADR-0017`). No output
   * mode renders `details`, so the full data costs a CLI caller nothing and is
   * there for a consumer importing this module from `dist/index.js`.
   */
  data: Hex | null;
  /**
   * What to tell the operator, and the only field that reaches a `message`.
   * Every fragment of it that came off the wire is bounded and stripped of
   * control characters by `boundForeign` (`ADR-0017`); this repo's own
   * sentences are not. Falls back to a fixed line, never to silence.
   */
  guidance: string;
};

export function decodeRevert(error: unknown): DecodedRevert {
  const raw = rawRevertData(error);

  if (raw !== null && raw.length >= 10) {
    const selector = slice(raw, 0, 4);

    if (selector === ERROR_STRING) {
      const reason = decodeErrorString(raw);
      if (reason !== null) {
        return {
          reason,
          data: raw,
          // Our own sentence at full length, or the contract's bounded
          // (`ADR-0017`). A reason of nothing but control characters bounds to
          // the empty string, and an empty guidance would render as a message
          // that begins mid-sentence.
          guidance: GUIDANCE_BY_REASON.get(reason) ?? (boundForeign(reason) || NO_REASON),
        };
      }
    }

    if (selector === PANIC) {
      const code = decodePanicCode(raw);
      const described = code === null ? null : PANIC_REASONS.get(code);
      const reason = code === null ? "panic" : `panic ${code}`;
      return {
        reason,
        data: raw,
        guidance: described
          ? `The contract reverted because ${described}.`
          : `The contract reverted with a Solidity panic (${reason}).`,
      };
    }

    const name = ERROR_SELECTORS.get(selector);
    if (name !== undefined) {
      return {
        reason: name,
        data: raw,
        guidance: GUIDANCE_BY_ERROR.get(name) ?? `The contract reverted with ${name}().`,
      };
    }

    // Unmapped: named by neither ABI. Surfaced rather than swallowed — a
    // selector a reader can look up beats a message that lost it. The selector
    // is whole and the blob is bounded; `data` above keeps all of it
    // (`spec/01 §5`, `ADR-0017`).
    return {
      reason: null,
      data: raw,
      guidance:
        `The contract reverted with unrecognised data ${boundForeign(raw)} (${size(raw)} bytes). ` +
        `The selector ${selector} is in neither KlerosCore's ABI nor DisputeResolver's nor ` +
        "EvidenceModule's, so the deployment may have moved ahead of this tool.",
    };
  }

  if (error instanceof BaseError) {
    return { reason: null, data: raw, guidance: boundForeign(error.shortMessage) || NO_REASON };
  }
  return {
    reason: null,
    data: raw,
    guidance: boundForeign(error instanceof Error ? error.message : String(error)) || NO_REASON,
  };
}

/**
 * viem always sets `raw` to the revert data it was handed, whether or not it
 * could decode it against the ABI it was given — which is what makes working
 * from `raw` rather than from `data.errorName` possible at all.
 */
function rawRevertData(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  return null;
}

function decodeErrorString(raw: Hex): string | null {
  try {
    const [reason] = decodeAbiParameters([{ type: "string" }], slice(raw, 4));
    return reason;
  } catch {
    return null;
  }
}

function decodePanicCode(raw: Hex): string | null {
  try {
    const [code] = decodeAbiParameters([{ type: "uint256" }], slice(raw, 4));
    return `0x${code.toString(16).padStart(2, "0")}`;
  } catch {
    return null;
  }
}
