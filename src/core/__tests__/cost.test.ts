import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import { checkBalance, checkCostCeiling, checkValueAffordable, LARGE_QUOTE_WEI } from "../cost.js";
import { EXTRA_DATA_VECTORS } from "./vectors.js";

/** `spec/05 §1.5`. */

const passOf = (input: Parameters<typeof checkCostCeiling>[0]) => {
  const result = checkCostCeiling(input);
  if (!result.success) throw new Error(`unexpected refusal: ${result.code}`);
  return result.data;
};

describe("the value sent is the quote", () => {
  it.each(EXTRA_DATA_VECTORS)("$name sends exactly its quote", ({ costWei, costEth }) => {
    // Not the quote plus a margin, not a rounded quote. The chain protects
    // against underpaying, not against overpaying (`spec/01 §3.2`).
    const assessment = passOf({ quotedWei: costWei, ceilingWei: parseEther("1") });
    expect(assessment.wei).toBe(costWei);
    expect(assessment.eth).toBe(costEth);
  });
});

describe("the cost ceiling", () => {
  const quotedWei = EXTRA_DATA_VECTORS[0].costWei;

  it("refuses a quote above it", () => {
    const result = checkCostCeiling({ quotedWei, ceilingWei: quotedWei - 1n });
    if (result.success) throw new Error("expected a refusal");
    expect(result.code).toBe("COST_CEILING_EXCEEDED");
    // The refusal happens on the quote alone, before anything is simulated —
    // there is nothing else in this call to simulate with.
    expect(result.message).toContain("0.015");
  });

  it("accepts a quote exactly at it", () => {
    expect(passOf({ quotedWei, ceilingWei: quotedWei }).wei).toBe(quotedWei);
  });

  it("refuses when the ceiling is zero", () => {
    expect(checkCostCeiling({ quotedWei, ceilingWei: 0n }).success).toBe(false);
  });
});

describe("the large-quote advisory", () => {
  it("warns without replacing the value", () => {
    // `spec/02 §2`: the warning reaches `warnings`, it does not become the
    // answer and it does not refuse.
    const assessment = passOf({ quotedWei: LARGE_QUOTE_WEI, ceilingWei: parseEther("1") });
    expect(assessment.warnings).toHaveLength(1);
    expect(assessment.wei).toBe(LARGE_QUOTE_WEI);
  });

  it("stays quiet on a routine quote", () => {
    // Court 2 with five jurors, 0.0345 ETH, is routine on this deployment.
    const assessment = passOf({
      quotedWei: EXTRA_DATA_VECTORS[1].costWei,
      ceilingWei: parseEther("1"),
    });
    expect(assessment.warnings).toEqual([]);
  });
});

describe("the balance check", () => {
  const valueWei = parseEther("0.015");
  const estimatedFeeWei = parseEther("0.0001");

  it("counts the arbitration cost, not only the gas", () => {
    // The comparison this replaces — `balance < fee` — passes here, and the
    // transaction then fails on chain having proved nothing.
    const balanceWei = estimatedFeeWei + valueWei - 1n;
    expect(balanceWei).toBeGreaterThan(estimatedFeeWei);

    const result = checkBalance({ balanceWei, estimatedFeeWei, valueWei });
    if (result.success) throw new Error("expected a refusal");
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
  });

  it("accepts a balance exactly equal to fee plus value", () => {
    const result = checkBalance({
      balanceWei: estimatedFeeWei + valueWei,
      estimatedFeeWei,
      valueWei,
    });
    if (!result.success) throw new Error(`unexpected refusal: ${result.code}`);
    expect(result.data.requiredWei).toBe(estimatedFeeWei + valueWei);
  });

  it("states the value in the refusal", () => {
    const result = checkBalance({ balanceWei: 0n, estimatedFeeWei, valueWei });
    if (result.success) throw new Error("expected a refusal");
    expect(result.message).toContain("0.015");
  });
});

/**
 * The refusal that has to happen **before** `simulateContract`, because the
 * ordering is what decides which code a consuming agent sees — `cost.ts`.
 */
describe("checkValueAffordable", () => {
  const valueWei = parseEther("0.015");

  it("refuses when the fee alone is out of reach, with no gas figure to hand", () => {
    const result = checkValueAffordable({ balanceWei: 0n, valueWei });
    if (result.success) throw new Error("expected a refusal");
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("0.015");
    // It must not imply a gas number it has not estimated.
    expect(result.message).toContain("before any gas");
  });

  it("accepts a balance exactly equal to the fee, leaving gas to the full check", () => {
    const result = checkValueAffordable({ balanceWei: valueWei, valueWei });
    expect(result.success).toBe(true);
  });

  /**
   * It is a lower bound, deliberately: it passes a balance that cannot cover the
   * gas, and `checkBalance` is what catches that once there is an estimate.
   */
  it("does not pretend to be the whole affordability check", () => {
    const result = checkValueAffordable({ balanceWei: valueWei, valueWei });
    expect(result.success).toBe(true);
    const full = checkBalance({
      balanceWei: valueWei,
      estimatedFeeWei: parseEther("0.0001"),
      valueWei,
    });
    expect(full.success).toBe(false);
  });
});

/**
 * Reachable on the evidence path only since the gas estimate stopped
 * pre-empting the check (`spec/04 §2.1`).
 */
describe("an unpayable call that pays no fee", () => {
  const shortfall = () =>
    checkBalance({ balanceWei: 0n, estimatedFeeWei: 3_358_028_275_200n, valueWei: 0n });

  it("does not name an arbitration cost the caller was never asked for", () => {
    const result = shortfall();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("no arbitration fee");
    expect(result.message).not.toContain("0 ETH of arbitration cost");
  });

  it("carries the remedy in the one details key that renders", () => {
    const result = shortfall();

    expect(result.success).toBe(false);
    if (result.success) return;
    expect((result.details as { hint: string }).hint).toContain("Fund the signing account");
  });

  it("still names both parts when a fee is genuinely owed", () => {
    const result = checkBalance({
      balanceWei: 1n,
      estimatedFeeWei: 10n ** 13n,
      valueWei: 15n * 10n ** 15n,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("of arbitration cost plus");
    expect(result.message).toContain("estimated gas");
  });
});
