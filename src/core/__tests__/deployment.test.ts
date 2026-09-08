import { getAddress, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARBITRUM_ONE_CHAIN_ID,
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  DISPUTE_RESOLVER_RULER,
  DISPUTE_TEMPLATE_REGISTRY,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
  KLEROS_CORE,
  KLEROS_CORE_ABI,
} from "../deployment.js";

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

const CORE = KLEROS_CORE_ABI as readonly AbiEntry[];
const RESOLVER = DISPUTE_RESOLVER_ABI as readonly AbiEntry[];
const EVIDENCE = EVIDENCE_MODULE_ABI as readonly AbiEntry[];

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

describe("the read surface still has the shape pre-flight destructures", () => {
  it.each([
    "courts(uint256) -> (uint96 parent, bool hiddenVotes, uint256 minStake, uint256 alpha, uint256 feeForJuror, uint256 jurorsForCourtJump, bool disabled)",
    "disputes(uint256) -> (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)",
    "isSupported(uint96,uint256) -> (bool)",
    "disputeKits(uint256) -> (address)",
    "getDisputeKitsLength() -> (uint256)",
    "getTimesPerPeriod(uint96) -> (uint256[4] timesPerPeriod)",
    "version() -> (string)",
  ])("KlerosCore.%s", (expected) => {
    expect(signature(fn(CORE, expected.slice(0, expected.indexOf("("))))).toBe(expected);
  });
});

/**
 * `arbitrationCost` is **overloaded**, and only one of the two is in scope. The
 * `(bytes,address)` form is the ERC-20 fee-token path, which ADR-0008 leaves
 * unresolved and which has no flag. viem picks an overload by argument count, so
 * calling with one argument is correct — but a future ABI that drops the one-arg
 * form would silently retarget the quote at the token path.
 */
describe("arbitrationCost overloads", () => {
  it("still offers both, and the ETH form takes exactly one argument", () => {
    const overloads = fns(CORE, "arbitrationCost").map(signature).sort();
    expect(overloads).toEqual([
      "arbitrationCost(bytes) -> (uint256 cost)",
      "arbitrationCost(bytes,address) -> (uint256 cost)",
    ]);
  });
});

describe("the write targets still have the shape this tool calls", () => {
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

  it("DisputeRequest still has five arguments", () => {
    const event = RESOLVER.find((e) => e.type === "event" && e.name === "DisputeRequest");
    expect(event?.inputs).toHaveLength(5);
  });

  it("DisputeResolver declares no custom errors", () => {
    expect(RESOLVER.filter((e) => e.type === "error").map((e) => e.name)).toEqual([]);
  });
});

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
describe("EvidenceModule is still the beta shape, not the devnet shape", () => {
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
});

/** The fingerprints from `spec/01 §2` that separate the deployment from `master`. */
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

describe("addresses have not moved", () => {
  it.each([
    ["KlerosCore", KLEROS_CORE.address, "0x991d2df165670b9cac3B022f4B68D65b664222ea"],
    ["DisputeResolver", DISPUTE_RESOLVER.address, "0xb5526D022962A1fFf6eD32C93e8b714c901F4323"],
    ["EvidenceModule", EVIDENCE_MODULE.address, "0x48e052B4A6dC4F30e90930F1CeaAFd83b3981EB3"],
    [
      "DisputeTemplateRegistry",
      DISPUTE_TEMPLATE_REGISTRY.address,
      "0x0cFBaCA5C72e7Ca5fFABE768E135654fB3F2a5A2",
    ],
    [
      "DisputeResolverRuler",
      DISPUTE_RESOLVER_RULER.address,
      "0xb3a5FdEAF461c42caCe148e978e6FBCa97bE6140",
    ],
  ])("%s", (_label, resolved, historical) => {
    expect(getAddress(resolved)).toBe(getAddress(historical));
  });

  it("resolves the chain ID from the deployment, not a literal", () => {
    expect(ARBITRUM_ONE_CHAIN_ID).toBe(42161);
  });

  /**
   * The control that replaced the runtime ruler check. There is no pre-flight
   * refusal any more, so this assertion is the whole of the protection: a package
   * that ever resolved the write target to the governance override would fail the
   * build here, before anything could be signed against it.
   */
  it("never resolves the write target to the governance override contract", () => {
    expect(getAddress(DISPUTE_RESOLVER.address)).not.toBe(
      getAddress(DISPUTE_RESOLVER_RULER.address),
    );
  });
});
