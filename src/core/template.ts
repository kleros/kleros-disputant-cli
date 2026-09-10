import { z } from "incur";
import { isAddress } from "viem";
import { contractsFor } from "./deployment.js";
import type { Deployment } from "./deployments.js";
import { err, type KlerosResult, ok } from "./result.js";
import { describeZodIssues } from "./schema.js";

/**
 * The dispute template — `spec/02 §3`.
 *
 * The JSON document describing what jurors are being asked. It travels **inline**
 * in `_disputeTemplate`; it is never pinned, hashed to a URI or uploaded
 * (ADR-0009), and `_disputeTemplateDataMappings` is always `""`.
 *
 * The schema below is hand-written and **strict**: unknown keys are rejected,
 * not stripped (ADR-0010). The canonical `DisputeDetailsSchema` is a plain
 * `z.object`, so it silently drops a typo'd field name — appropriate for a
 * consumer, wrong for an author, because here the typo goes into an irreversible
 * paid transaction.
 */

/** `_disputeTemplateDataMappings` for a static template, which is every template this tool emits. */
export const NO_DATA_MAPPINGS = "";

/**
 * The canonical multiaddr refinement, transcribed verbatim from
 * `@kleros/kleros-sdk@2.4.0`'s `isMultiaddr`
 * (`lib/src/dataMappings/utils/disputeDetailsSchema.js`).
 *
 * Copied rather than approximated: this is the predicate the Kleros Court web
 * client applies, so a URI this accepts and Court rejects throws a `ZodError` on
 * read that the web client swallows into a generic invalid-data message naming
 * no field — with the money already spent.
 *
 * The two branches are **not** symmetrical, and the `ipfs://` one is the trap:
 * it takes exactly one alphanumeric path segment with at most one `.extension`,
 * so `ipfs://<cid>`, `ipfs://<cid>/docs/policy.json` and `ipfs://<cid>/my-policy.json`
 * all fail while `/ipfs/<cid>/docs/my-policy_v2.json` passes. That is the
 * canonical behaviour, not an oversight here (`spec/02 §3.4`).
 */
const MULTIADDR =
  /^\/(?:ip4|ip6|dns4|dns6|dnsaddr|tcp|udp|utp|tls|ws|wss|p2p-circuit|p2p-webrtc-star|p2p-webrtc-direct|p2p-websocket-star|onion|ipfs)(\/[^\s/]+)+$|^ipfs:\/\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)?$/;

/** Answer IDs as the canonical `AnswerSchema` constrains them. */
const HEX_ID = /^0x[0-9a-fA-F]+$/;

/** Permanently reserved for "Refuse to Arbitrate / Invalid". Never submitted. `spec/02 §3.3`. */
const RESERVED_ANSWER_ID = "0x0";

export type TemplateAnswer = {
  id: string;
  title: string;
  description: string;
  reserved?: boolean;
};

/**
 * Field order is load-bearing. This declaration order is the canonical schema's
 * own, and `serialiseTemplate` walks it — so the serialisation is reproducible
 * and a re-ordering regression is caught by vector T1 rather than by a reader
 * noticing. It is not canonical JSON and does not need to be; it needs to be the
 * same bytes every run (`spec/02 §3.5`).
 */
export type DisputeTemplate = {
  title: string;
  description: string;
  question: string;
  answers: TemplateAnswer[];
  policyURI: string;
  attachment?: { label: string; uri: string };
  frontendUrl?: string;
  metadata?: Record<string, unknown>;
  arbitratorChainID: string;
  arbitratorAddress: string;
  category?: string;
  lang?: string;
  specification?: string;
  aliases?: Record<string, string>;
  version: string;
};

/** A non-empty string. The canonical schema allows `""`; an author must not. */
const nonEmpty = z.string().min(1);

/**
 * `answers` and `policyURI` are typed here but **not** refined here: their
 * content failures carry `RULING_OPTIONS_INVALID` and `POLICY_URI_INVALID`
 * respectively (`spec/03 §5.5`), and folding them into the schema would flatten
 * both into `TEMPLATE_INVALID`.
 *
 * `extraEvidences` is deliberately absent, so a template carrying one is
 * refused. It **is** a field of the canonical schema (see the note in the
 * commit that added this file); this CLI does not author it, and an unknown
 * field is a refusal by design.
 */
const templateSchema = z.strictObject({
  title: nonEmpty,
  description: nonEmpty,
  question: nonEmpty,
  answers: z.array(
    z.strictObject({
      id: z.string(),
      title: nonEmpty,
      description: z.string(),
      reserved: z.boolean().optional(),
    }),
  ),
  policyURI: z.string(),
  attachment: z.strictObject({ label: nonEmpty, uri: nonEmpty }).optional(),
  frontendUrl: nonEmpty.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Optional here and required in `DisputeTemplate`: absent means "derive it
  // from `--chain`", so what this module *emits* always names an arbitrator
  // even though what it *accepts* need not. `resolveArbitrator` is the seam.
  arbitratorChainID: z.string().optional(),
  arbitratorAddress: z.string().optional(),
  category: nonEmpty.optional(),
  lang: nonEmpty.optional(),
  specification: nonEmpty.optional(),
  // Values are addresses or ENS names, as the canonical `AliasSchema` requires.
  // Checked here so this CLI cannot emit a template Court would reject.
  aliases: z
    .record(
      z.string(),
      z.string().refine((v) => isAddress(v, { strict: false }) || v.endsWith(".eth"), {
        message: "must be an address or an ENS name",
      }),
    )
    .optional(),
  version: nonEmpty,
});

