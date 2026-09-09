import type { Chain } from "viem";
import { arbitrum } from "viem/chains";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The deployments this tool serves, and the slugs that name them —
 * `ADR-0015`, `spec/03 §7` step 1.
 *
 * **A deployment is one address set of the Kleros v2 contracts**, not a chain: a
 * chain may host several, and chain 421614 hosts at least three. `--chain` keeps
 * `@kleros/agentkit`'s flag name so the agent calling both CLIs does not have to
 * translate at the boundary where a mistake spends money, and selects a
 * deployment anyway (`CONTEXT.md`, ADR-0015).
 *
 * **This module holds no dependency on the contracts package.** It is a closed
 * table of plain data, so resolving a slug is local, offline and total — which
 * is what lets an unserved slug be refused before a socket is opened. Reading
 * the deployment's addresses and ABIs is step 2 and lives in `deployment.ts`.
 *
 * The contracts package's own keys (`mainnet`, `testnet`) are an implementation
 * detail and are mapped **exactly once**, in `packageKey` below. The word
 * "mainnet" reaches no user-facing text: to an agent that also reads agentkit,
 * mainnet is Ethereum.
 */

/**
 * Every slug served, in the order `--help` should list them. Adding one here is
 * the whole of registering a deployment — the refusal message, the option
 * description and the fingerprint test all read this table rather than repeating
 * it.
 */
export const DEPLOYMENT_SLUGS = ["arbitrum-one"] as const;

export type DeploymentSlug = (typeof DEPLOYMENT_SLUGS)[number];

export type Deployment = {
  /** Canonical at every machine boundary: flag values, envelopes, CTAs, messages. */
  slug: DeploymentSlug;
  /** The prose name, for the one gloss in the `--chain` description. */
  name: string;
  /**
   * The contracts package's own deployment key. **Mapped here and nowhere
   * else** (ADR-0015); it is not a slug and never reaches output.
   */
  packageKey: "mainnet";
  /**
   * The chain ID `eth_chainId` MUST equal — `spec/03 §7` step 3.
   *
   * Written down rather than read from the contracts package, because this
   * module deliberately does not import it. That is not a second source of
   * truth: `deployment.test.ts` asserts this number against the package's own
   * `chainId` for `packageKey`, so the two check each other and a divergence
   * fails the build rather than a transaction.
   */
  chainId: number;
  /**
   * viem's own chain record, for fee defaults and encoding. **Not a check** —
   * a `chain:` field is a local claim, and `assertChain` is what verifies it
   * (`client.ts`).
   */
  chain: Chain;
  /**
   * Used when `--rpc-url` is absent. Rate-limited: an operator filing a real
   * dispute should point at their own. It is a default so a read command works
   * out of the box, not a recommendation.
   */
  defaultRpcUrl: string;
  /**
   * The name of this deployment's RPC override variable, **derived by formula
   * and never written twice**, matching agentkit's so one exported variable
   * serves both tools.
   *
   * The environment configures **transport, never target**: no environment
   * variable and no configuration file selects the deployment, only `--chain`
   * does. An ambient value that redirects where a transaction is sent is exactly
   * the invisible input this tool's posture exists to prevent.
   *
   * Nothing reads it yet — honouring it lands with the second deployment, which
   * is where a per-deployment endpoint first has a caller. It is derived here so
   * that when it is read, the name is not invented a second time.
   */
  rpcUrlVariable: string;
};

/** `arbitrum-one` → `KLEROS_RPC_URL_ARBITRUM_ONE`. The formula, applied once. */
function rpcUrlVariable(slug: DeploymentSlug): string {
  return `KLEROS_RPC_URL_${slug.toUpperCase().replace(/-/g, "_")}`;
}

export const DEPLOYMENTS: Readonly<Record<DeploymentSlug, Deployment>> = {
  "arbitrum-one": {
    slug: "arbitrum-one",
    name: "v2 Beta",
    packageKey: "mainnet",
    chainId: 42161,
    chain: arbitrum,
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcUrlVariable: rpcUrlVariable("arbitrum-one"),
  },
};

/**
 * **Load-bearing.** Every invocation written before `--chain` existed has to
 * keep meaning what it meant, so the option defaults rather than being required:
 * a required flag would silently invalidate every example, every CTA and every
 * command an agent has already learned (ADR-0015).
 */
export const DEFAULT_DEPLOYMENT_SLUG: DeploymentSlug = "arbitrum-one";

export const DEFAULT_DEPLOYMENT: Deployment = DEPLOYMENTS[DEFAULT_DEPLOYMENT_SLUG];

