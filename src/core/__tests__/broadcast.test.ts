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

type Recorded = { functionName: string; value?: bigint | undefined };

type FakeOptions = {
  simulate?: () => void;
  gas?: bigint;
  /**
   * `"timeout"` reproduces viem's own behaviour — it rejects once its `timeout`
   * elapses. `"hang"` never settles at all, which is the reported failure mode
   * `waitBounded`'s independent, unref'd deadline exists for.
   */
  receipt?: "timeout" | "hang" | { status: "success" | "reverted" };
};

function fakePublicClient(options: FakeOptions = {}) {
  const seen: Record<string, Recorded> = {};
  const record = (label: string, request: Recorded) => {
    seen[label] = { functionName: request.functionName, value: request.value };
  };

  const client = {
    async simulateContract(request: Recorded) {
      record("simulate", request);
      options.simulate?.();
      return { request };
    },
    async estimateContractGas(request: Recorded) {
      record("estimate", request);
      return options.gas ?? 700_000n;
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

  return { client: client as unknown as PublicClient, seen };
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
    const { client } = fakePublicClient();
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
    const { client } = fakePublicClient();
    const result = await simulateAndMaybeBroadcast(
      params({ client, call: SUBMIT, balanceWei: parseEther("0.001") }) as never,
    );
    expect(result.success).toBe(true);
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