/** Normalised, ready to serialise. */
export type TemplatePayload = {
  template: DisputeTemplate;
  /** The exact `_disputeTemplate` string. */
  json: string;
  /** UTF-8 bytes, never UTF-16 code units. */
  byteLength: number;
  /** `_numberOfRulingOptions`, derived from `answers` so the two cannot disagree. */
  numberOfRulingOptions: bigint;
};

/**
 * The two fields that name the deployment a dispute is filed on. Absent, they
 * are derived from it; present and wrong, they are refused and **never
 * rewritten**. `spec/02 §3.2` is normative and carries the reasoning — including
 * why a mismatch is refused rather than warned about, and what it actually costs.
 *
 * The one thing worth repeating where the mistake would be made: rewriting a
 * stated value would move the keccak vector `spec/02 §3.5` pins over the exact
 * serialised bytes, quite apart from being the substitution `extraData`
 * pre-flight exists to prevent.
 */
function resolveArbitrator(
  stated: { arbitratorChainID?: string | undefined; arbitratorAddress?: string | undefined },
  deployment: Deployment,
): KlerosResult<{ arbitratorChainID: string; arbitratorAddress: string }> {
  const expectedChainID = String(deployment.chainId);
  const arbitratorChainID = stated.arbitratorChainID ?? expectedChainID;
  if (arbitratorChainID !== expectedChainID) {
    return err(
      "TEMPLATE_INVALID",
      `arbitratorChainID is ${JSON.stringify(arbitratorChainID)}, but --chain ` +
        `${deployment.slug} is chain ${expectedChainID}. A template names the deployment its ` +
        "dispute is created on, and that registration is permanent. Delete the field and it is " +
        "derived from --chain. Nothing was sent.",
      { arbitratorChainID },
    );
  }

  // Checksum-insensitive on purpose: the canonical schema accepts a
  // non-checksummed address, and a stated one survives verbatim into the bytes.
  const expectedAddress = contractsFor(deployment).klerosCore.address;
  const arbitratorAddress = stated.arbitratorAddress ?? expectedAddress;
  if (!isAddress(arbitratorAddress, { strict: false })) {
    return err(
      "TEMPLATE_INVALID",
      `arbitratorAddress is not an address: ${JSON.stringify(arbitratorAddress)}. ` +
        "Nothing was sent.",
      { arbitratorAddress },
    );
  }
  if (arbitratorAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
    // The correct address is deliberately **not** in this message. The fix is to
    // delete the field, not to retype an address out of a terminal — which is
    // the reconstruction `docs/knowledge/never-expand-an-elided-address.md`
    // forbids, against a repo rule that addresses are imported (ADR-0006).
    return err(
      "TEMPLATE_INVALID",
      `arbitratorAddress is ${JSON.stringify(arbitratorAddress)}, which is not the arbitrator of ` +
        `--chain ${deployment.slug} (${deployment.name}). Kleros's published template examples ` +
        "carry an address that is not the deployed one, so a template copied from them fails " +
        "here. Delete the field and the right one is derived from --chain; do not retype it. " +
        "Nothing was sent.",
      { arbitratorAddress },
    );
  }

  return ok({ arbitratorChainID, arbitratorAddress });
}

/**
 * Validate and normalise an already-parsed document. Answer IDs are normalised
 * to `"0x" + BigInt(id).toString(16)`, so `0x01` and `0x1` are the same option —
 * which is why a collision between them is refused here rather than rendered as
 * two identical choices.
 */
