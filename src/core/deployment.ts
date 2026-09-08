import {
  deployments,
  getAddress as getDeployedAddress,
  mainnetViem,
} from "@kleros/kleros-v2-contracts/cjs/deployments";
import type { Address } from "viem";

/**
 * The deployed surface on Arbitrum One, **imported** from
 * `@kleros/kleros-v2-contracts` rather than hand-copied out of `spec/01 §1`
 * (ADR-0006).
 *
 * Three mechanical facts govern how it is reached (`spec/01 §1.1`):
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
 * These constants resolve at module load. A failure here is a load failure, not a
 * `KlerosResult` — it means the package stopped covering 42161, and that is a
 * broken build rather than a refusable operator input. `deployment.test.ts` is what
 * keeps the import honest: it pins the ABI entries and addresses this tool binds
 * to, so an upstream regeneration from `master` fails the build rather than a
 * transaction.
 */
const DEPLOYMENT = "mainnet" as const;

/** 42161, read from the deployment rather than written down. `spec/03 §7`. */
export const ARBITRUM_ONE_CHAIN_ID = deployments[DEPLOYMENT].chainId;

/** Read only: arbitration cost, court and kit configuration, dispute existence. */
export const KLEROS_CORE = {
  address: getDeployedAddress(mainnetViem.klerosCoreConfig, ARBITRUM_ONE_CHAIN_ID),
} as const satisfies { address: Address };

/**
 * The write target for dispute creation. An EOA **cannot** call
 * `KlerosCore.createDispute` — the deployed core enforces `arbitrableWhitelist`
 * unconditionally — so every dispute goes through this generic arbitrable.
 */
export const DISPUTE_RESOLVER = {
  address: getDeployedAddress(mainnetViem.disputeResolverConfig, ARBITRUM_ONE_CHAIN_ID),
} as const satisfies { address: Address };

/** The write target for evidence. Non-payable, no access control, no period gate. */
export const EVIDENCE_MODULE = {
  address: getDeployedAddress(mainnetViem.evidenceModuleConfig, ARBITRUM_ONE_CHAIN_ID),
} as const satisfies { address: Address };

/**
 * Written to indirectly, by `createDisputeForTemplate`. Held here only so startup
 * can assert `DisputeResolver.templateRegistry()` agrees with it rather than
 * assuming the registry entries are mutually consistent. `spec/01 §1`, `spec/03 §7`.
 */
export const DISPUTE_TEMPLATE_REGISTRY = {
  address: getDeployedAddress(mainnetViem.disputeTemplateRegistryConfig, ARBITRUM_ONE_CHAIN_ID),
} as const satisfies { address: Address };

export const KLEROS_CORE_ABI = mainnetViem.klerosCoreAbi;
export const DISPUTE_RESOLVER_ABI = mainnetViem.disputeResolverAbi;
export const EVIDENCE_MODULE_ABI = mainnetViem.evidenceModuleAbi;

/**
 * `DisputeResolverRuler`, the governance override tool.
 *
 * **There is no runtime refusal, and that is the decision.** `preflight.ts` used
 * to compare this against the resolved dispute kit, and a ruler can never be one:
 * KlerosCore's five registered kits are the NULL kit plus four `DisputeKit*`
 * contracts **[live]**, so the check could not fire. It was deleted rather than
 * relocated.
 *
 * **The pinned address is the control.** The write target is resolved from the
 * contracts package and its address is asserted in `deployment.test.ts`, which
 * also asserts that it is not this one. A ruler can therefore only become the
 * write target through an upstream change that fails the build first — a
 * build-time guarantee, which is stronger than a runtime check against a value
 * the same source supplied. `spec/01 §1`, `spec/appendix-a §4.5`.
 *
 * `KlerosCoreRuler` is deliberately absent: a developer tool for arbitrable
 * developers, with no bearing on this CLI.
 */
export const DISPUTE_RESOLVER_RULER = {
  address: getDeployedAddress(mainnetViem.disputeResolverRulerConfig, ARBITRUM_ONE_CHAIN_ID),
  name: "DisputeResolverRuler",
} as const satisfies { address: Address; name: string };
