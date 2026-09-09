import type { Address, PublicClient } from "viem";
import { createPublicClient, fallback, getAddress, http } from "viem";
import { arbitrum } from "viem/chains";
import {
  ARBITRUM_ONE_CHAIN_ID,
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  DISPUTE_TEMPLATE_REGISTRY,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
  KLEROS_CORE,
  KLEROS_CORE_ABI,
} from "./deployment.js";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The RPC client and the startup checks — `spec/03 §7`.
 *
 * **Ordering here is a safety property, not style.** Every address and ABI this
 * tool holds is specific to chain 42161, and a deployment registry lookup is
 * scoped to a deployment: trusting one on an unverified chain reads the wrong
 * core. So `eth_chainId` is asserted first, strictly before anything else
 * touches the deployment.
 *
 * Nothing in this module judges a request. It establishes that the tool is
 * talking to the chain it was built for, and warns where the deployment has
 * moved underneath the specification.
 */

/**
 * The public endpoint, used when `--rpc-url` is absent. It is rate-limited and
 * an operator filing a real dispute should point at their own; it is a default
 * so that a read command works out of the box, not a recommendation.
 */
export const DEFAULT_RPC_URL = "https://arb1.arbitrum.io/rpc";

/**
 * `--rpc-url` may carry a comma-separated list. There is deliberately **no
 * environment variable** for it: `spec/03 §3.1` fixes the option set, and the
 * one thing this CLI reads from outside the command line is the key file, whose
 * path is itself an option (`spec/03 §6`).
 */
export function parseRpcUrls(value: string | undefined): string[] {
  const urls = (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  return urls.length > 0 ? urls : [DEFAULT_RPC_URL];
}

/**
 * A read client over one or more Arbitrum One endpoints.
 *
 * `fallback` retries the next endpoint on transport failure, which covers the
 * most likely stall on this chain: an endpoint that accepted a request and did
 * not forward it (`spec/04 §1`). It is **not** a substitute for the chain
 * assertion below — a fallback list pointed at the wrong network is still
 * pointed at the wrong network, and viem's `chain:` field is a local claim, not
 * a check.
 */
export function createKlerosClient(rpcUrls: readonly string[] = [DEFAULT_RPC_URL]): PublicClient {
  const urls = rpcUrls.length > 0 ? rpcUrls : [DEFAULT_RPC_URL];
  return createPublicClient({
    chain: arbitrum,
    transport: fallback(urls.map((url) => http(url))),
  });
}

/** `spec/03 §7` step 1. Runs before any deployment registry lookup. */
export async function assertArbitrumOne(client: PublicClient): Promise<KlerosResult<number>> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (cause) {
    return rpcError("Could not read the chain ID from the configured RPC endpoint.", cause);
  }

  if (chainId !== ARBITRUM_ONE_CHAIN_ID) {
    return err(
      "WRONG_CHAIN",
      `Connected to chain ${chainId}, but this tool only operates on Arbitrum One ` +
        `(${ARBITRUM_ONE_CHAIN_ID}). Every address it holds is meaningless elsewhere, not ` +
        "merely wrong. Nothing was sent.",
      { chainId, expected: ARBITRUM_ONE_CHAIN_ID, hint: "Point --rpc-url at an Arbitrum One RPC." },
    );
  }

  return ok(chainId);
}

/**
 * The versions the specification was written against (`spec/01 §1`, **[live]**
 * on 2026-09-08). Hand-recorded because a version string is state, not ABI:
 * there is nothing in the contracts package to import it from and nothing the
 * fingerprint test can pin.
 *
 * `DisputeResolver` is absent on purpose — it declares no `version()` **[abi]**,
 * so there is nothing to compare and its absence is not a mismatch.
 */
export const EXPECTED_VERSIONS = {
  KlerosCore: "0.10.0",
  EvidenceModule: "0.8.0",
} as const;

export type StartupFacts = {
  chainId: number;
  /** Version mismatches. Never a failure — `spec/03 §7` step 4. */
  warnings: string[];
};

/**
 * viem cannot infer across a batch mixing several ABIs and argument arities, so
 * batches are typed loosely here and results are destructured positionally. That
 * is safe only because `deployment.test.ts` pins the output *names and order* of
 * every fragment read this way — a reordered tuple fails a test rather than
 * silently shifting a value.
 */
export type MulticallEntry = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export type Outcome =
  | { status: "success"; result: unknown }
  | { status: "failure"; error: unknown };

/**
 * `allowFailure: true`, so a **reverting** call comes back as one failed entry
 * while the batch succeeds. A transport problem throws instead and fails the
 * whole batch — which is what lets a caller read a single failed entry as "that
 * call reverted" rather than "the network was flaky".
 */
