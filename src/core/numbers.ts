import { formatEther, parseEther } from "viem";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * Numeric option parsing — `spec/03 §3.1`.
 *
 * Every option is `z.string()`, including the numeric ones, so that a bad number
 * fails with a stable `code` in the payload rather than with incur's own
 * validation error. Nothing here coerces: a value that is not unambiguously the
 * integer the operator meant is refused, because the mistake it would otherwise
 * cause is paid for irreversibly.
 */

/** Non-negative decimal integers only. No signs, no hex, no decimals, no exponents. */
const DECIMAL_UINT = /^\d+$/;

/** A decimal ETH amount: digits, optionally a fractional part. Not `1e-3`, not `0x…`. */
const DECIMAL_AMOUNT = /^\d+(?:\.\d+)?$/;

/** Wei has 18 decimal places; `parseEther` truncates a 19th silently. */
const WEI_DECIMALS = 18;

/**
 * `--court 3` → `3n`. `option` names the flag so the message points at the flag
 * the operator typed rather than at an internal field name.
 */
export function parseBigInt(text: string, option: string): KlerosResult<bigint> {
  // Trimming cannot change which integer is meant. Anything else is refused
  // rather than coerced.
  const trimmed = text.trim();
  if (trimmed === "") {
    return err("NUMBER_INVALID", `${option} is required and was empty.`, { option });
  }
  if (!DECIMAL_UINT.test(trimmed)) {
    return err(
      "NUMBER_INVALID",
      `${option} must be a non-negative decimal integer; got ${JSON.stringify(text)}. ` +
        "Nothing was sent.",
      { option, value: text },
    );
  }
  return ok(BigInt(trimmed));
}

/**
 * `--max-cost-eth 0.02` → `20000000000000000n`.
 *
 * More than 18 decimal places is refused rather than truncated: a ceiling that
 * silently loses its last digits is a ceiling the operator did not set.
 */
export function parseEthToWei(text: string, option: string): KlerosResult<bigint> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return err("NUMBER_INVALID", `${option} is required and was empty.`, { option });
  }
  if (!DECIMAL_AMOUNT.test(trimmed)) {
    return err(
      "NUMBER_INVALID",
      `${option} must be a decimal amount of ETH, such as 0.02; got ${JSON.stringify(text)}. ` +
        "Nothing was sent.",
      { option, value: text },
    );
  }
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > WEI_DECIMALS) {
    return err(
      "NUMBER_INVALID",
      `${option} has ${fraction.length} decimal places; ETH has at most ${WEI_DECIMALS}. ` +
        "Nothing was sent.",
      { option, value: text },
    );
  }
  return ok(parseEther(trimmed));
}

/**
 * Wei → the decimal ETH string used in envelopes alongside the wei value. Both
 * are always reported: wei is the number that was sent, ETH is the number a
 * reader can judge (`spec/02 §2`).
 */
export function formatWeiAsEth(wei: bigint): string {
  return formatEther(wei);
}
