import { z } from "incur";
import { err, type KlerosResult, ok } from "./result.js";
import { describeZodIssues } from "./schema.js";

/**
 * The evidence document — `spec/02 §4`.
 *
 * An inline JSON document passed to `EvidenceModule.submitEvidence`, emitted in
 * an event and never stored on chain. **Never a bare URI**: a `/ipfs/…` string
 * in place of the JSON parse-fails in the subgraph and indexes as an unnamed
 * blob.
 *
 * The text is **operator-supplied and opaque** (ADR-0007). This module
 * JSON-encodes it and does nothing else: it is never parsed for meaning, never
 * summarised, never interpolated into anything executable, and no URI it
 * mentions is ever dereferenced. Whitespace is not trimmed off the submitted
 * value either — a document is refused for being blank, but whatever is
 * submitted is submitted byte for byte.
 */

export type EvidenceDocument = {
  name: string;
  description: string;
  fileURI?: string;
  fileTypeExtension?: string;
};

/**
 * Exactly the four fields the contracts' `evidence-format.md` and the subgraph's
 * `EvidenceModule.ts` handler agree on. The subgraph ignores anything else, so
 * extra keys are harmless to a consumer — and are refused here anyway, because a
 * key this CLI does not recognise in a document it is about to send irreversibly
 * is a mistake to surface (`spec/02 §3.2`).
 *
 * `fileURI` is deliberately unconstrained beyond being a string: it is an
 * operator input, and unlike `policyURI` it is not held to a multiaddr.
 */
const evidenceSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  fileURI: z.string().min(1).optional(),
  fileTypeExtension: z.string().min(1).optional(),
});

export type EvidencePayload = {
  document: EvidenceDocument;
  /** The exact `_evidence` string. */
  json: string;
  /** UTF-8 bytes, never UTF-16 code units — `Réponse — 反論` is 101 bytes and 94 units. */
  byteLength: number;
};

/**
 * Validate an already-parsed document, whatever produced it — the `--name` /
 * `--description` flags or a file.
 */
export function parseEvidenceDocument(input: unknown): KlerosResult<EvidenceDocument> {
  // The single most likely shape mistake, and one the chain would accept: a
  // bare `/ipfs/…` string where the document belongs. It reaches the subgraph,
  // fails to parse there and indexes as an unnamed blob.
  if (typeof input === "string") {
    return err(
      "EVIDENCE_INVALID",
      "Evidence must be a JSON document with name and description, not a bare URI. A URI on its " +
        "own is submitted successfully and then indexes with no name and no body. Put the URI in " +
        "fileURI instead. Nothing was sent.",
      { received: "string" },
    );
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err("EVIDENCE_INVALID", "Evidence must be a JSON object. Nothing was sent.", {
      received: input === null ? "null" : Array.isArray(input) ? "array" : typeof input,
    });
  }

  // The published Kleros documentation page names this field `title`. It is
  // wrong, and a `title`-keyed document indexes with a null name — so the
  // generic "unknown field" message is replaced by one that names the trap.
  const keys = input as Record<string, unknown>;
  if (keys.title !== undefined && keys.name === undefined) {
    return err(
      "EVIDENCE_INVALID",
      'Evidence uses "title" where the field is "name". A published Kleros documentation page ' +
        "says title; it is wrong, and a title-keyed document indexes with a null name. " +
        "Nothing was sent.",
      { field: "title" },
    );
  }

  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      "EVIDENCE_INVALID",
      `The evidence document was rejected: ${describeZodIssues(parsed.error.issues)}. ` +
        "Nothing was sent.",
      { issue: describeZodIssues(parsed.error.issues) },
    );
  }

  const e = parsed.data;
  if (e.name.trim() === "" || e.description.trim() === "") {
    return err(
      "EVIDENCE_INVALID",
      "Evidence needs both a name and a description; a blank one submits successfully and is " +
        "unreadable afterwards. Nothing was sent.",
      { field: e.name.trim() === "" ? "name" : "description" },
    );
  }

  return ok({
    name: e.name,
    description: e.description,
    ...(e.fileURI !== undefined ? { fileURI: e.fileURI } : {}),
    ...(e.fileTypeExtension !== undefined ? { fileTypeExtension: e.fileTypeExtension } : {}),
  });
}

/**
 * `JSON.stringify` in the field order above, with no whitespace. Absent optional
 * fields are omitted rather than emitted as `null`.
 */
export function serialiseEvidence(e: EvidenceDocument): string {
  return JSON.stringify({
    name: e.name,
    description: e.description,
    ...(e.fileURI !== undefined ? { fileURI: e.fileURI } : {}),
    ...(e.fileTypeExtension !== undefined ? { fileTypeExtension: e.fileTypeExtension } : {}),
  });
}

/** The whole evidence path: fields in, the payload `submitEvidence` takes out. */
export function buildEvidence(input: unknown): KlerosResult<EvidencePayload> {
  const parsed = parseEvidenceDocument(input);
  if (!parsed.success) return parsed;

  const json = serialiseEvidence(parsed.data);
  return ok({
    document: parsed.data,
    json,
    byteLength: Buffer.byteLength(json, "utf8"),
  });
}
