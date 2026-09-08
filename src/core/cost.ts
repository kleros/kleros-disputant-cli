import { parseEther } from "viem";
import { formatWeiAsEth } from "./numbers.js";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * Cost arithmetic — `spec/02 §2`, `spec/04 §2`. Pure, and verified by
 * `spec/05 §1.5`.
 *
 * The chain protects against underpaying, not against overpaying:
 * `createDisputeForTemplate` reverts with `ArbitrationFeesNotEnough()` below the
 * quote and forwards whatever it is given above it. **The defence against
 * overpayment is arithmetic, not the chain's** — so the value sent is the quote
 * exactly, never the quote plus a margin and never a rounded quote, and the
 * ceiling is enforced here before anything is simulated or sent.
 */

/**
 * The threshold for "large in absolute terms" (`spec/02 §2`). Derived from the
 * live samples in `spec/01 §4.3`, which run from 0.00081 ETH (court 34, three
 * jurors) to 0.075 ETH (General Court, fifteen jurors): 0.05 sits above every
 * routine quote and below the ones worth a second look. It is an advisory —
 * it reaches `warnings` and never replaces the value or refuses.
 */
export const LARGE_QUOTE_WEI = parseEther("0.05");

export type QuoteAssessment = {
  /** Exactly what `arbitrationCost` returned, and exactly what will be sent. */
  wei: bigint;
  /** The same number as decimal ETH, for a reader who has to judge it. */
  eth: string;
  warnings: string[];
};

/**
 * The ceiling is an operator input with a conservative default, and it is
 * checked the moment the quote arrives — **before** `simulateContract` is
 * issued, so a refusal costs nothing and reveals nothing.
 */
export function checkCostCeiling({
  quotedWei,
  ceilingWei,
}: {
  quotedWei: bigint;
  ceilingWei: bigint;
}): KlerosResult<QuoteAssessment> {
  const eth = formatWeiAsEth(quotedWei);

  if (quotedWei > ceilingWei) {
    return err(
      "COST_CEILING_EXCEEDED",
      `The arbitration cost is ${eth} ETH, above the ${formatWeiAsEth(ceilingWei)} ETH ceiling. ` +
        "Nothing was sent. Raise --max-cost-eth only if that price is intended: the fee is paid " +
        "on creation and cannot be recovered.",
      { quotedWei: quotedWei.toString(), ceilingWei: ceilingWei.toString() },
    );
  }

  return ok({ wei: quotedWei, eth, warnings: quoteWarnings(quotedWei) });
}

/**
 * The magnitude advisory on its own, for `arbitration-cost`, which has no
 * ceiling to enforce — it quotes and stops, so there is nothing for a refusal to
 * protect. The advisory still applies: a large number is worth a second look
 * whether or not this invocation could have spent it.
 *
 * It **MUST** reach `warnings` and MUST NOT replace the value (`spec/02 §2`).
 */
export function quoteWarnings(quotedWei: bigint): string[] {
  if (quotedWei < LARGE_QUOTE_WEI) return [];
  return [
    `The arbitration cost is ${formatWeiAsEth(quotedWei)} ETH, which is large for this ` +
      "deployment. It is paid on creation and cannot be recovered.",
  ];
}

/**
 * `balance < value`, before anything is simulated.
 *
 * A lower bound, and the only part of affordability that is knowable without a
 * gas estimate — which is what makes it usable *before* `simulateContract`
 * rather than after. That ordering is the point, not the arithmetic:
 * **[live]** the Arbitrum One public endpoint enforces balance inside
 * `eth_call`, so an unfunded account fails simulation and comes back as
 * `SIMULATION_REVERTED` — exit 3, "the transaction reverted" — when the true
 * answer is "the account cannot pay", exit 1. A consuming agent branches on the
 * code, and those two codes call for different actions.
 *
 * `checkBalance` still runs afterwards and is not redundant: it is the one that
 * includes gas, and it is the one `spec/04 §2` names.
 */
export function checkValueAffordable({
  balanceWei,
  valueWei,
}: {
  balanceWei: bigint;
  valueWei: bigint;
}): KlerosResult<{ balanceWei: bigint }> {
  if (balanceWei < valueWei) {
    return err(
      "INSUFFICIENT_BALANCE",
      `The account holds ${formatWeiAsEth(balanceWei)} ETH and the arbitration fee alone is ` +
        `${formatWeiAsEth(valueWei)} ETH, before any gas. Nothing was sent.`,
      { balanceWei: balanceWei.toString(), valueWei: valueWei.toString() },
    );
  }
  return ok({ balanceWei });
}

/**
 * `balance < fee + value`, not `balance < fee`.
 *
 * The arbitration cost is `msg.value` and leaves the account alongside the gas
 * fee, so a check that omits it passes on an account that cannot pay and turns a
 * local refusal into a failed transaction (`spec/04 §2`).
 */
export function checkBalance({
  balanceWei,
  estimatedFeeWei,
  valueWei,
}: {
  balanceWei: bigint;
  estimatedFeeWei: bigint;
  valueWei: bigint;
}): KlerosResult<{ requiredWei: bigint }> {
  const requiredWei = estimatedFeeWei + valueWei;
  if (balanceWei < requiredWei) {
    return err(
      "INSUFFICIENT_BALANCE",
      `The account holds ${formatWeiAsEth(balanceWei)} ETH and needs ` +
        `${formatWeiAsEth(requiredWei)} ETH: ${formatWeiAsEth(valueWei)} ETH of arbitration cost ` +
        `plus ${formatWeiAsEth(estimatedFeeWei)} ETH of estimated gas. Nothing was sent.`,
      {
        balanceWei: balanceWei.toString(),
        requiredWei: requiredWei.toString(),
        valueWei: valueWei.toString(),
        estimatedFeeWei: estimatedFeeWei.toString(),
      },
    );
  }
  return ok({ requiredWei });
}
