import type { Abi, Address, Hex, PrivateKeyAccount, PublicClient } from "viem";
import { createWalletClient, formatEther, http } from "viem";
import { arbitrum } from "viem/chains";
import { rpcError } from "./client.js";
import { checkBalance } from "./cost.js";
import { err, type KlerosResult, ok } from "./result.js";
import { decodeRevert } from "./reverts.js";

/**
 * Simulate, price, and optionally send one state-changing call — `spec/04`.
 *
 * Inherited wholesale from `kleros-juror-cli`'s `broadcast.ts`, with the three
 * changes `spec/04 §2` requires because **this tool's transactions carry
 * money**. They are marked below.
 *
 * The default is plan → simulate → stop. Nothing is broadcast without
 * `--broadcast`: there is no human confirmation gate and nothing upstream
 * provides one (ADR-0004).
 *
 * > Simulation is **not** a safety net for `extraData`. Every silent-default
 * > case simulates cleanly (`spec/01 §4.4`), so `checkPreflight` is the only
 * > thing that catches a wrong court, a zero juror count or an out-of-range kit.
 * > What simulation does catch is an unsupported kit, an underpayment and a
 * > malformed template argument.
 */

/** The gas buffer every bot in the Kleros repo uses. Kept verbatim (`spec/04 §2`). */
const GAS_BUFFER_NUMERATOR = 150n;
const GAS_BUFFER_DENOMINATOR = 100n;

/**
 * A generous cap costs nothing: on Arbitrum the sender is charged the base fee
 * regardless of the cap, and tips are ignored entirely. The cap only protects
 * against a base fee that has risen since estimation. Kept verbatim.
 */
const MAX_FEE_MULTIPLIER = 3n;

/** The two write calls this CLI makes, and the only two (`spec/03 §2`). */
export type WriteCall =
  | {
      functionName: "createDisputeForTemplate";
      /** `(bytes _arbitratorExtraData, string _disputeTemplate, string _dataMappings, uint256 _numberOfRulingOptions)` */
      args: readonly [Hex, string, string, bigint];
    }
  | {
      functionName: "submitEvidence";
      /** `(uint256 _externalDisputeID, string _evidence)` — the core dispute ID (`spec/02 §4.2`). */
      args: readonly [bigint, string];
    };

export type BroadcastParams = {
  client: PublicClient;
  account: PrivateKeyAccount;
  /**
   * **Change 1 of `spec/04 §2`.** The juror CLI hard-codes the dispute kit ABI
   * and takes `disputeKit: Address`; this tool hits two contracts with two ABIs,
   * so the target travels with its ABI.
   */
  target: { address: Address; abi: Abi };
  call: WriteCall;
  /**
   * **Change 2 of `spec/04 §2`.** `createDisputeForTemplate` is payable and
   * `submitEvidence` is not, so this is optional — but where it is present it
   * MUST reach `simulateContract`, `estimateContractGas` **and**
   * `writeContract`. Threading it into two of the three is the bug that does not
   * show up until broadcast, so all three read it from one object built once
   * (see `request` below) rather than each taking their own copy.
   *
   * The amount MUST be `arbitrationCost(extraData)` exactly, quoted in this same
   * invocation with the byte-identical blob (`spec/04 §4`).
   */
  value?: bigint;
  /** False means plan, simulate and stop. The default (ADR-0004). */
  broadcast: boolean;
  timeoutMs: number;
  balanceWei: bigint;
  maxFeePerGas?: bigint;
  rpcUrls: readonly string[];
};

export type FeePlan = {
  gas: string;
  maxFeePerGas: string;
  estimatedFeeWei: string;
  estimatedFeeEth: string;
};

/** `spec/04 §3`. */
export type BroadcastResult =
  | ({ status: "simulated"; broadcast: false } & FeePlan)
  | ({
      status: "mined";
      broadcast: true;
      txHash: Hex;
      blockNumber: string;
      gasUsed: string;
      effectiveGasPrice: string;
    } & FeePlan)
  | ({
      status: "reverted";
      broadcast: true;
      txHash: Hex;
      blockNumber: string;
      gasUsed: string;
    } & FeePlan)
  | ({ status: "unknown"; broadcast: true; txHash: Hex } & FeePlan);

