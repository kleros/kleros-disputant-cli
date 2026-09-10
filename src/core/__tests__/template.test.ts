import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { contractsFor } from "../deployment.js";
import { DEPLOYMENTS, type Deployment } from "../deployments.js";
import { buildTemplate, parseTemplate, serialiseTemplate } from "../template.js";
import {
  PUBLISHED_EXAMPLE_ARBITRATOR,
  TEMPLATE_T1,
  TEMPLATE_T1_BYTES,
  TEMPLATE_T1_KECCAK,
} from "./vectors.js";

/**
 * `spec/05 §1.3` and `§1.4`.
 *
 * The one direction this file does not assert is that the canonical
 * `DisputeDetailsSchema` accepts what is built here. `spec/02 §3.2` allows that
 * as a devDependency test; `@kleros/kleros-sdk` is not a dependency of this repo
 * at all yet (ADR-0010), so the assertion is deferred rather than quietly
 * assumed — and it would only ever assert one direction anyway.
 */

const t1 = () => structuredClone(TEMPLATE_T1) as Record<string, unknown>;

/**
 * T1 states Arbitrum One's own arbitrator, so it is deployment-consistent under
 * this default and the byte vector is unmoved by ticket 07.
 */
const BETA = DEPLOYMENTS["arbitrum-one"];
const TESTNET = DEPLOYMENTS["arbitrum-sepolia-testnet"];

const refusalOf = (input: unknown, deployment: Deployment = BETA) => {
  const result = parseTemplate(input, deployment);
  if (result.success) throw new Error("expected a refusal, got a pass");
  return result;
};

const passOf = (input: unknown, deployment: Deployment = BETA) => {
  const result = parseTemplate(input, deployment);
  if (!result.success) throw new Error(`unexpected refusal: ${result.code} — ${result.message}`);
  return result.data;
};

describe("T1 — the serialisation vector", () => {
  it("serialises to the vector's exact byte length and hash", () => {
    const json = serialiseTemplate(passOf(t1()));
    expect(Buffer.byteLength(json, "utf8")).toBe(TEMPLATE_T1_BYTES);
    expect(keccak256(toHex(json))).toBe(TEMPLATE_T1_KECCAK);
  });

  it("derives _numberOfRulingOptions from the answers array", () => {
    const built = buildTemplate(JSON.stringify(TEMPLATE_T1), BETA);
    if (!built.success) throw new Error(`unexpected refusal: ${built.code}`);
    expect(built.data.numberOfRulingOptions).toBe(2n);
    expect(built.data.numberOfRulingOptions).toBe(BigInt(built.data.template.answers.length));
    expect(built.data.byteLength).toBe(TEMPLATE_T1_BYTES);
  });

  it("is unaffected by the key order of the input document", () => {
    // The regression this vector exists to catch: an operator's file with the
    // fields in another order must produce the same bytes, because the field
    // order that matters is this module's, not the file's.
    const shuffled = Object.fromEntries(Object.entries(t1()).reverse());
    expect(serialiseTemplate(passOf(shuffled))).toBe(serialiseTemplate(passOf(t1())));
  });

  it("is stable across runs", () => {
    expect(serialiseTemplate(passOf(t1()))).toBe(serialiseTemplate(passOf(t1())));
  });

  it("carries no whitespace", () => {
    expect(serialiseTemplate(passOf(t1()))).not.toMatch(/\n|\s{2}/);
  });
});

describe("the strict authoring schema", () => {
  it.each(["title", "description", "question", "answers", "policyURI", "version"])(
    "rejects a document missing %s",
    (field) => {
      const document = t1();
      delete document[field];
      expect(refusalOf(document).code).toBe("TEMPLATE_INVALID");
    },
  );

  it("rejects an unknown key rather than stripping it", () => {
    // The canonical schema is a plain `z.object`: it strips silently. That is
    // right for a consumer and wrong for an author, because here the typo goes
    // into an irreversible paid transaction.
    const refusal = refusalOf({ ...t1(), tilte: "typo" });
    expect(refusal.code).toBe("TEMPLATE_INVALID");
    expect(refusal.message).toContain("tilte");
  });

  it("rejects extraEvidences, which this tool does not author", () => {
    // It *is* a field of the canonical `DisputeDetailsSchema` in
    // `@kleros/kleros-sdk@2.4.0`, contrary to `spec/02 §3.1`. Refused here as an
    // unknown field, which is the intended behaviour either way.
    expect(refusalOf({ ...t1(), extraEvidences: [] }).code).toBe("TEMPLATE_INVALID");
  });

  it("rejects arbitratorChainID as a number", () => {
    expect(refusalOf({ ...t1(), arbitratorChainID: 42161 }).code).toBe("TEMPLATE_INVALID");
  });

  it("rejects an arbitratorAddress that is not an address", () => {
    expect(refusalOf({ ...t1(), arbitratorAddress: "0x991d2d" }).code).toBe("TEMPLATE_INVALID");
  });

  it("rejects an empty required string", () => {
    expect(refusalOf({ ...t1(), question: "" }).code).toBe("TEMPLATE_INVALID");
  });

  it("rejects a document that is not an object", () => {
    expect(refusalOf("/ipfs/QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm").code).toBe(
      "TEMPLATE_INVALID",
    );
    expect(refusalOf([t1()]).code).toBe("TEMPLATE_INVALID");
    expect(refusalOf(null).code).toBe("TEMPLATE_INVALID");
  });

  it("reports malformed JSON as a template failure", () => {
    const built = buildTemplate("{not json", BETA);
    if (built.success) throw new Error("expected a refusal");
    expect(built.code).toBe("TEMPLATE_INVALID");
  });
});

