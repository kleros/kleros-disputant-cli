import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOYMENT,
  DEFAULT_DEPLOYMENT_SLUG,
  DEPLOYMENT_SLUGS,
  DEPLOYMENTS,
  resolveDeployment,
  servedSlugs,
} from "../deployments.js";

/**
 * The slug table — `spec/03 §7` step 1, `ADR-0015`.
 *
 * Everything here is pure and offline by construction: this module imports
 * neither the contracts package nor viem's transports, which is what lets an
 * unserved slug be refused before a socket exists. The **zero-round-trip**
 * property that refusal buys is asserted where it can actually be observed, in
 * `commands.test.ts`, against the in-process node.
 */

describe("the table", () => {
  it("is keyed by its own slugs, so a row cannot name a different deployment", () => {
    for (const slug of DEPLOYMENT_SLUGS) {
      expect(DEPLOYMENTS[slug].slug).toBe(slug);
    }
  });

  it("serves arbitrum-one and defaults to it", () => {
    expect(DEPLOYMENT_SLUGS).toContain("arbitrum-one");
    expect(DEFAULT_DEPLOYMENT_SLUG).toBe("arbitrum-one");
    expect(DEFAULT_DEPLOYMENT).toBe(DEPLOYMENTS["arbitrum-one"]);
  });

  /**
   * The contracts package's keys are an implementation detail (ADR-0015), and to
   * an agent that also reads `@kleros/agentkit`, "mainnet" names Ethereum. The
   * word may appear in `packageKey` and nowhere a caller can see.
   */
  it("keeps the package's own key out of every field a caller reads", () => {
    for (const slug of DEPLOYMENT_SLUGS) {
      const { slug: value, name, rpcUrlVariable, defaultRpcUrl } = DEPLOYMENTS[slug];
      for (const field of [value, name, rpcUrlVariable, defaultRpcUrl]) {
        expect(field.toLowerCase(), `${slug}: ${field}`).not.toContain("mainnet");
      }
    }
  });

  it("names each deployment in prose, for the one gloss in the --chain description", () => {
    expect(DEPLOYMENTS["arbitrum-one"].name).toBe("v2 Beta");
  });
});

describe("resolving a slug", () => {
  /**
   * **Load-bearing.** Every invocation written before `--chain` existed has to
   * keep meaning what it meant, so omitting it cannot be a refusal.
   */
  it("resolves to arbitrum-one when nothing was named", () => {
    expect(resolveDeployment(undefined)).toEqual({ success: true, data: DEFAULT_DEPLOYMENT });
    expect(resolveDeployment("")).toEqual({ success: true, data: DEFAULT_DEPLOYMENT });
  });

  it("resolves a served slug to its own row", () => {
    const result = resolveDeployment("arbitrum-one");
    expect(result).toEqual({ success: true, data: DEPLOYMENTS["arbitrum-one"] });
  });

  /**
   * `CHAIN_NOT_SUPPORTED`, never `WRONG_CHAIN`. That one means an endpoint
   * answered a chain ID the deployment did not expect — a runtime condition
   * found mid-flight. This is an input condition, and collapsing the two would
   * tell a caller who mistyped a slug to go and check their endpoint.
   */
  it.each([
    "arbitrum-sepolia",
    "arbitrum-sepolia-devnet",
    "arbitrum-sepolia-testnet",
    "ethereum",
    "ARBITRUM-ONE",
    "42161",
  ])("refuses %s with CHAIN_NOT_SUPPORTED and never WRONG_CHAIN", (slug) => {
    const result = resolveDeployment(slug);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("CHAIN_NOT_SUPPORTED");
  });

  /**
   * Word for word as `@kleros/agentkit` refuses it. An agent that met this
   * correction once in the read plane meets the identical sentence here, rather
   * than a second phrasing it has to recognise as the same advice.
   */
  it("names both replacements for the retired bare slug", () => {
    const result = resolveDeployment("arbitrum-sepolia");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toBe(
      'Chain "arbitrum-sepolia" is retired: two Kleros v2 deployments run on Arbitrum Sepolia, ' +
        "so the bare name no longer identifies one of them. " +
        'Use "arbitrum-sepolia-testnet" for the testnet deployment, ' +
        'or "arbitrum-sepolia-devnet" for the devnet deployment.',
    );
  });

  /**
   * The devnet is real, and reachable through the sibling read tool. Refusing it
   * as an unknown name would be a false diagnosis, so it says why instead.
   */
  it("says why the devnet is unsupported here even though the sibling CLI reads it", () => {
    const result = resolveDeployment("arbitrum-sepolia-devnet");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("@kleros/agentkit");
    expect(result.message).toContain("submitEvidence");
    expect(result.message).toContain("never signed against it");
  });

  /**
   * **The slug is operator input indexing an object literal.** A plain object
   * answers `constructor`, `toString` and every other `Object.prototype` key
   * with something truthy, so a bare lookup would resolve `--chain constructor`
   * to a function and walk past this refusal — handing the rest of the tool a
   * "deployment" with no chain ID and no addresses. Observed before the fix:
   * `--chain constructor` reached viem and threw out of the core as `UNKNOWN`.
   */
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "refuses the prototype key %s instead of resolving it to something truthy",
    (slug) => {
      const result = resolveDeployment(slug);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.code).toBe("CHAIN_NOT_SUPPORTED");
      expect(result.message).toContain(JSON.stringify(slug));
    },
  );

  /**
   * **The tool's own correction must not lead to a dead end.** The retired-slug
   * message tells the caller to use `arbitrum-sepolia-testnet`; without its own
   * sentence that slug falls through to the wording a typo gets, and an agent
   * following the advice has nothing to tell it the name is real but unserved.
   *
   * This assertion is also the tripwire for ticket 04: registering the
   * deployment makes it fail, which is where the `UNSERVED` entry gets deleted.
   */
  it("says the testnet slug is real but unserved, not that it is unrecognised", () => {
    const result = resolveDeployment("arbitrum-sepolia-testnet");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain("a real Kleros v2 deployment");
    expect(result.message).not.toContain("Unsupported chain");

    const retired = resolveDeployment("arbitrum-sepolia");
    expect(retired.success).toBe(false);
    if (retired.success) return;
    expect(retired.message).toContain("arbitrum-sepolia-testnet");
  });

  it("quotes an unknown slug back rather than guessing at what was meant", () => {
    const result = resolveDeployment("arbitrum-sepolio");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.message).toContain('"arbitrum-sepolio"');
  });

  /**
   * The hint is derived from the table, so registering a deployment cannot leave
   * a refusal naming a shorter set than the tool actually serves.
   */
  it.each(DEPLOYMENT_SLUGS)("names %s among the served slugs in every refusal", (slug) => {
    const result = resolveDeployment("nonsense");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(String((result.details as { hint: string }).hint)).toContain(slug);
    expect(servedSlugs()).toContain(slug);
  });
});
