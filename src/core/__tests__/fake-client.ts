import type { PublicClient } from "viem";
import type { MulticallEntry, Outcome } from "../client.js";

/**
 * A stand-in for `PublicClient` holding only the methods `client.ts` and
 * `read-preflight.ts` actually call.
 *
 * There is no network anywhere in `pnpm test`, and there is no mocking library
 * either: the read layer's whole job is turning multicall outcomes into a facts
 * struct, so the thing worth controlling in a test is the outcome array. Each
 * hook receives the batch it was given, so a test can assert **which calls were
 * made** as well as what was returned — which is how `isSupported` being read on
 * every invocation is checked at all (`spec/01 §4.2`).
 */
export type FakeClientOptions = {
  chainId?: number | (() => number);
  timestamp?: bigint;
  multicall?: (contracts: readonly MulticallEntry[]) => Outcome[];
};

export type FakeClient = PublicClient & { calls: MulticallEntry[][] };

export const success = (result: unknown): Outcome => ({ status: "success", result });
export const failure = (error: unknown = new Error("execution reverted")): Outcome => ({
  status: "failure",
  error,
});

export function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls: MulticallEntry[][] = [];

  const client = {
    calls,
    async getChainId() {
      const { chainId = 42161 } = options;
      return typeof chainId === "function" ? chainId() : chainId;
    },
    async getBlock() {
      return { timestamp: options.timestamp ?? 1_757_000_000n };
    },
    async multicall({ contracts }: { contracts: readonly MulticallEntry[] }) {
      calls.push([...contracts]);
      if (!options.multicall) throw new Error("the test did not stub multicall");
      return options.multicall(contracts);
    },
  };

  return client as unknown as FakeClient;
}

/** The `functionName`s of one recorded batch, in the order they were sent. */
export function functionNames(batch: readonly MulticallEntry[] | undefined): string[] {
  return (batch ?? []).map((entry) => entry.functionName);
}