describe("the arbitrator fields", () => {
  /**
   * `spec/02 §3.2`, which is normative and says what a mismatch costs and why it
   * is refused rather than warned about. What these tests pin is narrower: the
   * check has **no false positives**, so nothing here asserts a refusal for a
   * template that names its own deployment correctly, in any casing.
   */
  const coreOf = (deployment: Deployment) => contractsFor(deployment).klerosCore.address;

  const without = (...fields: string[]) => {
    const document = t1();
    for (const field of fields) delete document[field];
    return document;
  };

  it("derives both fields from the selected deployment when they are absent", () => {
    const derived = passOf(without("arbitratorChainID", "arbitratorAddress"));
    expect(derived.arbitratorChainID).toBe("42161");
    expect(derived.arbitratorAddress).toBe(coreOf(BETA));
  });

  it("derives the testnet's own arbitrator, not Beta's", () => {
    const derived = passOf(without("arbitratorChainID", "arbitratorAddress"), TESTNET);
    expect(derived.arbitratorChainID).toBe("421614");
    expect(derived.arbitratorAddress).toBe(coreOf(TESTNET));
    expect(derived.arbitratorAddress).not.toBe(coreOf(BETA));
  });

  it("derives each field independently of the other", () => {
    expect(passOf(without("arbitratorAddress")).arbitratorChainID).toBe("42161");
    expect(passOf(without("arbitratorChainID")).arbitratorAddress).toBe(
      TEMPLATE_T1.arbitratorAddress,
    );
  });

  it("serialises identically whether the fields are derived or stated", () => {
    // The derivation must be invisible in the bytes: an author who omits both
    // fields and one who states them correctly pay for the same template. Field
    // *position* is `serialiseTemplate`'s own and is pinned by T1's keccak; what
    // this adds is that the derived **values** are the ones a correct template
    // would have stated.
    expect(serialiseTemplate(passOf(without("arbitratorChainID", "arbitratorAddress")))).toBe(
      serialiseTemplate(passOf(t1())),
    );
  });

  it("refuses an arbitratorChainID that is not the deployment's", () => {
    const refusal = refusalOf({ ...t1(), arbitratorChainID: "1" });
    expect(refusal.code).toBe("TEMPLATE_INVALID");
    expect(refusal.message).toContain('"1"');
    expect(refusal.message).toContain("arbitrum-one");
  });

  it("refuses the arbitratorAddress the published examples carry", () => {
    const refusal = refusalOf({
      ...t1(),
      arbitratorAddress: PUBLISHED_EXAMPLE_ARBITRATOR,
    });
    expect(refusal.code).toBe("TEMPLATE_INVALID");
    expect(refusal.message).toContain(PUBLISHED_EXAMPLE_ARBITRATOR);
  });

  it("refuses a template carried across from another deployment", () => {
    // Ticket 04 is what turned this from a curiosity into a routine action.
    expect(refusalOf(t1(), TESTNET).code).toBe("TEMPLATE_INVALID");
  });

  it("never prints the address the caller would then paste back in", () => {
    // `docs/knowledge/never-expand-an-elided-address.md`: the fix is to delete
    // the field and let it be derived, never to retype an address from a message.
    const refusal = refusalOf({
      ...t1(),
      arbitratorAddress: PUBLISHED_EXAMPLE_ARBITRATOR,
    });
    expect(refusal.message.toLowerCase()).not.toContain(coreOf(BETA).toLowerCase());
  });

  it("compares checksum-insensitively and leaves a stated value verbatim", () => {
    // The canonical schema accepts a non-checksummed address, and `spec/02 §3.5`
    // pins keccak over the exact serialised bytes — so a present value is never
    // rewritten, not even into its own checksummed form.
    const lower = TEMPLATE_T1.arbitratorAddress.toLowerCase();
    expect(passOf({ ...t1(), arbitratorAddress: lower }).arbitratorAddress).toBe(lower);
    expect(serialiseTemplate(passOf({ ...t1(), arbitratorAddress: lower }))).not.toBe(
      serialiseTemplate(passOf(t1())),
    );
  });
});