export function parseTemplate(
  input: unknown,
  deployment: Deployment,
): KlerosResult<DisputeTemplate> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      "TEMPLATE_INVALID",
      "The dispute template must be a JSON object. Nothing was sent.",
      { received: input === null ? "null" : Array.isArray(input) ? "array" : typeof input },
    );
  }

  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      "TEMPLATE_INVALID",
      `The dispute template was rejected: ${describeZodIssues(parsed.error.issues)}. ` +
        "Nothing was sent.",
      { issue: describeZodIssues(parsed.error.issues) },
    );
  }
  const t = parsed.data;

  const arbitrator = resolveArbitrator(t, deployment);
  if (!arbitrator.success) return arbitrator;

  // `policyURI` is not checked by the contract: a dispute with a malformed one
  // is created successfully and jurors are still drawn, it merely renders
  // degraded in Court. Refused anyway, because that failure is invisible until
  // after the money is spent (`spec/02 §3.4`).
  if (!MULTIADDR.test(t.policyURI)) {
    return err(
      "POLICY_URI_INVALID",
      `policyURI must be a multiaddr such as /ipfs/Qm… or ipfs://Qm…/policy.json; got ` +
        `${JSON.stringify(t.policyURI)}. A plain https:// URL is rejected by the schema the ` +
        "Kleros Court web client applies. Nothing was sent.",
      { policyURI: t.policyURI },
    );
  }

  const answers = t.answers;
  if (answers.length < 2) {
    return err(
      "RULING_OPTIONS_INVALID",
      `A dispute needs at least two ruling options; the template offers ${answers.length}. ` +
        "Nothing was sent.",
      { numberOfRulingOptions: answers.length },
    );
  }

  const normalised: TemplateAnswer[] = [];
  const seen = new Set<string>();
  for (const [index, answer] of answers.entries()) {
    if (!HEX_ID.test(answer.id)) {
      return err(
        "RULING_OPTIONS_INVALID",
        `Ruling option ${index} has id ${JSON.stringify(answer.id)}; ids must match 0x followed ` +
          "by hex digits. Nothing was sent.",
        { index, id: answer.id },
      );
    }
    const id = `0x${BigInt(answer.id).toString(16)}`;
    if (id === RESERVED_ANSWER_ID) {
      return err(
        "RULING_OPTIONS_INVALID",
        `Ruling option ${index} is 0x0, which is permanently reserved for "Refuse to Arbitrate ` +
          '/ Invalid". Submitting it does not add an option: the Kleros Court web client ' +
          "overwrites that entry with the reserved answer, so the option you are paying to offer " +
          "disappears while the ruling-option count still includes it. Ids run from 0x1 upward. " +
          "Nothing was sent.",
        { index, id: answer.id },
      );
    }
    if (seen.has(id)) {
      return err(
        "RULING_OPTIONS_INVALID",
        `Ruling option ${index} repeats id ${id}; two options sharing an id render as one ` +
          "choice and the ruling would be ambiguous. Nothing was sent.",
        { index, id },
      );
    }
    seen.add(id);
    normalised.push({
      id,
      title: answer.title,
      description: answer.description,
      ...(answer.reserved !== undefined ? { reserved: answer.reserved } : {}),
    });
  }

  return ok({
    title: t.title,
    description: t.description,
    question: t.question,
    answers: normalised,
    policyURI: t.policyURI,
    ...(t.attachment !== undefined ? { attachment: t.attachment } : {}),
    ...(t.frontendUrl !== undefined ? { frontendUrl: t.frontendUrl } : {}),
    ...(t.metadata !== undefined ? { metadata: t.metadata } : {}),
    arbitratorChainID: arbitrator.data.arbitratorChainID,
    arbitratorAddress: arbitrator.data.arbitratorAddress,
    ...(t.category !== undefined ? { category: t.category } : {}),
    ...(t.lang !== undefined ? { lang: t.lang } : {}),
    ...(t.specification !== undefined ? { specification: t.specification } : {}),
    ...(t.aliases !== undefined ? { aliases: t.aliases } : {}),
    version: t.version,
  });
}

/**
 * `JSON.stringify` over an object literal in the field order above, with no
 * whitespace. Absent optional fields are omitted rather than emitted as `null`.
 */
export function serialiseTemplate(t: DisputeTemplate): string {
  return JSON.stringify({
    title: t.title,
    description: t.description,
    question: t.question,
    answers: t.answers.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      ...(a.reserved !== undefined ? { reserved: a.reserved } : {}),
    })),
    policyURI: t.policyURI,
    ...(t.attachment !== undefined
      ? { attachment: { label: t.attachment.label, uri: t.attachment.uri } }
      : {}),
    ...(t.frontendUrl !== undefined ? { frontendUrl: t.frontendUrl } : {}),
    ...(t.metadata !== undefined ? { metadata: t.metadata } : {}),
    arbitratorChainID: t.arbitratorChainID,
    arbitratorAddress: t.arbitratorAddress,
    ...(t.category !== undefined ? { category: t.category } : {}),
    ...(t.lang !== undefined ? { lang: t.lang } : {}),
    ...(t.specification !== undefined ? { specification: t.specification } : {}),
    ...(t.aliases !== undefined ? { aliases: t.aliases } : {}),
    version: t.version,
  });
}

/**
 * The whole template path: the text of `--template-file` in, the payload the
 * command sends out. The JSON parse failure is reported as `TEMPLATE_INVALID`
 * too — from the operator's side it is the same file being wrong.
 */
export function buildTemplate(
  source: string,
  deployment: Deployment,
): KlerosResult<TemplatePayload> {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch (cause) {
    return err(
      "TEMPLATE_INVALID",
      `The dispute template is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Nothing was sent.",
      {},
    );
  }

  const parsed = parseTemplate(document, deployment);
  if (!parsed.success) return parsed;

  const json = serialiseTemplate(parsed.data);
  return ok({
    template: parsed.data,
    json,
    byteLength: Buffer.byteLength(json, "utf8"),
    numberOfRulingOptions: BigInt(parsed.data.answers.length),
  });
}