export async function multicall(
  client: PublicClient,
  contracts: readonly MulticallEntry[],
): Promise<Outcome[]> {
  const results = await client.multicall({
    allowFailure: true,
    contracts: contracts as Parameters<typeof client.multicall>[0]["contracts"],
  });
  return results as Outcome[];
}

/**
 * `spec/03 §7` steps 3 and 4, in one round trip.
 *
 * Step 3 is a **failure**: the specification's claim that the deployment is
 * internally consistent is what licenses writing to `DisputeResolver` while
 * quoting from `KlerosCore`, and if the two disagree then one of the two
 * registry entries is stale and the tool cannot tell which. Step 4 is a
 * **warning**: a version bump moves revert encodings and cost behaviour that
 * `spec/01` describes, which is a reason to re-read it, not a reason to refuse.
 */
export async function checkDeployment(client: PublicClient): Promise<KlerosResult<string[]>> {
  const resolver = { address: DISPUTE_RESOLVER.address, abi: DISPUTE_RESOLVER_ABI } as const;

  let results: Outcome[];
  try {
    results = await multicall(client, [
      { ...resolver, functionName: "arbitrator" },
      { ...resolver, functionName: "templateRegistry" },
      { address: KLEROS_CORE.address, abi: KLEROS_CORE_ABI, functionName: "version" },
      { address: EVIDENCE_MODULE.address, abi: EVIDENCE_MODULE_ABI, functionName: "version" },
    ]);
  } catch (cause) {
    return rpcError("Could not read the deployment's own view of itself.", cause);
  }

  const [arbitrator, registry, coreVersion, evidenceVersion] = results;

  if (arbitrator?.status !== "success" || registry?.status !== "success") {
    return err(
      "DEPLOYMENT_INCONSISTENT",
      `DisputeResolver at ${DISPUTE_RESOLVER.address} did not answer arbitrator() or ` +
        "templateRegistry(). Either the address is not the contract this tool was built " +
        "against, or the endpoint is serving a different chain's state. Nothing was sent.",
      { disputeResolver: DISPUTE_RESOLVER.address },
    );
  }

  const mismatch = firstAddressMismatch([
    ["arbitrator()", arbitrator.result, KLEROS_CORE.address, "KlerosCore"],
    ["templateRegistry()", registry.result, DISPUTE_TEMPLATE_REGISTRY.address, "the registry"],
  ]);
  if (mismatch) {
    return err(
      "DEPLOYMENT_INCONSISTENT",
      `DisputeResolver.${mismatch.call} returns ${mismatch.actual}, but this tool resolved ` +
        `${mismatch.label} to ${mismatch.expected}. A dispute created through it would be ` +
        "arbitrated by a contract this tool never quoted a fee from. Nothing was sent.",
      { call: mismatch.call, onChain: mismatch.actual, resolved: mismatch.expected },
    );
  }

  const warnings: string[] = [];
  for (const [name, outcome] of [
    ["KlerosCore", coreVersion],
    ["EvidenceModule", evidenceVersion],
  ] as const) {
    const expected = EXPECTED_VERSIONS[name];
    // An unreadable `version()` is treated as a mismatch rather than ignored:
    // both contracts declare one **[abi]**, so failing to read it already means
    // the deployed shape is not the one this tool was built against.
    const actual = outcome?.status === "success" ? String(outcome.result) : "unreadable";
    if (actual !== expected) {
      warnings.push(
        `${name} reports version ${actual}; this tool was verified against ${expected}. ` +
          "Costs, revert encodings and period behaviour may differ from what it reports.",
      );
    }
  }

  return ok(warnings);
}

/**
 * The whole of `spec/03 §7` in the order that section fixes: chain, then the
 * deployment's own view of itself, then versions. Command-specific pre-flight is
 * the caller's next step and never runs before this returns.
 */
export async function startup(client: PublicClient): Promise<KlerosResult<StartupFacts>> {
  const chain = await assertArbitrumOne(client);
  if (!chain.success) return chain;

  const deployment = await checkDeployment(client);
  if (!deployment.success) return deployment;

  return ok({ chainId: chain.data, warnings: deployment.data });
}

function firstAddressMismatch(
  checks: readonly (readonly [string, unknown, Address, string])[],
): { call: string; actual: string; expected: Address; label: string } | null {
  for (const [call, actual, expected, label] of checks) {
    const seen = typeof actual === "string" ? actual : String(actual);
    // Checksummed on both sides: the package returns a checksummed literal and
    // an RPC returns lowercase, so a raw string comparison always differs.
    if (!isSameAddress(seen, expected)) {
      return { call, actual: seen, expected, label };
    }
  }
  return null;
}