describe("policyURI", () => {
  // Not checked by the contract: a dispute with a malformed one is created
  // successfully and jurors are still drawn. Refused anyway, because the failure
  // is invisible until after the money is spent (`spec/02 §3.4`).
  it("rejects a plain https URL", () => {
    const refusal = refusalOf({ ...t1(), policyURI: "https://kleros.io/policy.pdf" });
    expect(refusal.code).toBe("POLICY_URI_INVALID");
  });

  it.each([
    "/ipfs/QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm",
    "/ipfs/QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm/policy.json",
    "ipfs://QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm/policy.json",
  ])("accepts the multiaddr %s", (policyURI) => {
    expect(passOf({ ...t1(), policyURI }).policyURI).toBe(policyURI);
  });

  it.each([
    ["no path segment", "ipfs://QmXFrGGCpTGZq"],
    ["a second path segment", "ipfs://QmXFrGGCpTGZq/docs/policy.json"],
    ["a non-alphanumeric segment", "ipfs://QmXFrGGCpTGZq/my-policy.json"],
  ])("rejects an ipfs:// URI with %s, as the canonical refinement does", (_label, policyURI) => {
    // The branches are not symmetrical, and this is the asymmetry: every one of
    // these passes under the `/ipfs/…` form.
    expect(refusalOf({ ...t1(), policyURI }).code).toBe("POLICY_URI_INVALID");
  });

  it("accepts under /ipfs/ what it refuses under ipfs://", () => {
    const path = "QmXFrGGCpTGZq/docs/my-policy_v2.json";
    expect(passOf({ ...t1(), policyURI: `/ipfs/${path}` }).policyURI).toBe(`/ipfs/${path}`);
    expect(refusalOf({ ...t1(), policyURI: `ipfs://${path}` }).code).toBe("POLICY_URI_INVALID");
  });

  it("rejects an empty policyURI", () => {
    expect(refusalOf({ ...t1(), policyURI: "" }).code).toBe("POLICY_URI_INVALID");
  });
});

describe("ruling options", () => {
  const answers = (...ids: string[]) =>
    ids.map((id, i) => ({ id, title: `Option ${i}`, description: "" }));

  it("rejects fewer than two", () => {
    expect(refusalOf({ ...t1(), answers: answers("0x1") }).code).toBe("RULING_OPTIONS_INVALID");
    expect(refusalOf({ ...t1(), answers: [] }).code).toBe("RULING_OPTIONS_INVALID");
  });

  it("rejects the reserved 0x0 answer", () => {
    // `0x0` is permanently "Refuse to Arbitrate / Invalid". The SDK's
    // `populateTemplate` replaces a submitted `0x0` entry in place rather than
    // rejecting it, so nothing about the count ever looks wrong — the operator
    // simply loses the option they paid to offer (`spec/02 §3.3`).
    const refusal = refusalOf({ ...t1(), answers: answers("0x0", "0x1", "0x2") });
    expect(refusal.code).toBe("RULING_OPTIONS_INVALID");
    expect(refusalOf({ ...t1(), answers: answers("0x00", "0x1") }).code).toBe(
      "RULING_OPTIONS_INVALID",
    );
  });

  it("normalises ids to their shortest hex form", () => {
    const parsed = passOf({ ...t1(), answers: answers("0x01", "0x0A") });
    expect(parsed.answers.map((a) => a.id)).toEqual(["0x1", "0xa"]);
  });

  it("rejects two answers that normalise to the same id", () => {
    // `0x01` and `0x1` are one option, and a ruling naming it would be ambiguous.
    expect(refusalOf({ ...t1(), answers: answers("0x1", "0x01") }).code).toBe(
      "RULING_OPTIONS_INVALID",
    );
  });

  it("rejects an id that is not hex", () => {
    expect(refusalOf({ ...t1(), answers: answers("1", "2") }).code).toBe("RULING_OPTIONS_INVALID");
    expect(refusalOf({ ...t1(), answers: answers("0x", "0x1") }).code).toBe(
      "RULING_OPTIONS_INVALID",
    );
  });
});

describe("optional fields", () => {
  it("keeps an absent optional field out of the payload entirely", () => {
    expect(serialiseTemplate(passOf(t1()))).not.toContain("attachment");
  });

  it("serialises optional fields in the canonical declaration order", () => {
    const json = serialiseTemplate(
      passOf({
        ...t1(),
        lang: "en",
        category: "Escrow",
        attachment: {
          label: "Invoice",
          uri: "/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
        },
      }),
    );
    // attachment before arbitratorChainID; category and lang after it; version last.
    expect(json.indexOf('"attachment"')).toBeLessThan(json.indexOf('"arbitratorChainID"'));
    expect(json.indexOf('"arbitratorAddress"')).toBeLessThan(json.indexOf('"category"'));
    expect(json.indexOf('"category"')).toBeLessThan(json.indexOf('"lang"'));
    expect(json.indexOf('"lang"')).toBeLessThan(json.indexOf('"version"'));
  });

  it("rejects an alias that is neither an address nor an ENS name", () => {
    expect(refusalOf({ ...t1(), aliases: { Buyer: "the buyer" } }).code).toBe("TEMPLATE_INVALID");
  });

  it("accepts an alias that is an address", () => {
    const aliases = { Buyer: "0x991d2df165670b9cac3B022f4B68D65b664222ea" };
    expect(passOf({ ...t1(), aliases }).aliases).toEqual(aliases);
  });
});