export async function simulateAndMaybeBroadcast(
  params: BroadcastParams,
): Promise<KlerosResult<BroadcastResult>> {
  const { client, account, target, call, balanceWei } = params;

  /**
   * Built once and reused by all three calls. This is deliberate structure
   * rather than tidiness: `value` reaching the simulation and the estimate but
   * not the send is the failure `spec/04 §2` singles out, and there is no
   * copy here for it to be omitted from.
   */
  const request = {
    address: target.address,
    abi: target.abi,
    functionName: call.functionName,
    args: call.args as never,
    account,
    ...(params.value !== undefined ? { value: params.value } : {}),
  } as const;

  try {
    await client.simulateContract(request);
  } catch (cause) {
    const { reason, data, guidance } = decodeRevert(cause);
    return err("SIMULATION_REVERTED", `${guidance} Nothing was sent.`, {
      reason,
      data,
      broadcast: false,
    });
  }

  let gas: bigint;
  let maxFeePerGas: bigint;
  try {
    const [estimated, fees] = await Promise.all([
      /**
       * **The account is passed as a bare address here, and only here.**
       *
       * `request` carries a `PrivateKeyAccount`, and viem answers that by
       * running `prepareTransactionRequest` first, which populates the fee
       * fields. The node then applies its own
       * `gas * maxFeePerGas + value <= balance` precheck and **throws** — so
       * `checkBalance` below could never run, and an account that cannot pay
       * came back as `RPC_ERROR` (exit 2, "the chain or the RPC failed") when
       * the true answer is `INSUFFICIENT_BALANCE` (exit 1, "nothing was
       * sent"). A bare address is a JSON-RPC account to viem, so preparation
       * fills nothing: no fee fields, and the precheck collapses to
       * `value <= balance`,
       * which `checkValueAffordable` has already guaranteed on the paying
       * path. The estimate then returns a real number for an account with no
       * ETH at all, and the refusal below is reachable.
       *
       * **[live]** Measured on Arbitrum One, 2026-09-09, one zero-balance
       * address and one `eth_estimateGas`: as an `Account` object it fails
       * with `insufficient funds for transfer`; as a bare address it returns
       * `21345`. `value` still reaches the estimate — it is spread from
       * `request` and is what the reduced precheck weighs.
       */
      client.estimateContractGas({ ...request, account: account.address }),
      client.estimateFeesPerGas(),
    ]);
    gas = (estimated * GAS_BUFFER_NUMERATOR) / GAS_BUFFER_DENOMINATOR;
    maxFeePerGas = params.maxFeePerGas ?? fees.maxFeePerGas * MAX_FEE_MULTIPLIER;
  } catch (cause) {
    return rpcError("Failed to estimate gas or fees. Nothing was sent.", cause);
  }

  const estimatedFeeWei = gas * maxFeePerGas;
  const plan: FeePlan = {
    gas: gas.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    estimatedFeeWei: estimatedFeeWei.toString(),
    estimatedFeeEth: formatEther(estimatedFeeWei),
  };

  /**
   * **Change 3 of `spec/04 §2`.** `balance < fee` becomes `balance < fee + value`.
   * The arbitration cost is `msg.value` and leaves the account alongside the gas,
   * so the juror CLI's check would pass on an account that cannot pay and turn a
   * local refusal into a failed transaction. `checkBalance` in `cost.ts` owns the
   * arithmetic and the message.
   */
  const affordable = checkBalance({
    balanceWei,
    estimatedFeeWei,
    valueWei: params.value ?? 0n,
  });
  if (!affordable.success) {
    return err(affordable.code, affordable.message, {
      ...(affordable.details as Record<string, unknown>),
      ...plan,
    });
  }

  if (!params.broadcast) {
    return ok({ status: "simulated", broadcast: false, ...plan });
  }

  const wallet = createWalletClient({
    account,
    chain: arbitrum,
    // The first endpoint only. `fallback` retrying a *write* would risk a second
    // submission of a transaction the first endpoint may already have accepted,
    // and `spec/04 §5` rules out retries on this path outright.
    transport: http(params.rpcUrls[0]),
  });

  let txHash: Hex;
  try {
    txHash = await wallet.writeContract({
      ...request,
      gas,
      maxFeePerGas,
      // Tips are ignored on Arbitrum; zero states that plainly. Kept verbatim.
      maxPriorityFeePerGas: 0n,
      chain: arbitrum,
    });
  } catch (cause) {
    const { reason, data, guidance } = decodeRevert(cause);
    return err("BROADCAST_FAILED", `${guidance} The transaction was not accepted.`, {
      reason,
      data,
      broadcast: false,
    });
  }

  const receipt = await waitBounded(client, txHash, params.timeoutMs);

  if (receipt === "timeout") {
    /**
     * **A success, not a failure** (`spec/04 §3`). The tool stopped watching; the
     * transaction may still land. Retrying is the dangerous action here in a way
     * it is not in the juror CLI: a re-sent `castVote` is idempotent-ish, while a
     * re-sent `createDisputeForTemplate` pays the arbitration cost a second time
     * and creates a second dispute. The caller MUST exit 0 and say so in words;
     * nothing in this module ever retries, at any status.
     */
    return ok({ status: "unknown", broadcast: true, txHash, ...plan });
  }

  if (receipt.status === "reverted") {
    return ok({
      status: "reverted",
      broadcast: true,
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      ...plan,
    });
  }

  return ok({
    status: "mined",
    broadcast: true,
    txHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    ...plan,
  });
}

/**
 * `waitForTransactionReceipt` with an independent deadline on top of its own.
 * Kept verbatim, and subtle: there are open reports of it never settling when a
 * hash is never found, and of polling handles outliving a timeout, so it is
 * raced against an **`unref`'d** timer — which is what lets the process exit.
 *
 * `confirmations: 1` is required, not incidental: one confirmation is the right
 * notion of done on an L2 with immediate soft finality, and `onReplaced` does
 * not fire above 1.
 */
async function waitBounded(
  client: PublicClient,
  hash: Hex,
  timeoutMs: number,
): Promise<Awaited<ReturnType<PublicClient["waitForTransactionReceipt"]>> | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs + 5_000);
    timer.unref();
  });

  try {
    return await Promise.race([
      client
        .waitForTransactionReceipt({ hash, confirmations: 1, timeout: timeoutMs })
        .catch(() => "timeout" as const),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
