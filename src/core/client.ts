import type { Address, PublicClient } from "viem";
import { createPublicClient, fallback, getAddress, http } from "viem";
import { contractsFor, type DeploymentContracts } from "./deployment.js";
import type { Deployment } from "./deployments.js";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The RPC client and the startup checks — `spec/03 §7`.
 *
 * **Ordering here is a safety property, not style.** The invariant is **no
 * contract call before the chain assertion** (ADR-0015). Resolving a
 * deployment's addresses is a local act; *using* one on an unverified chain is
 * the hazard, so `eth_chainId` is the first network call and the first contract
 * call comes strictly after it.
 *
 * The assertion compares against **the selected deployment's own expected chain
 * ID**, never a constant. It cannot tell two deployments on one chain ID apart
 * and does not need to: an endpoint does not choose the contracts, the address
 * resolution does, so a mis-pointed endpoint can only be wrong about the chain
 * — which is exactly what this catches.
 *
 * Nothing in this module judges a request. It establishes that the tool is
 * talking to the chain the selected deployment lives on, and warns where that
 * deployment has moved underneath the specification.
 */

/**
 * The endpoints for one invocation, in precedence order: `--rpc-url`, then the
 * selected deployment's own override variable, then its default endpoint. Each
 * level may carry a comma-separated list, which `fallback` treats as failover.
 *
 * **The environment configures transport, never target** (`spec/03 §3.1`,
 * `deployments.ts`). The variable is named per deployment — agentkit's formula,
 * so one exported value serves both tools — and that is what makes the rule
 * enforceable rather than merely stated: there is no variable whose value
 * applies to whichever deployment happens to be selected, so setting one cannot
 * move a transaction from one deployment to another. It moves only *where the
 * chain it already named is reached*, and `assertChain` then checks that
 * endpoint answers with the expected chain ID.
 *
 * **`--rpc-url` outranks it**, which is the other half of the rule: the flag is
 * what the invocation said, and an ambient value must never overrule it. The
 * signing key is still refused from the environment entirely (`spec/03 §6`) —
 * that is a different question and this does not soften it.
 */
export function parseRpcUrls(value: string | undefined, deployment: Deployment): string[] {
  const fromFlag = splitUrls(value);
  if (fromFlag.length > 0) return fromFlag;

  const fromEnv = splitUrls(process.env[deployment.rpcUrlVariable]);
  if (fromEnv.length > 0) return fromEnv;

  return [deployment.defaultRpcUrl];
}

/** A comma-separated list, trimmed, with empty entries dropped. */
function splitUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * A read client over one or more endpoints for a deployment's chain.
 *
 * `fallback` retries the next endpoint on transport failure, which covers the
 * most likely stall: an endpoint that accepted a request and did not forward it
 * (`spec/04 §1`). It is **not** a substitute for the chain assertion below — a
 * fallback list pointed at the wrong network is still pointed at the wrong
 * network, and viem's `chain:` field is a local claim, not a check.
 */
export function createKlerosClient(
  rpcUrls: readonly string[],
  deployment: Deployment,
): PublicClient {
  const urls = rpcUrls.length > 0 ? rpcUrls : [deployment.defaultRpcUrl];
  return createPublicClient({
    chain: deployment.chain,
    transport: fallback(urls.map((url) => http(url))),
  });
}

/**
 * `spec/03 §7` step 3 — the **first network call**, and the last thing that runs
 * before any resolved address is used against an endpoint.
 */
