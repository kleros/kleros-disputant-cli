import { getAddress, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { contractsFor, packageChainId } from "../deployment.js";
import {
  DEFAULT_DEPLOYMENT,
  DEPLOYMENT_SLUGS,
  DEPLOYMENTS,
  type DeploymentSlug,
} from "../deployments.js";

/**
 * One table per deployment, and the shape assertions run against **every** served
 * deployment rather than the default one.
 *
 * That is the build-time half of "no path exists on one deployment only". The
 * suite is deliberately not a matrix — mechanics are identical by design, so
 * running network-driven tests twice would execute the same lines against
 * different constants — but these assertions are pure, offline and free, and
 * they are the ones that would catch a called fragment diverging.
 */
const resolved = Object.fromEntries(
  DEPLOYMENT_SLUGS.map((slug) => [slug, contractsFor(DEPLOYMENTS[slug])]),
) as Record<DeploymentSlug, ReturnType<typeof contractsFor>>;

/** The default deployment, for the assertions that are genuinely v2 Beta's. */
const contracts = resolved[DEFAULT_DEPLOYMENT.slug];

/**
 * The deployment fingerprint — `spec/05 §1.6`.
 *
 * `deployment.ts` imports its addresses and ABIs instead of pinning them
 * (ADR-0006), so this file is what makes that import safe rather than merely
 * convenient: an upstream regeneration from `master`, or a beta upgrade, fails the
 * build here rather than a paid transaction.
 *
 * Nothing in `src/` reads these literals. Do **not** "fix" a failure by updating
 * one — read `spec/01 §1` and `§7.1` first and work out what moved.
 */

type AbiParam = { readonly name?: string; readonly type: string };
type AbiEntry = {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
};

const CORE = contracts.klerosCore.abi as readonly AbiEntry[];

const coreOf = (slug: DeploymentSlug) => resolved[slug].klerosCore.abi as readonly AbiEntry[];
const resolverOf = (slug: DeploymentSlug) =>
  resolved[slug].disputeResolver.abi as readonly AbiEntry[];
const evidenceOf = (slug: DeploymentSlug) =>
  resolved[slug].evidenceModule.abi as readonly AbiEntry[];

/**
 * Output *names* and order are part of the assertion on purpose: `read-preflight.ts`
 * destructures these tuples positionally, so a reordered field would silently shift
 * a value rather than fail.
 */
const signature = (entry: AbiEntry): string =>
  `${entry.name}(${(entry.inputs ?? []).map((i) => i.type).join(",")}) -> (${(entry.outputs ?? [])
    .map((o) => (o.name ? `${o.type} ${o.name}` : o.type))
    .join(", ")})`;

const fns = (abi: readonly AbiEntry[], name: string): AbiEntry[] =>
  abi.filter((e) => e.type === "function" && e.name === name);

const fn = (abi: readonly AbiEntry[], name: string): AbiEntry => {
  const found = fns(abi, name);
  if (found.length === 0) throw new Error(`${name} absent from the deployed ABI`);
  if (found.length > 1) throw new Error(`${name} is overloaded; assert the overload explicitly`);
  return found[0] as AbiEntry;
};

describe.each(DEPLOYMENT_SLUGS)(
  "%s: the read surface still has the shape pre-flight destructures",
  (slug) => {
    it.each([
      "courts(uint256) -> (uint96 parent, bool hiddenVotes, uint256 minStake, uint256 alpha, uint256 feeForJuror, uint256 jurorsForCourtJump, bool disabled)",
      "disputes(uint256) -> (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)",
      "isSupported(uint96,uint256) -> (bool)",
      "disputeKits(uint256) -> (address)",
      "getDisputeKitsLength() -> (uint256)",
      "getTimesPerPeriod(uint96) -> (uint256[4] timesPerPeriod)",
      "version() -> (string)",
    ])("KlerosCore.%s", (expected) => {
      expect(signature(fn(coreOf(slug), expected.slice(0, expected.indexOf("("))))).toBe(expected);
    });
  },
);

/**
 * `arbitrationCost` is **overloaded**, and only one of the two is in scope. The
 * `(bytes,address)` form is the ERC-20 fee-token path, which ADR-0008 leaves
 * unresolved and which has no flag. viem picks an overload by argument count, so
 * calling with one argument is correct — but a future ABI that drops the one-arg
 * form would silently retarget the quote at the token path.
 */
describe.each(DEPLOYMENT_SLUGS)("%s: arbitrationCost overloads", (slug) => {
  it("still offers both, and the ETH form takes exactly one argument", () => {
    const overloads = fns(coreOf(slug), "arbitrationCost").map(signature).sort();
    expect(overloads).toEqual([
      "arbitrationCost(bytes) -> (uint256 cost)",
      "arbitrationCost(bytes,address) -> (uint256 cost)",
    ]);
  });
});

describe.each(DEPLOYMENT_SLUGS)(
  "%s: the write targets still have the shape this tool calls",
  (slug) => {
    const RESOLVER = resolverOf(slug);
    const EVIDENCE = evidenceOf(slug);

    it("createDisputeForTemplate is payable, with the selector 02 §5 pins", () => {
      const entry = fn(RESOLVER, "createDisputeForTemplate");
      expect(signature(entry)).toBe(
        "createDisputeForTemplate(bytes,string,string,uint256) -> (uint256 disputeID)",
      );
      expect(entry.stateMutability).toBe("payable");
      expect(toFunctionSelector("createDisputeForTemplate(bytes,string,string,uint256)")).toBe(
        "0xdc653511",
      );
    });

    it("submitEvidence is not payable, with the selector 02 §4 pins", () => {
      const entry = fn(EVIDENCE, "submitEvidence");
      expect(signature(entry)).toBe("submitEvidence(uint256,string) -> ()");
      expect(entry.stateMutability).toBe("nonpayable");
      expect(toFunctionSelector("submitEvidence(uint256,string)")).toBe("0xa6a7f0eb");
    });

    /**
     * The read that decides **which identifier is signed** (`spec/02 §4.2`), so its
     * shape belongs here rather than only in the read layer's own tests. It is a
     * public mapping getter: `view`, one `uint256` in, one `uint256` out, and it
     * returns the zero default rather than reverting for a key it has never seen.
     */
    it("arbitratorDisputeIDToLocalID is a view mapping getter", () => {
      const entry = fn(RESOLVER, "arbitratorDisputeIDToLocalID");
      expect(signature(entry)).toBe("arbitratorDisputeIDToLocalID(uint256) -> (uint256)");
      expect(entry.stateMutability).toBe("view");
    });

    it("DisputeRequest still has five arguments", () => {
      const event = RESOLVER.find((e) => e.type === "event" && e.name === "DisputeRequest");
      expect(event?.inputs).toHaveLength(5);
    });

    it("DisputeResolver declares no custom errors", () => {
      expect(RESOLVER.filter((e) => e.type === "error").map((e) => e.name)).toEqual([]);
    });
  },
);

/**
 * `spec/01 §7.1`. The devnet deployment removed the v1 `evidenceGroupID` inheritance
 * and renamed `submitEvidence`'s first parameter to `_arbitratorDisputeID` — **without
 * changing the signature**, so the selector above is identical on both shapes and
 * cannot see the change. The parameter name is the only ABI-level signal, and
 * `governor()` versus `owner()` corroborates it.
 *
 * A failure here does not mean the call broke. It means the *meaning* of the first
 * argument may have moved, and `02 §4.2` has to be re-read before shipping.
 */
describe.each(DEPLOYMENT_SLUGS)(
  "%s: EvidenceModule is still the served shape, not the devnet shape",
  (slug) => {
    const EVIDENCE = evidenceOf(slug);

    it("names the first parameter _externalDisputeID", () => {
      expect(fn(EVIDENCE, "submitEvidence").inputs?.[0]?.name).toBe("_externalDisputeID");
    });

    it("exposes governor(), not owner()", () => {
      const names = EVIDENCE.filter((e) => e.type === "function").map((e) => e.name);
      expect(names).toContain("governor");
      expect(names).not.toContain("owner");
    });

    it("emits Evidence with the topic0 the acceptance test matches on", () => {
      const event = EVIDENCE.find((e) => e.type === "event" && e.name === "Evidence");
      expect((event?.inputs ?? []).map((i) => i.type)).toEqual(["uint256", "address", "string"]);
      expect(toEventSelector("Evidence(uint256,address,string)")).toBe(
        "0x39935cf45244bc296a03d6aef1cf17779033ee27090ce9c68d432367ce106996",
      );
    });
  },
);

/**
 * The fingerprints from `spec/01 §2` that separate the deployment from `master`.
 * **v2 Beta's, and only its** — `ArbitrableNotWhitelisted` is one of the entries
 * the testnet does not have, which the block below measures rather than assumes.
 */
describe("deployed-versus-master fingerprints", () => {
  it.each([
    "ArbitrableNotWhitelisted",
    "ArbitrationFeesNotEnough",
    "DisputeKitNotSupportedByCourt",
  ])("KlerosCore still declares %s", (name) => {
    expect(CORE.some((e) => e.type === "error" && e.name === name)).toBe(true);
  });

  it("KlerosCore has no arbitrableWhitelistEnabled toggle", () => {
    // Its absence is why `01 §1` says an EOA can never call `createDispute` directly.
    expect(CORE.some((e) => e.name === "arbitrableWhitelistEnabled")).toBe(false);
  });
});

/**
 * **The measured difference between the two deployments' ABIs**, recorded so an
 * upstream regeneration breaks the build rather than a transaction.
 *
 * Read from the installed `@kleros/kleros-v2-contracts` **[abi]**, never from
 * chain. The claim this pins is the one the whole feature rests on: the
 * fragments this tool actually calls are identical on both deployments, and the
 * ones that differ are all fragments it never calls.
 *
 * **Accepted cost, and it is the only ongoing maintenance this feature adds:** a
 * testnet redeployment fails this block. That is intended — a redeployment
 * silently changes where transactions are sent — so a failure here is a question
 * about what moved, never a number to update.
 */
describe("the two deployments' ABIs, as measured", () => {
  const beta = resolved["arbitrum-one"];
  const testnet = resolved["arbitrum-sepolia-testnet"];

  it("shares DisputeResolver and EvidenceModule byte for byte", () => {
    expect(testnet.disputeResolver.abi).toEqual(beta.disputeResolver.abi);
    expect(testnet.evidenceModule.abi).toEqual(beta.evidenceModule.abi);
  });

  /**
   * Nine Beta-only entries and one testnet-only one. `initialize` appears on both
   * sides because its arity differs — twelve arguments on Beta, eleven on the
   * testnet — which is a constructor-time difference and not a call this tool
   * makes.
   */
  it("differs on KlerosCore in exactly the entries neither path calls", () => {
    const key = (e: AbiEntry) =>
      `${e.type}:${e.name ?? ""}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;
    const betaKeys = new Set(coreOf("arbitrum-one").map(key));
    const testnetKeys = new Set(coreOf("arbitrum-sepolia-testnet").map(key));

    expect([...betaKeys].filter((k) => !testnetKeys.has(k)).sort()).toEqual([
      "error:ArbitrableNotWhitelisted()",
      "error:NotEligibleForStaking()",
      "error:StakingMoreThanMaxStakePerJuror()",
      "error:StakingMoreThanMaxTotalStaked()",
      "function:arbitrableWhitelist(address)",
      "function:changeArbitrableWhitelist(address,bool)",
      "function:changeJurorNft(address)",
      "function:initialize(address,address,address,address,address,bool,uint256[4],uint256[4],bytes,address,address,address)",
      "function:jurorNft()",
    ]);
    expect([...testnetKeys].filter((k) => !betaKeys.has(k)).sort()).toEqual([
      "function:initialize(address,address,address,address,address,bool,uint256[4],uint256[4],bytes,address,address)",
    ]);
  });

  /**
   * **The whitelist is v2 Beta's, not the protocol's.** `CONTEXT.md` demotes it
   * from the justification for routing through `DisputeResolver` to how that
   * constraint was discovered, and this is the build-time half of that: on the
   * testnet the fragment does not exist, so a read that reached for it could not
   * even be encoded. Live corroboration is in `ADR-0015` — the selector reverts
   * bare there and returns `true` for the Beta resolver on Arbitrum One.
   */
  it("has no arbitrableWhitelist on the testnet at all", () => {
    expect(coreOf("arbitrum-one").some((e) => e.name === "arbitrableWhitelist")).toBe(true);
    expect(coreOf("arbitrum-sepolia-testnet").some((e) => e.name === "arbitrableWhitelist")).toBe(
      false,
    );
  });
});

describe("addresses have not moved", () => {
  /**
   * One row per contract per deployment. The testnet's are the second table
   * `spec/05 §1.6` calls for; they are read from the contracts package the same
   * way and pinned the same way, so neither deployment can move quietly.
   */
  it.each([
    [
      "arbitrum-one",
      "KlerosCore",
      contracts.klerosCore.address,
      "0x991d2df165670b9cac3B022f4B68D65b664222ea",
    ],
    [
      "arbitrum-one",
      "DisputeResolver",
      contracts.disputeResolver.address,
      "0xb5526D022962A1fFf6eD32C93e8b714c901F4323",
    ],
    [
      "arbitrum-one",
      "EvidenceModule",
      contracts.evidenceModule.address,
      "0x48e052B4A6dC4F30e90930F1CeaAFd83b3981EB3",
    ],
    [
      "arbitrum-one",
      "DisputeTemplateRegistry",
      contracts.disputeTemplateRegistry.address,
      "0x0cFBaCA5C72e7Ca5fFABE768E135654fB3F2a5A2",
    ],
    [
      "arbitrum-one",
      "DisputeResolverRuler",
      contracts.disputeResolverRuler?.address,
      "0xb3a5FdEAF461c42caCe148e978e6FBCa97bE6140",
    ],
    [
      "arbitrum-sepolia-testnet",
      "KlerosCore",
      resolved["arbitrum-sepolia-testnet"].klerosCore.address,
      "0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479",
    ],
    [
      "arbitrum-sepolia-testnet",
      "DisputeResolver",
      resolved["arbitrum-sepolia-testnet"].disputeResolver.address,
      "0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652",
    ],
    [
      "arbitrum-sepolia-testnet",
      "EvidenceModule",
      resolved["arbitrum-sepolia-testnet"].evidenceModule.address,
      "0xA88A9a25cE7f1d8b3941dA3b322Ba91D009E1397",
    ],
    [
      "arbitrum-sepolia-testnet",
      "DisputeTemplateRegistry",
      resolved["arbitrum-sepolia-testnet"].disputeTemplateRegistry.address,
      "0xe763d31Cb096B4bc7294012B78FC7F148324ebcb",
    ],
  ])("%s: %s", (_slug, _label, address, historical) => {
    expect(address).toBeDefined();
    expect(getAddress(address as string)).toBe(getAddress(historical));
  });

  /**
   * **The testnet's `DisputeResolver` config is chain-keyed and holds more than
   * one chain** — a Gnosis Chiado entry sits alongside 421614 — so resolving it
   * with the wrong chain ID returns the wrong *contract* rather than failing.
   * The package's `getAddress` only throws for a key it does not have.
   *
   * An earlier version of this asserted the testnet's resolver merely differs
   * from Beta's, which was **vacuous**: every row of the config differs from
   * Beta's, so resolving at Chiado passed it. This names the other row, so the
   * assertion fails for the reason it claims to.
   */
  it("resolves a chain-keyed address on its own deployment's chain, not a sibling row", () => {
    const CHIADO_RESOLVER = "0x5f79737f65320bA12440aA88087281cC8e71A781";
    expect(getAddress(resolved["arbitrum-sepolia-testnet"].disputeResolver.address)).not.toBe(
      getAddress(CHIADO_RESOLVER),
    );
    expect(getAddress(resolved["arbitrum-sepolia-testnet"].disputeResolver.address)).not.toBe(
      getAddress(contracts.disputeResolver.address),
    );
  });

  it("pins arbitrum-one to chain 42161", () => {
    expect(DEPLOYMENTS["arbitrum-one"].chainId).toBe(42161);
  });

  it("pins arbitrum-sepolia-testnet to chain 421614", () => {
    expect(DEPLOYMENTS["arbitrum-sepolia-testnet"].chainId).toBe(421614);
  });

  /**
   * **The slug table and the contracts package check each other.**
   *
   * `deployments.ts` writes each chain ID down because it deliberately imports
   * nothing from the package; the package records its own. Neither is the single
   * source of truth, and that is the point: a divergence — an upstream re-key, a
   * typo in the table — fails here rather than sending a transaction to an
   * endpoint the assertion then waves through.
   */
  it.each(DEPLOYMENT_SLUGS)("%s: the table's chain ID is the package's", (slug) => {
    const deployment = DEPLOYMENTS[slug];
    expect(packageChainId(deployment)).toBe(deployment.chainId);
  });

  /**
   * The formula, not a literal per deployment — matching `@kleros/agentkit`'s
   * `rpcEnvVarName`, so one exported variable serves both tools.
   */
  it.each(DEPLOYMENT_SLUGS)("%s: names its RPC override variable by formula", (slug) => {
    expect(DEPLOYMENTS[slug].rpcUrlVariable).toBe(
      `KLEROS_RPC_URL_${slug.toUpperCase().replace(/-/g, "_")}`,
    );
  });

  /**
   * The control that replaced the runtime ruler check. There is no pre-flight
   * refusal any more, so this assertion is the whole of the protection: a package
   * that ever resolved the write target to the governance override would fail the
   * build here, before anything could be signed against it.
   */
  it.each(DEPLOYMENT_SLUGS)(
    "%s: never resolves the write target to the governance override contract",
    (slug) => {
      const ruler = resolved[slug].disputeResolverRuler;
      // The testnet has no ruler in the contracts package, so there is nothing
      // to be confused with and the control is vacuous rather than enforced. It
      // returns by itself the day the package ships one — which is why this
      // skips the assertion instead of asserting the absence.
      if (ruler === undefined) return;
      expect(getAddress(resolved[slug].disputeResolver.address)).not.toBe(
        getAddress(ruler.address),
      );
    },
  );
});
