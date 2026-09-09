import type { Hex, PublicClient } from "viem";
import { BaseError, ContractFunctionRevertedError, parseEther, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { simulateAndMaybeBroadcast, type WriteCall } from "../broadcast.js";
import {
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
} from "../deployment.js";
import { type RpcServer, startRpcServer } from "./rpc-server.js";

/**
 * `spec/04` — the transaction path, and the three changes `§2` requires because
 * this tool's transactions carry money.
 *
 * The write half runs against a real signed transaction: `rpcUrls[0]` points at
 * an in-process JSON-RPC endpoint, and what it receives is decoded. That is the
 * only way to see `value` reaching `writeContract` — the one of the three call
 * sites where an omission survives every assertion made on inputs.
 */

/** A well-known Anvil test key. It has never held anything and never will. */
const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const ARBITRATION_COST = parseEther("0.015");

const CREATE: WriteCall = {
  functionName: "createDisputeForTemplate",
  args: [`0x${"00".repeat(96)}` as Hex, "{}", "[]", 2n],
};

const SUBMIT: WriteCall = { functionName: "submitEvidence", args: [216n, '{"name":"n"}'] };

type Recorded = {
  functionName: string;
  value?: bigint | undefined;
  account?: { address: string } | string | undefined;
};

type FakeOptions = {
  simulate?: () => void;
  gas?: bigint;
  /**
   * What the node believes the sender holds, for the precheck modelled in
   * `estimateContractGas` below. Defaults to "plenty". This is deliberately
   * **not** read from `params.balanceWei`: the point of the precheck is that
   * the node applies it whatever this tool thinks, so the fake has to hold its
   * own copy for a test to be able to disagree with it.
   */
  nodeBalanceWei?: bigint;
  /**
   * `"timeout"` reproduces viem's own behaviour — it rejects once its `timeout`
   * elapses. `"hang"` never settles at all, which is the reported failure mode
   * `waitBounded`'s independent, unref'd deadline exists for.
   */
  receipt?: "timeout" | "hang" | { status: "success" | "reverted" };
};

function fakePublicClient(options: FakeOptions = {}) {
  const seen: Record<string, Recorded> = {};
  /**
   * Which shape each call received its `account` in. The node's balance
   * precheck weighs `gas * maxFeePerGas + value` for an `Account` object and
   * `value` alone for a bare address, so this is the one input that decides
   * whether `estimateContractGas` throws (`spec/04 §2.1`).
   */
  const accounts: Record<string, "object" | "address"> = {};
  const record = (label: string, request: Recorded) => {
    seen[label] = { functionName: request.functionName, value: request.value };
    // Kept out of `seen` so the exact-equality assertions on it stay readable.
    accounts[label] = typeof request.account === "object" ? "object" : "address";
  };

  const client = {
    async simulateContract(request: Recorded) {
      record("simulate", request);
      options.simulate?.();
      return { request };
    },
    /**
     * **Models the node's balance precheck, which is the whole point of this
     * double.** The old fake resolved regardless of balance, so
     * `broadcast.test.ts` asserted `INSUFFICIENT_BALANCE` down a path a real
     * node makes unreachable, and passed. `spec/04 §2.1`.
     *
     * **[live]** Measured on Arbitrum One, 2026-09-09. `eth_estimateGas`
     * always prechecks, and always counts `value`; what the populated fee
     * fields add is the `gas * maxFeePerGas` term. So:
     *
     * - `account` as an object → viem fills the fee fields, and the node
     *   weighs `gas * maxFeePerGas + value`.
     * - `account` as a bare address → `prepareTransactionRequest` still runs
     *   but is scoped to fill nothing, so no fee fields reach the node and it
     *   weighs `value` alone.
     *
     * Verified against the same zero-balance address: the object form fails
     * with `insufficient funds for transfer`, the bare form returns a gas
     * figure. Production passes the bare form here for exactly that reason.
     */
    async estimateContractGas(request: Recorded) {
      record("estimate", request);
      const gas = options.gas ?? 700_000n;
      const balance = options.nodeBalanceWei ?? parseEther("1000");
      const feesPopulated = typeof request.account === "object";
      const required = (request.value ?? 0n) + (feesPopulated ? gas * 100_000_000n : 0n);
      if (balance < required) {
        // viem surfaces the node's message; the wording is the node's, kept
        // verbatim so a cause-sniffing fix would be tested against the truth.
        throw new Error(
          feesPopulated
            ? "insufficient funds for transfer"
            : "insufficient funds for gas * price + value",
        );
      }
      return gas;
    },
    async estimateFeesPerGas() {
      return { maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 0n };
    },
    async waitForTransactionReceipt({ timeout }: { timeout: number }) {
      const receipt = options.receipt ?? { status: "success" as const };
      // Never settles, and typed as such so the narrowing below survives.
      if (receipt === "hang") return await new Promise<never>(() => {});
      if (receipt === "timeout") {
        await new Promise((resolve) => setTimeout(resolve, timeout));
        throw new Error("timed out while waiting for transaction to be confirmed");
      }
      return {
        status: receipt.status,
        blockNumber: 503_066_782n,
        gasUsed: 698_736n,
        effectiveGasPrice: 10_000_000n,
      };
    },
  };

  return { client: client as unknown as PublicClient, seen, accounts };
}

let server: RpcServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const params = (over: Record<string, unknown> = {}) => ({
  account,
  target: { address: DISPUTE_RESOLVER.address, abi: DISPUTE_RESOLVER_ABI as never },
  call: CREATE,
  broadcast: false,
  timeoutMs: 1_000,
  balanceWei: parseEther("1"),
  rpcUrls: ["http://127.0.0.1:1"],
  ...over,
});

describe("the default is plan, simulate and stop", () => {
  it("returns status simulated and sends nothing", async () => {
    const { client } = fakePublicClient();
    const result = await simulateAndMaybeBroadcast(
      params({ client, value: ARBITRATION_COST }) as never,
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("simulated");
    expect(result.data.broadcast).toBe(false);
    // 700 000 × 150/100, and the fee cap is 3× the estimate.
    expect(result.data.gas).toBe("1050000");
    expect(result.data.maxFeePerGas).toBe("300000000");
  });

  it("honours an explicit fee cap over the estimate", async () => {
    const { client } = fakePublicClient();
    const result = await simulateAndMaybeBroadcast(params({ client, maxFeePerGas: 42n }) as never);
    expect(result.success && result.data.maxFeePerGas).toBe("42");
  });
});

/** **Change 2 of `spec/04 §2`.** */
describe("value reaches all three call sites", () => {
  it("threads it into the simulation and the estimate", async () => {
    const { client, seen } = fakePublicClient();
    await simulateAndMaybeBroadcast(params({ client, value: ARBITRATION_COST }) as never);

    expect(seen.simulate).toEqual({
      functionName: "createDisputeForTemplate",
      value: ARBITRATION_COST,
    });
    expect(seen.estimate).toEqual({
      functionName: "createDisputeForTemplate",
      value: ARBITRATION_COST,
    });
  });

  /**
   * The assertion that could not be made against a mock: the signed transaction
   * itself, decoded from what the node received.
   */
  it("signs a transaction carrying exactly that value, to the resolver", async () => {
    server = await startRpcServer();
    const { client } = fakePublicClient();

    const result = await simulateAndMaybeBroadcast(
      params({
        client,
        value: ARBITRATION_COST,
        broadcast: true,
        rpcUrls: [server.url],
      }) as never,
    );

    expect(result.success).toBe(true);
    expect(server.sent).toHaveLength(1);

    const tx = parseTransaction(server.sent[0] as Hex);
    expect(tx.value).toBe(ARBITRATION_COST);
    expect(tx.to?.toLowerCase()).toBe(DISPUTE_RESOLVER.address.toLowerCase());
    expect(tx.chainId).toBe(42161);
    expect(tx.gas).toBe(1_050_000n);
    // Tips are ignored on Arbitrum; zero states that plainly. RLP encodes zero
    // as empty bytes, so it comes back undefined — the two are the same wire
    // bytes, and either way no tip is paid.
    expect(tx.maxPriorityFeePerGas ?? 0n).toBe(0n);
  });

  /** `submitEvidence` is non-payable, so no value is attached at all. */
  it("attaches no value to an evidence submission", async () => {
    server = await startRpcServer();
    const { client, seen } = fakePublicClient();

    await simulateAndMaybeBroadcast(
      params({
        client,
        call: SUBMIT,
        target: { address: EVIDENCE_MODULE.address, abi: EVIDENCE_MODULE_ABI as never },
        broadcast: true,
        rpcUrls: [server.url],
      }) as never,
    );

    expect(seen.simulate?.value).toBeUndefined();
    const tx = parseTransaction(server.sent[0] as Hex);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.to?.toLowerCase()).toBe(EVIDENCE_MODULE.address.toLowerCase());
  });
});

/** **Change 3 of `spec/04 §2`.** */
describe("the balance check includes the value", () => {
  /**
   * The juror CLI's `balance < fee` would pass here: the gas alone is affordable
   * and the arbitration cost is not. Discovered locally, before anything is sent.
   */
  it("refuses an account that can pay the gas but not the fee", async () => {
    // The node is told the account is funded, because in production it never
    // sees this case: `checkValueAffordable` (`write.ts:115`) refuses
    // `balance < value` before `simulateAndMaybeBroadcast` is entered. What is
    // under test here is `broadcast.ts` alone, so the node is kept out of it.
    const { client } = fakePublicClient({ nodeBalanceWei: parseEther("1000") });
    const result = await simulateAndMaybeBroadcast(
      params({
        client,
        value: ARBITRATION_COST,
        // 1 050 000 × 300 000 000 wei of gas = 0.000315 ETH. Enough for gas alone.
        balanceWei: parseEther("0.001"),
      }) as never,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("0.015");
    expect(result.message).toContain("Nothing was sent");
  });

  it("lets the same account through when there is no value to send", async () => {
    const { client } = fakePublicClient({ nodeBalanceWei: parseEther("1000") });
    const result = await simulateAndMaybeBroadcast(
      params({ client, call: SUBMIT, balanceWei: parseEther("0.001") }) as never,
    );
    expect(result.success).toBe(true);
  });
});

/**
 * `spec/04 §2.1`. The refusal above was implemented, mapped to exit 1
 * and given a CTA — and could not fire, because the gas estimate reached the
 * node first and the node refuses an account that cannot pay. The caller got
 * `RPC_ERROR`, exit 2, "the chain or the RPC failed", for what is a local
 * refusal. The fake now models the precheck, so these tests fail against the
 * old code.
 */
describe("the balance refusal survives the node's own precheck", () => {
  it("names a zero-balance account rather than blaming the RPC", async () => {
    // The reported reproduction: `submit-evidence` from a fresh throwaway key.
    // Not payable, so `checkValueAffordable` upstream cannot catch it — the
    // whole shortfall is gas, and gas is only known after the estimate.
    const { client } = fakePublicClient({ nodeBalanceWei: 0n });
    const result = await simulateAndMaybeBroadcast(
      params({ client, call: SUBMIT, balanceWei: 0n }) as never,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.code).not.toBe("RPC_ERROR");
    expect(result.message).toContain("Nothing was sent");
  });

  it("refuses when the fee is covered and the gas on top is not", async () => {
    // The node agrees with the tool here: both weigh `value + gas * fee`. This
    // is the case `checkValueAffordable` cannot see, since `balance >= value`.
    const balanceWei = ARBITRATION_COST + 10n ** 13n;
    const { client } = fakePublicClient({ nodeBalanceWei: balanceWei });
    const result = await simulateAndMaybeBroadcast(
      params({ client, value: ARBITRATION_COST, balanceWei }) as never,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("estimated gas");
  });

  it("estimates gas with a bare address, which is what keeps the refusal reachable", async () => {
    const { client, accounts } = fakePublicClient({ nodeBalanceWei: 0n });
    await simulateAndMaybeBroadcast(params({ client, call: SUBMIT, balanceWei: 0n }) as never);

    // The mechanism, pinned: an `Account` object here makes viem populate the
    // fee fields, which is what arms the node's `gas * fee + value` precheck.
    expect(accounts.estimate).toBe("address");
    // The simulation still gets the full account — it is not the one that throws.
    expect(accounts.simulate).toBe("object");
  });
});

describe("a reverting simulation", () => {
  it("is refused by name, before anything is sent", async () => {
    const { client } = fakePublicClient({
      simulate: () => {
        throw new ContractFunctionRevertedError({
          abi: DISPUTE_RESOLVER_ABI as never,
          data: "0x38cd83c4",
          functionName: "createDisputeForTemplate",
        });
      },
    });

    const result = await simulateAndMaybeBroadcast(
      params({ client, value: ARBITRATION_COST, broadcast: true }) as never,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("SIMULATION_REVERTED");
    expect(result.message).toContain("less than arbitrationCost");
    expect(result.message).toContain("Nothing was sent");
    expect((result.details as { reason: string }).reason).toBe("ArbitrationFeesNotEnough");
  });

  it("stops before the fee estimate, so a refusal costs no further round trip", async () => {
    const { client, seen } = fakePublicClient({
      simulate: () => {
        throw new BaseError("reverted");
      },
    });
    await simulateAndMaybeBroadcast(params({ client, broadcast: true }) as never);
    expect(seen.estimate).toBeUndefined();
  });
});

describe("outcomes after broadcast", () => {
  it("reports a mined transaction with its receipt", async () => {
    server = await startRpcServer();
    const { client } = fakePublicClient();
    const result = await simulateAndMaybeBroadcast(
      params({ client, broadcast: true, rpcUrls: [server.url] }) as never,
    );

    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "mined") throw new Error("not mined");
    expect(result.data.broadcast).toBe(true);
    expect(result.data.blockNumber).toBe("503066782");
    expect(result.data.gasUsed).toBe("698736");
  });

  it("reports an on-chain revert as an outcome, not an error", async () => {
    server = await startRpcServer();
    const { client } = fakePublicClient({ receipt: { status: "reverted" } });
    const result = await simulateAndMaybeBroadcast(
      params({ client, broadcast: true, rpcUrls: [server.url] }) as never,
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.status).toBe("reverted");
  });

  /**
   * **`unknown` is a success, not a failure** (`spec/04 §3`). The tool stopped
   * watching; the transaction may still land, and retrying is the dangerous
   * action — a re-sent `createDisputeForTemplate` pays the arbitration cost a
   * second time and creates a second dispute.
   */
  it("returns unknown as a success carrying the hash, and never retries", async () => {
    server = await startRpcServer();
    const { client } = fakePublicClient({ receipt: "timeout" });
    const result = await simulateAndMaybeBroadcast(
      params({ client, broadcast: true, timeoutMs: 50, rpcUrls: [server.url] }) as never,
    );

    expect(result.success).toBe(true);
    if (!result.success || result.data.status !== "unknown") throw new Error("not unknown");
    expect(result.data.txHash).toBe(`0x${"11".repeat(32)}`);
    // One submission, and only one. `spec/04 §5` rules out retries outright.
    expect(server.sent).toHaveLength(1);
  });

  /**
   * `waitForTransactionReceipt` has open reports of never settling when a hash is
   * never found, which is why it is raced against an independent deadline rather
   * than trusted to honour its own. Without that race this test would hang for
   * ever instead of failing.
   */
  it("still returns unknown when the receipt wait never settles at all", async () => {
    server = await startRpcServer();
    const { client } = fakePublicClient({ receipt: "hang" });
    const result = await simulateAndMaybeBroadcast(
      params({ client, broadcast: true, timeoutMs: 100, rpcUrls: [server.url] }) as never,
    );

    expect(result.success && result.data.status).toBe("unknown");
  }, 15_000);

  it("names a node that refuses the signed transaction", async () => {
    server = await startRpcServer({ eth_sendRawTransaction: undefined });
    const { client } = fakePublicClient();
    const result = await simulateAndMaybeBroadcast(
      params({ client, broadcast: true, rpcUrls: [server.url] }) as never,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("BROADCAST_FAILED");
    expect(result.message).toContain("not accepted");
  });
});
