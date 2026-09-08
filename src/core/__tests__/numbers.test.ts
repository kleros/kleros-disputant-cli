import { describe, expect, it } from "vitest";
import { formatWeiAsEth, parseBigInt, parseEthToWei } from "../numbers.js";
import { EXTRA_DATA_VECTORS } from "./vectors.js";

/**
 * `spec/03 §3.1` — every numeric option is a string, parsed here, so a bad
 * number fails with a stable `code` rather than with incur's validation error.
 * Nothing coerces: a value that is not unambiguously the number the operator
 * meant is refused.
 */

describe("parseBigInt", () => {
  it.each([
    ["0", 0n],
    ["1", 1n],
    ["34", 34n],
    [" 3 ", 3n],
  ])("parses %s", (input, expected) => {
    const result = parseBigInt(input, "--court");
    if (!result.success) throw new Error(`unexpected refusal: ${result.message}`);
    expect(result.data).toBe(expected);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["negative", "-1"],
    ["decimal", "1.5"],
    ["hex", "0x5"],
    ["exponent", "1e3"],
    ["signed", "+5"],
    ["non-numeric", "five"],
    ["thousands separator", "1,000"],
  ])("refuses %s input", (_label, input) => {
    const result = parseBigInt(input, "--court");
    if (result.success) throw new Error("expected a refusal");
    expect(result.code).toBe("NUMBER_INVALID");
    expect(result.message).toContain("--court");
  });

  it("parses above Number.MAX_SAFE_INTEGER without loss", () => {
    const big = (2n ** 60n).toString();
    const result = parseBigInt(big, "--dispute");
    if (!result.success) throw new Error("unexpected refusal");
    expect(result.data.toString()).toBe(big);
  });
});

describe("parseEthToWei", () => {
  it.each([
    ["0.015", 15000000000000000n],
    ["0.00081", 810000000000000n],
    ["1", 1000000000000000000n],
    ["0", 0n],
  ])("parses %s ETH", (input, expected) => {
    const result = parseEthToWei(input, "--max-cost-eth");
    if (!result.success) throw new Error(`unexpected refusal: ${result.message}`);
    expect(result.data).toBe(expected);
  });

  it("refuses more than eighteen decimal places rather than truncating", () => {
    // `parseEther` drops the nineteenth digit silently, and a ceiling that
    // silently loses its last digits is a ceiling the operator did not set.
    const result = parseEthToWei(`0.${"0".repeat(18)}1`, "--max-cost-eth");
    if (result.success) throw new Error("expected a refusal");
    expect(result.code).toBe("NUMBER_INVALID");
  });

  it.each([
    ["exponent", "1e-3"],
    ["hex", "0x1"],
    ["negative", "-1"],
    ["two points", "1.2.3"],
    ["trailing point", "1."],
    ["empty", ""],
  ])("refuses %s input", (_label, input) => {
    expect(parseEthToWei(input, "--max-cost-eth").success).toBe(false);
  });
});

describe("formatWeiAsEth", () => {
  it.each(EXTRA_DATA_VECTORS)("$name formats to the spec's decimal", ({ costWei, costEth }) => {
    expect(formatWeiAsEth(costWei)).toBe(costEth);
  });
});
