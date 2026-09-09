import {
  getAddress as getDeployedAddress,
  mainnetViem,
  deployments as packageDeployments,
  testnetViem,
} from "@kleros/kleros-v2-contracts/cjs/deployments";
import type { Deployment } from "./deployments.js";

/**
 * A deployment's addresses and ABIs, **imported** from
 * `@kleros/kleros-v2-contracts` rather than hand-copied out of `spec/01 §1`
 * (ADR-0006). Step 2 of `spec/03 §7`: local, offline, and never a network call.
 *
 * **This is a function of a deployment, not a set of module-level constants.**
 * It used to resolve one address set at module load, which hardwired the tool to
 * Arbitrum One in roughly forty places. `deployments.ts` owns the slug table and
 * decides *which* deployment; this module answers *what it is made of*. A
 * failure here is still a load-time failure rather than a `KlerosResult` — it
 * means the package stopped covering that deployment, which is a broken build
 * and not a refusable operator input.
 *
 * Three mechanical facts govern how the package is reached (`spec/01 §1.1`):
 *
 * - **Only `./cjs/deployments` can be imported.** The package root and
 *   `./esm/deployments` both throw `ReferenceError: exports is not defined in ES
 *   module scope` — the `esm/` tree is transpiled CommonJS shipped under an
 *   `esm/package.json` declaring `"type": "module"`, so Node parses it as ESM and
 *   it has no named exports to find. The root being unusable is a broken build
 *   upstream, not an undeclared export.
 * - **`mainnetViem` is a real export**, a namespace object holding `*Abi`,
 *   `*Address` and `*Config` for each contract. No local shim invents the name.
 * - **`*Address` and `Config.address` are chain-keyed maps, not addresses.**
 *   `policyRegistryAddress` has two keys. They go through the package's own
 *   `getAddress(config, chainId)`, aliased on import so it cannot be confused with
 *   viem's checksumming `getAddress`.
 *
 * `deployment.test.ts` is what keeps the import honest: it pins the ABI entries
 * and addresses this tool binds to, so an upstream regeneration from `master`
 * fails the build rather than a transaction.
 */

/**
 * The ABI namespace per deployment key. **The two namespaces are not
 * interchangeable** — the arbitrator's ABIs genuinely differ between deployments
 * — so they are bound per deployment rather than shared, and the fingerprint
 * test records the difference.
 *
 * Measured from the installed `@kleros/kleros-v2-contracts@2.0.0-rc.2` rather
 * than from chain **[abi]**: `disputeResolverAbi` and `evidenceModuleAbi` are
 * **byte-identical** across the two, and `klerosCoreAbi` is not — 126 entries on
 * `mainnet` against 118 on `testnet`. Nine are Beta-only (`arbitrableWhitelist`,
 * `changeArbitrableWhitelist`, `jurorNft`, `changeJurorNft`, four errors
 * including `ArbitrableNotWhitelisted`, and a twelve-argument `initialize`); one
 * is testnet-only, the same `initialize` with eleven.
 *
 * **No entry this tool calls is among them**, which is why the mechanics are
 * identical on both deployments rather than merely intended to be. Sharing one
 * namespace would still be wrong: `arbitrableWhitelist` is exactly the fragment
 * a future read would reach for, and on the testnet its selector reverts bare
 * **[live]** — a shared namespace would let that call be encoded and leave the
 * revert to explain itself.
 */
const ABIS = {
  mainnet: {
    klerosCore: mainnetViem.klerosCoreAbi,
    disputeResolver: mainnetViem.disputeResolverAbi,
    evidenceModule: mainnetViem.evidenceModuleAbi,
  },
  testnet: {
    klerosCore: testnetViem.klerosCoreAbi,
    disputeResolver: testnetViem.disputeResolverAbi,
    evidenceModule: testnetViem.evidenceModuleAbi,
  },
} as const;

/**
 * The `*Config` records, which is where the chain-keyed address maps live.
 *
 * **`disputeResolverRuler` is absent on the testnet**, and the absence is the
 * package's rather than an omission here: that deployment has no ruler at all,
 * so there is no address to pin and nothing for the write target to be confused
 * with. It is left `undefined` rather than filled in with Beta's, which would
 * name a contract that does not exist on the selected deployment — and
 * `deployment.test.ts` asserts the write target is not the ruler only where
 * there is one, so the guard returns by itself if the package ever adds it.
 */
const CONFIGS = {
  mainnet: {
    klerosCore: mainnetViem.klerosCoreConfig,
    disputeResolver: mainnetViem.disputeResolverConfig,
    evidenceModule: mainnetViem.evidenceModuleConfig,
    disputeTemplateRegistry: mainnetViem.disputeTemplateRegistryConfig,
    disputeResolverRuler: mainnetViem.disputeResolverRulerConfig,
  },
  testnet: {
    klerosCore: testnetViem.klerosCoreConfig,
    disputeResolver: testnetViem.disputeResolverConfig,
    evidenceModule: testnetViem.evidenceModuleConfig,
    disputeTemplateRegistry: testnetViem.disputeTemplateRegistryConfig,
    disputeResolverRuler: undefined,
  },
} as const;

