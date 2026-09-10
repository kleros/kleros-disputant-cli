import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
} from "viem";
import { describe, expect, it } from "vitest";
import { contractsFor } from "../deployment.js";
import { DEFAULT_DEPLOYMENT } from "../deployments.js";
import { FOREIGN_TEXT_LIMIT } from "../foreign-text.js";
import { decodeRevert, ERROR_SELECTORS } from "../reverts.js";

/** The default deployment. The suite is not a matrix — `spec/05 §1.6b`. */
const contracts = contractsFor(DEFAULT_DEPLOYMENT);

/**
 * `spec/01 §5` — and the trap it names: `DisputeResolver` declares zero custom
 * errors, so viem given only *its* ABI cannot name a `KlerosCore` error
 * forwarded through it. Every error below is therefore constructed the way viem
 * constructs it on the create path — **with the resolver's ABI** — which is the
 * situation that breaks naming and the reason this module works from `raw`.
 */

/** As viem builds it inside `simulateContract`, with the call target's ABI. */
const reverted = (data: `0x${string}`, abi: readonly unknown[] = contracts.disputeResolver.abi) =>
  new ContractFunctionRevertedError({
    abi: abi as never,
    data,
    functionName: "createDisputeForTemplate",
  });

const errorString = (reason: string) =>
  encodeErrorResult({
    abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
    errorName: "Error",
    args: [reason],
  });

const panic = (code: bigint) =>
  `0x4e487b71${encodeAbiParameters([{ type: "uint256" }], [code]).slice(2)}` as const;

describe("the selector table", () => {
  /** `spec/01 §5`'s four observed conditions, selectors **[computed]**. */
  it.each([
    ["0xb34eb75d", "DisputeKitNotSupportedByCourt"],
    ["0x38cd83c4", "ArbitrationFeesNotEnough"],
    ["0x203b0c18", "ArbitrableNotWhitelisted"],
  ])("maps %s to %s", (selector, name) => {
    expect(ERROR_SELECTORS.get(selector)).toBe(name);
  });

  /**
   * The one that must stay absent. `ShouldBeAtLeastTwoRulingOptions()` exists in
   * the contracts package's Solidity — compiled from `master`, not deployed — and
   * the deployment reverts with a reason string instead (`spec/01 §2`, `§5`).
   */
  it("does not know 0x5fea5b86, which the deployment never emits", () => {
    expect(ERROR_SELECTORS.has("0x5fea5b86")).toBe(false);
  });

  it("is built from the ABIs rather than hand-copied", () => {
    const declared = (contracts.klerosCore.abi as readonly { type: string }[]).filter(
      (e) => e.type === "error",
    ).length;
    expect(ERROR_SELECTORS.size).toBeGreaterThanOrEqual(declared);
  });
});

