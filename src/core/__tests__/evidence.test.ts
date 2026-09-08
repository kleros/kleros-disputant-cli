import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { buildEvidence, parseEvidenceDocument, serialiseEvidence } from "../evidence.js";
import { EVIDENCE_VECTORS } from "./vectors.js";

/** `spec/05 §1.3` and `§1.4`, over the vectors in `spec/02 §4.4`. */

const refusalOf = (input: unknown) => {
  const result = parseEvidenceDocument(input);
  if (result.success) throw new Error("expected a refusal, got a pass");
  return result;
};

describe("E1–E3 — the serialisation vectors", () => {
  it.each(EVIDENCE_VECTORS)("$name serialises to the vector's bytes and hash", (vector) => {
    const built = buildEvidence(vector.document);
    if (!built.success) throw new Error(`unexpected refusal: ${built.code} — ${built.message}`);
    expect(built.data.byteLength).toBe(vector.byteLength);
    expect(keccak256(toHex(built.data.json))).toBe(vector.keccak);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // E3 exists to catch two regressions at once: an escaping bug, and a length
    // check that counts JavaScript string length.
    const e3 = EVIDENCE_VECTORS[2];
    const built = buildEvidence(e3.document);
    if (!built.success) throw new Error("unexpected refusal");
    expect(built.data.byteLength).toBe(101);
    expect(built.data.json.length).toBe(e3.utf16Length);
    expect(built.data.byteLength).not.toBe(built.data.json.length);
  });

  it("is stable across runs and independent of input key order", () => {
    const forward = serialiseEvidence({ name: "n", description: "d", fileURI: "/ipfs/Qm" });
    const reversed = serialiseEvidence({ fileURI: "/ipfs/Qm", description: "d", name: "n" });
    expect(reversed).toBe(forward);
    expect(forward).toBe('{"name":"n","description":"d","fileURI":"/ipfs/Qm"}');
  });
});

describe("E4 — the refusal vectors", () => {
  it('refuses a document keyed "title" instead of "name"', () => {
    // A published Kleros documentation page says `title`; it is wrong, and a
    // title-keyed document indexes with a null name.
    const refusal = refusalOf({ title: "Delivery photographs", description: "…" });
    expect(refusal.code).toBe("EVIDENCE_INVALID");
    expect(refusal.message).toContain("name");
    expect(refusal.message).toContain("title");
  });

  it("refuses a bare URI in place of the document", () => {
    // It submits successfully, then parse-fails in the subgraph and indexes as
    // an unnamed blob.
    const refusal = refusalOf("/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc");
    expect(refusal.code).toBe("EVIDENCE_INVALID");
    expect(refusal.message).toContain("fileURI");
  });

  it.each([
    ["name missing", { description: "…" }],
    ["description missing", { name: "…" }],
    ["name empty", { name: "", description: "…" }],
    ["description empty", { name: "…", description: "" }],
    ["name blank", { name: "   ", description: "…" }],
    ["description blank", { name: "…", description: "\n\t " }],
  ])("refuses when the %s", (_label, document) => {
    expect(refusalOf(document).code).toBe("EVIDENCE_INVALID");
  });

  it("accepts an https fileURI", () => {
    // `fileURI` is an operator input and, unlike `policyURI`, is not held to a
    // multiaddr.
    const built = buildEvidence({
      name: "n",
      description: "d",
      fileURI: "https://example.org/a.pdf",
    });
    if (!built.success) throw new Error(`unexpected refusal: ${built.code}`);
    expect(built.data.document.fileURI).toBe("https://example.org/a.pdf");
  });

  it("refuses an unknown key", () => {
    expect(refusalOf({ name: "n", description: "d", sender: "0x0" }).code).toBe("EVIDENCE_INVALID");
  });

  it("refuses a document that is not an object", () => {
    expect(refusalOf(null).code).toBe("EVIDENCE_INVALID");
    expect(refusalOf([{ name: "n", description: "d" }]).code).toBe("EVIDENCE_INVALID");
    expect(refusalOf(42).code).toBe("EVIDENCE_INVALID");
  });
});

describe("the text is opaque", () => {
  // ADR-0007. This module JSON-encodes the operator's bytes and does nothing
  // else — no trimming, no normalisation, no interpretation.
  it("submits the description byte for byte", () => {
    const description = "  leading and trailing spaces, and a\ttab  ";
    const built = buildEvidence({ name: "n", description });
    if (!built.success) throw new Error("unexpected refusal");
    expect(built.data.document.description).toBe(description);
    expect(JSON.parse(built.data.json).description).toBe(description);
  });

  it("passes a URI through without dereferencing or rewriting it", () => {
    const fileURI = "ipfs://QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc";
    const built = buildEvidence({ name: "n", description: "d", fileURI });
    if (!built.success) throw new Error("unexpected refusal");
    expect(built.data.document.fileURI).toBe(fileURI);
  });
});
