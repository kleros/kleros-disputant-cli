import { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult } from "viem";
import { describe, expect, it } from "vitest";
import { DISPUTE_RESOLVER_ABI, KLEROS_CORE_ABI } from "../deployment.js";
import { decodeRevert, ERROR_SELECTORS } from "../reverts.js";

/**
 * `spec/01 §5` — and the trap it names: `DisputeResolver` declares zero custom
 * errors, so viem given only *its* ABI cannot name a `KlerosCore` error
 * forwarded through it. Every error below is therefore constructed the way viem
 * constructs it on the create path — **with the resolver's ABI** — which is the
 * situation that breaks naming and the reason this module works from `raw`.
 */

/** As viem builds it inside `simulateContract`, with the call target's ABI. */
const reverted = (data: `0x${string}`, abi: readonly unknown[] = DISPUTE_RESOLVER_ABI) =>
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
    const declared = (KLEROS_CORE_ABI as readonly { type: string }[]).filter(
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
    const result = decodeRevert(reverted("0x203b0c18", KLEROS_CORE_ABI));
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
   * `spec/01 §5`: unmapped revert data MUST be surfaced verbatim rather than
   * swallowed. A selector a reader can look up beats a message that lost it.
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