describe("decoding a revert", () => {
  /**
   * The load-bearing case. viem was handed `disputeResolverAbi`, which declares
   * no errors at all, so its own decoding fails and it records only a signature.
   * The name comes from this module's own table instead.
   */
  it("names a core error forwarded through DisputeResolver", () => {
    const result = decodeRevert(reverted("0xb34eb75d"));
    expect(result.reason).toBe("DisputeKitNotSupportedByCourt");
    expect(result.data).toBe("0xb34eb75d");
    expect(result.guidance).toContain("does not support the requested dispute kit");
  });

  it("names an underpayment and says the fee was not paid", () => {
    const result = decodeRevert(reverted("0x38cd83c4"));
    expect(result.reason).toBe("ArbitrationFeesNotEnough");
    expect(result.guidance).toContain("byte-identical extraData");
    expect(result.guidance).toContain("fee was not paid");
  });

  it("names the whitelist refusal an EOA gets from the core directly", () => {
    const result = decodeRevert(reverted("0x203b0c18", contracts.klerosCore.abi));
    expect(result.reason).toBe("ArbitrableNotWhitelisted");
    expect(result.guidance).toContain("never one");
  });

  /** `DisputeResolver`'s own guards are `require` strings, not custom errors. */
  it("decodes Error(string) and maps the ruling-options guard", () => {
    const result = decodeRevert(reverted(errorString("Should be at least 2 ruling options.")));
    expect(result.reason).toBe("Should be at least 2 ruling options.");
    expect(result.guidance).toContain("Add answers to the template");
    expect(result.guidance).toContain("never a flag");
  });

  it("passes an unmapped reason string through as its own guidance", () => {
    const result = decodeRevert(reverted(errorString("Something else entirely.")));
    expect(result.reason).toBe("Something else entirely.");
    expect(result.guidance).toBe("Something else entirely.");
  });

  /** An out-of-range array getter panics rather than reverting readably. */
  it("describes panic 0x32 in words", () => {
    const result = decodeRevert(reverted(panic(0x32n)));
    expect(result.reason).toBe("panic 0x32");
    expect(result.guidance).toContain("array index is out of bounds");
  });

  it("reports an unfamiliar panic code by number", () => {
    const result = decodeRevert(reverted(panic(0x99n)));
    expect(result.reason).toBe("panic 0x99");
    expect(result.guidance).toContain("Solidity panic");
  });

  /**
   * `spec/01 §5`: unmapped revert data MUST be surfaced rather than swallowed.
   * A selector a reader can look up beats a message that lost it. The message
   * carries the selector and a bounded prefix; `data` carries all of it
   * (`ADR-0017`).
   */
  it("surfaces unrecognised revert data verbatim", () => {
    const result = decodeRevert(reverted("0xdeadbeef"));
    expect(result.reason).toBeNull();
    expect(result.data).toBe("0xdeadbeef");
    expect(result.guidance).toContain("0xdeadbeef");
    expect(result.guidance).toContain("may have moved ahead of this tool");
  });

  it("falls back to the message when there is no revert data at all", () => {
    const result = decodeRevert(new Error("fetch failed"));
    expect(result).toEqual({ reason: null, data: null, guidance: "fetch failed" });
  });

  it("does not throw on a non-Error", () => {
    expect(decodeRevert("boom").guidance).toBe("boom");
  });
});

/**
 * `ADR-0017` — every fragment of a message that came off the wire is bounded
 * and stripped; this repo's own sentences are not. The payloads here are the
 * ones measured in `.scratch/revert-message-bounds/spec.md`.
 */