function isSameAddress(a: string, b: Address): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** The longest cause summary that still keeps the payload small (`spec/03 §5.1`). */
const CAUSE_LIMIT = 160;

/**
 * One line naming what the endpoint actually said.
 *
 * viem's errors are several paragraphs — the docs URL, the request body, the
 * version banner — and `spec/03 §5.1` requires the payload stay small, so this
 * takes the one part that distinguishes one `RPC_ERROR` from another. viem's
 * `BaseError` carries the node's own words in `details` and its own one-line
 * summary in `shortMessage`; anything else falls back to the first line.
 *
 * The signing key cannot reach here — `rpcError` is only ever handed a failure
 * from a read, an estimate or a send, none of which carry the key — but the cap
 * is a second reason nothing long enough to hide something gets through
 * (`spec/03 §6`).
 */
function summarizeCause(cause: unknown): string | undefined {
  const source = cause as { details?: unknown; shortMessage?: unknown } | null;
  const details = typeof source?.details === "string" ? source.details.trim() : "";
  const short = typeof source?.shortMessage === "string" ? source.shortMessage.trim() : "";

  /**
   * When the endpoint is not an RPC at all, viem puts the **response body** in
   * `details` — a whole HTML page for a URL pointed at a website by mistake.
   * Echoing a remote body back into our own payload is noise at best, so a
   * body-shaped `details` yields to viem's one-line summary.
   *
   * A JSON-RPC error object is body-shaped too, and that one is the opposite
   * case: it holds exactly the sentence this function exists to surface. So a
   * `{…}` body is parsed for its `message` before the fallback applies —
   * `JSON.parse` on a bounded string, never on anything acted upon.
   */
  const bodyShaped = /^["']?[<{[]/.test(details);
  const fromJson = bodyShaped ? jsonMessage(details) : undefined;
  const candidate =
    fromJson ??
    (details && !(bodyShaped && short)
      ? details
      : short || (cause instanceof Error ? cause.message : String(cause)));

  const line = candidate.split("\n").map((part) => part.trim())[0] ?? "";
  if (!line) return undefined;
  const redacted = redactUrls(line);
  return redacted.length > CAUSE_LIMIT ? `${redacted.slice(0, CAUSE_LIMIT - 1)}…` : redacted;
}

/** The `message` of a JSON-RPC error object, when `details` is one. */
function jsonMessage(details: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(details);
    const message = (parsed as { message?: unknown; error?: { message?: unknown } })?.message;
    const nested = (parsed as { error?: { message?: unknown } })?.error?.message;
    const found = typeof message === "string" ? message : nested;
    return typeof found === "string" && found.trim() ? found.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * **`--rpc-url` may carry an API key**, and this string is about to be
 * concatenated onto a `message` the caller prints and logs.
 *
 * viem keeps its own `URL:` line in `metaMessages`, which the first-line cut
 * already removes — but a non-viem rejection (DNS, undici) can name the
 * endpoint on its first line, and a paid endpoint's path *is* the credential.
 * The rule elsewhere in this tool is that a secret never reaches a payload
 * (`spec/03 §6`); an endpoint URL is close enough to one to get the same
 * treatment, and the host is not what makes the message useful.
 */
function redactUrls(line: string): string {
  return line.replace(/\bhttps?:\/\/\S+/gi, "<rpc-url>");
}

/**
 * **The cause travels in `hint`, which is the only key that renders.**
 *
 * `ADR-0013`: this used to attach the cause under `details.cause`,
 * and nothing reads that — not the default payload, not `--full-output`, not
 * `--format json`. incur's error envelope is closed to `{code, message}`
 * (`Cli.ts`'s `c.error` takes no `details`), and `spec/03 §5.4` deliberately
 * renders only `details.hint`, so there was no mode in which the cause reached
 * the caller. It was collected and dropped.
 *
 * That left `RPC_ERROR` — one code, exit 2 — meaning an endpoint that is down,
 * a rate limit, or an account that cannot pay, with nothing to tell them apart.
 * For a tool whose error contract is "branch on `code`", the one code that
 * needs a second sentence was the one that had none.
 *
 * `details.cause` is kept unsummarised and no test reads it: it exists for a
 * caller importing this module from `dist/index.js`, which sees the whole
 * `KlerosResult` rather than a rendered envelope. It reaches no CLI output.
 */
export function rpcError(message: string, cause: unknown): KlerosResult<never> {
  const summary = summarizeCause(cause);
  return err("RPC_ERROR", message, {
    cause: cause instanceof Error ? cause.message : String(cause),
    ...(summary ? { hint: `The endpoint said: ${summary}` } : {}),
  });
}
