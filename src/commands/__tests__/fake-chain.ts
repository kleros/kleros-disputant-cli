import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Abi, AbiFunction, Address, Hex } from "viem";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbi,
  toFunctionSelector,
  toHex,
} from "viem";
import {
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  DISPUTE_TEMPLATE_REGISTRY,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
  KLEROS_CORE,
  KLEROS_CORE_ABI,
} from "../../core/deployment.js";

/**
 * An in-process Arbitrum One, answering from the **real ABIs**.
 *
 * `startRpcServer` in `src/core/__tests__` answers one canned value per JSON-RPC
 * method, which is enough to see a signed transaction but not enough to drive a
 * command: a single `create-dispute` issues four `eth_call`s that must return
 * four different shapes. So this decodes each call against the ABI the CLI
 * itself binds to and encodes the reply the same way.
 *
 * Binding to the real ABIs is the point. A hand-written hex reply would let a
 * test agree with a decoding mistake; here a change to the deployed shape breaks
 * the encode and the decode together, and `deployment.test.ts` is what keeps
 * those shapes honest in the first place.
 *
 * The seam is `--rpc-url`, which is the CLI's own. Nothing is injected and no
 * module is mocked, so what the commands do here is what they do against a node.
 */

/** Canonical across every chain viem ships, Arbitrum One included. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const AGGREGATE3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) returns (Result[])",
]);

/**
 * One entry per contract call the CLI may make, keyed by function name and
 * returning the value that function's ABI declares. Returning `REVERT` makes the
 * call fail the way the chain would — which is how court existence is probed at
 * all (`spec/01 §8`).
 */
export const REVERT = Symbol("revert");
export type Answer = (args: readonly unknown[]) => unknown | typeof REVERT;
export type Answers = Record<string, Answer>;

export type FakeChainOptions = {
  core?: Answers;
  resolver?: Answers;
  evidenceModule?: Answers;
  chainId?: number;
  balanceWei?: bigint;
  gas?: bigint;
  timestamp?: bigint;

  /**
   * What `eth_getTransactionReceipt` returns after a broadcast. `status: "0x0"`
   * is a mined revert; omitting it entirely makes the wait fail, which
   * `broadcast.ts` reports as `status: "unknown"` — a success the caller must
   * not retry (`spec/04 §3`), and one viem takes twelve seconds of retries to
   * reach, so it is asserted on the wording instead.
   */
  receipt?: Record<string, unknown>;
  /** Raise to see whether a caller re-reads something it should have cached, or vice versa. */
  onCall?: (contract: string, functionName: string) => void;
};

export type FakeChain = {
  url: string;
  /** Every JSON-RPC method received, in order. */
  methods: string[];
  /** Every contract call decoded, in order: `"KlerosCore.isSupported"`. */
  contractCalls: string[];
  /** Raw signed transactions handed to `eth_sendRawTransaction`. Empty means nothing was sent. */
  sent: Hex[];
  close: () => Promise<void>;
};

type Contract = { name: string; address: Address; functions: Map<Hex, AbiFunction> };

function indexAbi(name: string, address: Address, abi: Abi | readonly unknown[]): Contract {
  const functions = new Map<Hex, AbiFunction>();
  for (const item of abi as readonly AbiFunction[]) {
    if (item.type !== "function") continue;
    functions.set(toFunctionSelector(item), item);
  }
  return { name, address, functions };
}