export async function assertChain(
  client: PublicClient,
  deployment: Deployment,
): Promise<KlerosResult<number>> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (cause) {
    return rpcError("Could not read the chain ID from the configured RPC endpoint.", cause);
  }

  if (chainId !== deployment.chainId) {
    return err(
      "WRONG_CHAIN",
      `Connected to chain ${chainId}, but the ${deployment.slug} deployment lives on chain ` +
        `${deployment.chainId}. Every address this tool resolved for it is meaningless ` +
        "elsewhere, not merely wrong. Nothing was sent.",
      {
        chainId,
        expected: deployment.chainId,
        hint:
          `Point --rpc-url at an endpoint for chain ${deployment.chainId}, or select a ` +
          "different deployment with --chain.",
      },
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
  /** The deployment that was resolved, echoed by every envelope. */
  deployment: Deployment;
  /** The deployment's own contracts, resolved once and threaded on. */
  contracts: DeploymentContracts;
  /** The chain ID that was **asserted**, never the one that was expected. */
  chainId: number;
  /** Version mismatches. Never a failure — `spec/03 §7` step 5. */
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
 * `spec/03 §7` steps 4 and 5, in one round trip. **The first contract calls**,
 * and they run only after `assertChain` has passed.
 *
 * Step 4 is a **failure**: the specification's claim that the deployment is
 * internally consistent is what licenses writing to `DisputeResolver` while
 * quoting from `KlerosCore`, and if the two disagree then one of the two
 * registry entries is stale and the tool cannot tell which. It catches a stale
 * registry entry or an upstream redeployment — **not** a mis-pointed endpoint,
 * which `assertChain` already caught (ADR-0015). Step 5 is a **warning**: a
 * version bump moves revert encodings and cost behaviour that `spec/01`
 * describes, which is a reason to re-read it, not a reason to refuse.
 */
export async function checkDeployment(
  client: PublicClient,
  contracts: DeploymentContracts,
): Promise<KlerosResult<string[]>> {
  const { klerosCore, disputeResolver, evidenceModule, disputeTemplateRegistry } = contracts;

  let results: Outcome[];
  try {
    results = await multicall(client, [
      { ...disputeResolver, functionName: "arbitrator" },
      { ...disputeResolver, functionName: "templateRegistry" },
      { ...klerosCore, functionName: "version" },
      { ...evidenceModule, functionName: "version" },
    ]);
  } catch (cause) {
    return rpcError("Could not read the deployment's own view of itself.", cause);
  }

  const [arbitrator, registry, coreVersion, evidenceVersion] = results;

  if (arbitrator?.status !== "success" || registry?.status !== "success") {
    return err(
      "DEPLOYMENT_INCONSISTENT",
      `DisputeResolver at ${disputeResolver.address} did not answer arbitrator() or ` +
        "templateRegistry(). Either the address is not the contract this tool was built " +
        `against, or the endpoint is serving a chain other than ${contracts.deployment.slug}'s. ` +
        "Nothing was sent.",
      { disputeResolver: disputeResolver.address },
    );
  }

  const mismatch = firstAddressMismatch([
    ["arbitrator()", arbitrator.result, klerosCore.address, "KlerosCore"],
    ["templateRegistry()", registry.result, disputeTemplateRegistry.address, "the registry"],
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
 * `spec/03 §7` steps 2 through 5, in the order that section fixes: resolve the
 * deployment's contracts locally, assert the chain, then the deployment's own
 * view of itself, then versions. Step 1 — the slug — has already happened, in
 * `deployments.ts`, which is why nothing here can be handed a deployment this
 * tool does not serve. Command-specific pre-flight is step 6 and is the caller's
 * next move.
 *
 * `contractsFor` is called **before** the assertion and that is deliberate: it
 * opens no socket and reveals nothing, and the invariant is about contract
 * calls, not registry lookups (ADR-0015).
 */
export async function startup(
  client: PublicClient,
  deployment: Deployment,
): Promise<KlerosResult<StartupFacts>> {
  const contracts = contractsFor(deployment);

  const chain = await assertChain(client, deployment);
  if (!chain.success) return chain;

  const consistent = await checkDeployment(client, contracts);
  if (!consistent.success) return consistent;

  return ok({ deployment, contracts, chainId: chain.data, warnings: consistent.data });
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