/**
 * The chain ID the **contracts package** records for a deployment.
 *
 * Read here rather than in `deployments.ts`, which deliberately imports nothing
 * from the package. `deployment.test.ts` asserts the two agree, so the slug
 * table and the package check each other instead of one silently drifting.
 */
export function packageChainId(deployment: Deployment): number {
  return packageDeployments[deployment.packageKey].chainId;
}

export type DeploymentContracts = ReturnType<typeof resolveContracts>;

function resolveContracts(deployment: Deployment) {
  const abis = ABIS[deployment.packageKey];
  const configs = CONFIGS[deployment.packageKey];
  // `NonNullable`, because `disputeResolverRuler` is `undefined` on a deployment
  // that has no ruler. Narrowing here rather than widening `at` keeps the absence
  // a case the caller must handle instead of a lookup that returns nothing.
  const at = (config: NonNullable<(typeof configs)[keyof typeof configs]>) =>
    getDeployedAddress(config, deployment.chainId);

  return {
    deployment,

    /** Read only: arbitration cost, court and kit configuration, dispute existence. */
    klerosCore: { address: at(configs.klerosCore), abi: abis.klerosCore },

    /**
     * The write target for dispute creation. An EOA **cannot** call
     * `KlerosCore.createDispute` — the deployed core enforces
     * `arbitrableWhitelist` unconditionally on Arbitrum One — so every dispute
     * goes through this generic arbitrable. The whitelist is how that constraint
     * was discovered rather than what licenses the routing: it is a v2 Beta
     * property and is measurably absent elsewhere (`CONTEXT.md`, ADR-0015).
     */
    disputeResolver: { address: at(configs.disputeResolver), abi: abis.disputeResolver },

    /** The write target for evidence. Non-payable, no access control, no period gate. */
    evidenceModule: { address: at(configs.evidenceModule), abi: abis.evidenceModule },

    /**
     * Written to indirectly, by `createDisputeForTemplate`. Held here only so
     * startup can assert `DisputeResolver.templateRegistry()` agrees with it
     * rather than assuming the registry entries are mutually consistent.
     * `spec/01 §1`, `spec/03 §7`.
     */
    disputeTemplateRegistry: { address: at(configs.disputeTemplateRegistry) },

    /**
     * `DisputeResolverRuler`, the governance override tool.
     *
     * **There is no runtime refusal, and that is the decision.** `preflight.ts`
     * used to compare this against the resolved dispute kit, and a ruler can
     * never be one: KlerosCore's five registered kits are the NULL kit plus four
     * `DisputeKit*` contracts **[live]**, so the check could not fire. It was
     * deleted rather than relocated.
     *
     * **The pinned address is the control.** The write target is resolved from
     * the contracts package and its address is asserted in `deployment.test.ts`,
     * which also asserts that it is not this one. A ruler can therefore only
     * become the write target through an upstream change that fails the build
     * first — a build-time guarantee, which is stronger than a runtime check
     * against a value the same source supplied. `spec/01 §1`,
     * `spec/appendix-a §4.5`.
     *
     * `KlerosCoreRuler` is deliberately absent: a developer tool for arbitrable
     * developers, with no bearing on this CLI.
     *
     * **`undefined` where the deployment has no ruler.** The testnet has none in
     * the contracts package, so there is nothing to pin and nothing the write
     * target could be confused with. That is a weaker guarantee than Beta's, and
     * naming it here is the point: the control is vacuous rather than enforced,
     * and it comes back on its own if the package ever ships one.
     */
    disputeResolverRuler:
      configs.disputeResolverRuler === undefined
        ? undefined
        : { address: at(configs.disputeResolverRuler), name: "DisputeResolverRuler" },
  } as const;
}

/**
 * Memoised per slug. Resolution is pure and cheap, but every command layer would
 * otherwise call it several times per invocation and each call walks the
 * package's chain-keyed maps — and a single object makes an identity comparison
 * in a test mean what it looks like.
 *
 * **The slug is the key because a slug identifies a deployment** — every
 * `Deployment` comes from `DEPLOYMENTS`, and `resolveDeployment` is the only way
 * to get one. A hand-built record reusing a served slug with different fields
 * would read the cached contracts rather than its own; construct one only where
 * nothing resolves its addresses, as `client.test.ts` does.
 */
const CACHE = new Map<string, DeploymentContracts>();

export function contractsFor(deployment: Deployment): DeploymentContracts {
  const cached = CACHE.get(deployment.slug);
  if (cached !== undefined) return cached;

  const resolved = resolveContracts(deployment);
  CACHE.set(deployment.slug, resolved);
  return resolved;
}