describe("bounding what came off the wire", () => {
  const ESC = String.fromCharCode(0x1b);

  it("bounds an oversized reason string, and marks the cut", () => {
    const result = decodeRevert(reverted(errorString("A".repeat(8192))));
    expect(result.guidance).toHaveLength(FOREIGN_TEXT_LIMIT);
    expect(result.guidance.endsWith("…")).toBe(true);
  });

  /** The fields are invisible to every output mode, so they keep everything. */
  it("leaves `reason` and `data` unbounded while `guidance` is bounded", () => {
    const result = decodeRevert(reverted(errorString("A".repeat(8192))));
    expect(result.reason).toHaveLength(8192);
    expect(result.data).toHaveLength(2 + 2 * (4 + 32 + 32 + 8192));
  });

  /**
   * The measured payload cleared the terminal and forged a second JSON envelope
   * inside `message`. A quote is prose and survives; a cursor movement is not.
   */
  it("strips the control characters out of a reason string", () => {
    const result = decodeRevert(
      reverted(errorString(`Reverted.\n${ESC}[2J"}\n{"success":true} Re-run with --broadcast.`)),
    );
    expect(result.guidance).not.toContain(ESC);
    expect(result.guidance).not.toContain("\n");
    expect(result.guidance).toBe('Reverted. [2J"} {"success":true} Re-run with --broadcast.');
    // Unbounded on the field, so nothing is lost to a consumer that wants it.
    expect(result.reason).toContain(ESC);
  });

  it("bounds unrecognised data but keeps the selector whole, and says how much there was", () => {
    const blob = `0xdeadbeef${"41".repeat(4096)}` as const;
    const result = decodeRevert(reverted(blob));
    expect(result.guidance).toContain("0xdeadbeef");
    expect(result.guidance).toContain("(4100 bytes)");
    expect(result.guidance).toContain("…");
    // The whole message stays short; only the prefix of the blob survives.
    expect(result.guidance.length).toBeLessThan(400);
    expect(result.data).toBe(blob);
  });

  /**
   * The bound is on the fragment, not on the message. This repo's own guidance
   * for an underpayment runs past the limit and MUST NOT be clipped — a cap
   * applied one level up would have cut it.
   */
  it("does not truncate this repo's own guidance, even past the limit", () => {
    const result = decodeRevert(reverted("0x38cd83c4"));
    expect(result.guidance.length).toBeGreaterThan(FOREIGN_TEXT_LIMIT);
    expect(result.guidance.endsWith("…")).toBe(false);
    expect(result.guidance).toContain("fee was not paid");
  });

  it("does not truncate a mapped reason's own sentence", () => {
    const result = decodeRevert(reverted(errorString("Should be at least 2 ruling options.")));
    expect(result.guidance.endsWith("…")).toBe(false);
    expect(result.guidance).toContain("never a flag");
  });

  /**
   * **The credential case.** viem's full `message` is the request dump — and on
   * a transport failure it names the endpoint, whose path on a paid endpoint is
   * the API key. Only `shortMessage` is read now.
   */
  it("reads viem's shortMessage and never its full message", () => {
    const error = new BaseError("HTTP request failed.", {
      metaMessages: ["URL: https://rpc.example.test/v2/sk_live_SUPERSECRET"],
    });
    expect(error.message).toContain("sk_live_SUPERSECRET");

    const result = decodeRevert(error);
    expect(result.guidance).toBe("HTTP request failed.");
    expect(result.guidance).not.toContain("sk_live_SUPERSECRET");
    expect(result.guidance).not.toContain("Version:");
  });

  /**
   * The falsifiable half of the case above: with no `shortMessage` to read, the
   * old `shortMessage || message` reached for the request dump — and the dump
   * names the endpoint. This is the shape in which the credential escaped.
   */
  it("says something fixed rather than reaching for the dump that names the endpoint", () => {
    const error = new BaseError("", {
      metaMessages: ["URL: https://rpc.example.test/v2/sk_live_SUPERSECRET"],
    });
    expect(error.message).toContain("sk_live_SUPERSECRET");

    const result = decodeRevert(error);
    expect(result.guidance).toBe("The call failed and no reason was given.");
    expect(result.guidance).not.toContain("sk_live_SUPERSECRET");
  });

  /**
   * A reason of nothing but control characters bounds to the empty string. An
   * empty guidance renders as a message that begins mid-sentence — " Nothing
   * was sent." — so the fixed line takes over.
   */
  it("does not render an empty guidance when the whole reason was control characters", () => {
    const result = decodeRevert(reverted(errorString(`\n\n${String.fromCharCode(0x1b)}`)));
    expect(result.guidance).toBe("The call failed and no reason was given.");
  });

  /**
   * The reason is a key from the wire. Against an object literal, `"constructor"`
   * reaches `Object.prototype` and returns a function, which `??` does not treat
   * as absent — so the bound was skipped and `guidance`, typed `string`, held
   * `function Object() { [native code] }`. Found by `/code-review`.
   */
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "treats the prototype member %s as an ordinary unmapped reason",
    (key) => {
      const result = decodeRevert(reverted(errorString(key)));
      expect(typeof result.guidance).toBe("string");
      expect(result.guidance).toBe(key);
    },
  );

  it("bounds a prototype-named reason like any other", () => {
    const result = decodeRevert(reverted(errorString(`constructor ${"A".repeat(8192)}`)));
    expect(result.guidance).toHaveLength(FOREIGN_TEXT_LIMIT);
  });

  it("bounds a non-viem failure too", () => {
    const result = decodeRevert(new Error("B".repeat(500)));
    expect(result.guidance).toHaveLength(FOREIGN_TEXT_LIMIT);
  });
});