/**
 * The retired bare slug, **word for word as `@kleros/agentkit` refuses it**
 * (`src/types/chains.ts`, `ARBITRUM_SEPOLIA_RETIRED_GUIDANCE`).
 *
 * Copied rather than paraphrased on purpose: an agent that hit this correction
 * once in the read plane should meet the identical sentence in the write plane,
 * not a second phrasing it has to recognise as the same advice. agentkit is not
 * a dependency here — its `exports` map offers only `.` — so the sentence is
 * duplicated, and this comment is where that duplication is admitted.
 */
const ARBITRUM_SEPOLIA_RETIRED_GUIDANCE =
  'Chain "arbitrum-sepolia" is retired: two Kleros v2 deployments run on Arbitrum Sepolia, ' +
  "so the bare name no longer identifies one of them. " +
  'Use "arbitrum-sepolia-testnet" for the testnet deployment, ' +
  'or "arbitrum-sepolia-devnet" for the devnet deployment.';

/**
 * Slugs a caller could plausibly have learned from `@kleros/agentkit` and which
 * this tool does not serve. Each gets its own sentence, because "unknown slug"
 * would be a false diagnosis for a name that is real elsewhere.
 */
const UNSERVED: Record<string, string> = {
  "arbitrum-sepolia": ARBITRUM_SEPOLIA_RETIRED_GUIDANCE,
  // **The slug the retired-slug guidance above sends a caller to.** Without its
  // own sentence it falls through to "Unsupported chain", which is the wording a
  // typo gets — so an agent that follows this tool's own correction would land
  // on what reads like a second mistake, with nothing to say the name is real.
  // Delete this entry when the deployment is registered; `deployments.test.ts`
  // lists it among the refused slugs and will fail until that happens.
  "arbitrum-sepolia-testnet":
    'Chain "arbitrum-sepolia-testnet" is a real Kleros v2 deployment and is read by ' +
    "@kleros/agentkit, but this tool does not serve it: it has never signed against it, and the " +
    "slug is refused rather than registered until it has.",
  "arbitrum-sepolia-devnet":
    'Chain "arbitrum-sepolia-devnet" is read by @kleros/agentkit but is not served here: its ' +
    "write surface genuinely differs — submitEvidence does not take the same arguments — and " +
    "this tool has never signed against it, so serving it would be convenience without " +
    "verification.",
};

/**
 * Step 1 of `spec/03 §7`: the slug, resolved. Local, offline and total, so a
 * deployment this tool does not serve is refused **before any network contact**
 * — no round trip, no key read, no money at risk.
 *
 * `CHAIN_NOT_SUPPORTED` is deliberately not `WRONG_CHAIN`. That one means the
 * endpoint answered a chain ID we did not expect: a runtime condition found
 * mid-flight. This is an input condition. Collapsing them would tell a caller
 * who mistyped a slug to go and check their endpoint. The code is agentkit's
 * too, so one branch covers both tools.
 */
export function resolveDeployment(slug: string | undefined): KlerosResult<Deployment> {
  if (slug === undefined || slug === "") return ok(DEFAULT_DEPLOYMENT);

  // `Object.hasOwn`, never a bare index. The slug is operator input, and a plain
  // object answers `constructor`, `toString` and every other `Object.prototype`
  // key with something truthy — so a bare lookup would resolve `--chain
  // constructor` to a function, walk straight past this refusal and hand the
  // rest of the tool a "deployment" with no `chainId` and no addresses.
  if (Object.hasOwn(DEPLOYMENTS, slug)) return ok(DEPLOYMENTS[slug as DeploymentSlug]);

  const reason = Object.hasOwn(UNSERVED, slug)
    ? (UNSERVED[slug] as string)
    : `Unsupported chain: ${JSON.stringify(slug)}. Nothing was contacted.`;

  return err(
    "CHAIN_NOT_SUPPORTED",
    reason,
    // The served list is derived from the table, so registering a deployment
    // cannot leave this message naming a shorter set than the table holds.
    { chain: slug, hint: `This tool serves ${servedSlugs()}.` },
  );
}

/**
 * The served slugs as prose, with the default named. Used by the refusal and by
 * the `--chain` description, so the two cannot disagree about what is served.
 */
export function servedSlugs(): string {
  const list = DEPLOYMENT_SLUGS.join(", ");
  return DEPLOYMENT_SLUGS.length === 1
    ? `${list}, which is the default`
    : `${list}, and defaults to ${DEFAULT_DEPLOYMENT_SLUG}`;
}