export async function startFakeChain(options: FakeChainOptions = {}): Promise<FakeChain> {
  const methods: string[] = [];
  const contractCalls: string[] = [];
  const sent: Hex[] = [];

  const contracts: { contract: Contract; answers: Answers }[] = [
    {
      contract: indexAbi("KlerosCore", KLEROS_CORE.address, KLEROS_CORE_ABI),
      answers: options.core ?? {},
    },
    {
      contract: indexAbi("DisputeResolver", DISPUTE_RESOLVER.address, DISPUTE_RESOLVER_ABI),
      answers: options.resolver ?? {},
    },
    {
      contract: indexAbi("EvidenceModule", EVIDENCE_MODULE.address, EVIDENCE_MODULE_ABI),
      answers: options.evidenceModule ?? {},
    },
  ];

  /** One contract call: decode against the real ABI, answer, encode. */
  function call(to: Address, data: Hex): Hex | typeof REVERT {
    const entry = contracts.find((c) => c.contract.address.toLowerCase() === to.toLowerCase());
    if (!entry) return REVERT;

    const item = entry.contract.functions.get(data.slice(0, 10) as Hex);
    if (!item) return REVERT;

    contractCalls.push(`${entry.contract.name}.${item.name}`);
    options.onCall?.(entry.contract.name, item.name);

    const answer = entry.answers[item.name];
    if (!answer) return REVERT;

    const args = decodeAbiParameters(item.inputs, `0x${data.slice(10)}` as Hex);
    const result = answer(args);
    if (result === REVERT) return REVERT;

    return encodeAbiParameters(
      item.outputs,
      item.outputs.length === 1 ? [result] : (result as unknown[]),
    );
  }

  function ethCall(params: unknown[]): Hex {
    const { to, data } = params[0] as { to: Address; data: Hex };

    if (to.toLowerCase() === MULTICALL3.toLowerCase()) {
      const batch = decodeAbiParameters(AGGREGATE3[0].inputs, `0x${data.slice(10)}` as Hex)[0];
      const results = (batch as readonly { target: Address; callData: Hex }[]).map((entry) => {
        const returned = call(entry.target, entry.callData);
        return returned === REVERT
          ? { success: false, returnData: "0x" as Hex }
          : { success: true, returnData: returned };
      });
      return encodeAbiParameters(AGGREGATE3[0].outputs, [results]);
    }

    const returned = call(to, data);
    if (returned === REVERT) throw new Error("execution reverted");
    return returned;
  }

  const block = {
    number: toHex(300_000_000n),
    timestamp: toHex(options.timestamp ?? 1_757_000_000n),
    baseFeePerGas: toHex(10_000_000n),
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`,
    transactions: [],
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      const params = payload.params ?? [];
      methods.push(payload.method);

      let result: unknown;
      let error: string | undefined;
      try {
        switch (payload.method) {
          case "eth_chainId":
            result = toHex(options.chainId ?? 42161);
            break;
          case "eth_call":
            result = ethCall(params);
            break;
          case "eth_getBalance":
            result = toHex(options.balanceWei ?? 10n ** 18n);
            break;
          /**
           * **Models the node's balance precheck** — `spec/04 §2.1`.
           *
           * **[live]** Measured on Arbitrum One, 2026-09-09: `eth_estimateGas`
           * always weighs `value`, and adds a `gas * maxFeePerGas` term only
           * when the caller populated the fee fields. viem fills them for an
           * `Account` object and fills nothing for a bare address —
           * `prepareTransactionRequest` runs either way, but a bare address
           * scopes it to fill nothing — which is why `broadcast.ts` passes the
           * address there.
           *
           * Without this, an unfundable account got a gas figure from the fake
           * and `INSUFFICIENT_BALANCE` from the tool, while a real node threw
           * and produced `RPC_ERROR` instead. The tests read green against
           * behaviour the chain does not produce.
           */
          case "eth_estimateGas": {
            const gas = options.gas ?? 700_000n;
            const tx = (params[0] ?? {}) as { value?: Hex; maxFeePerGas?: Hex };
            const balance = options.balanceWei ?? 10n ** 18n;
            const value = tx.value ? BigInt(tx.value) : 0n;
            const feeTerm = tx.maxFeePerGas ? gas * BigInt(tx.maxFeePerGas) : 0n;
            if (balance < value + feeTerm) {
              // The node's own two wordings, which differ by whether the fee
              // fields were sent. Kept identical to `broadcast.test.ts`'s
              // double and to the table in `spec/04 §2.1`, so the two doubles
              // cannot drift into describing different nodes.
              error = tx.maxFeePerGas
                ? "insufficient funds for transfer"
                : "insufficient funds for gas * price + value";
              break;
            }
            result = toHex(gas);
            break;
          }
          case "eth_gasPrice":
            result = toHex(20_000_000n);
            break;
          case "eth_maxPriorityFeePerGas":
            result = toHex(0n);
            break;
          case "eth_blockNumber":
            result = block.number;
            break;
          case "eth_getBlockByNumber":
          case "eth_getBlockByHash":
            result = block;
            break;
          case "eth_getTransactionCount":
            result = toHex(0n);
            break;
          case "eth_getTransactionReceipt":
            if (!options.receipt) throw new Error("no receipt: the tool stopped watching");
            result = options.receipt;
            break;
          case "eth_sendRawTransaction":
            sent.push(params[0] as Hex);
            result = `0x${"11".repeat(32)}`;
            break;
          default:
            error = `unstubbed method ${payload.method}`;
        }
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          error === undefined
            ? { jsonrpc: "2.0", id: payload.id, result }
            : { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: error } },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    methods,
    contractCalls,
    sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A deployment that agrees with itself and reports the versions `spec/01 §1`
 * pins, so `spec/03 §7`'s startup checks pass and a test can be about something
 * else. Spread over it to make one of them disagree.
 */
export function healthyDeployment(): { core: Answers; resolver: Answers; evidenceModule: Answers } {
  return {
    core: { version: () => "0.10.0" },
    resolver: {
      arbitrator: () => KLEROS_CORE.address,
      templateRegistry: () => DISPUTE_TEMPLATE_REGISTRY.address,
    },
    evidenceModule: { version: () => "0.8.0" },
  };
}
