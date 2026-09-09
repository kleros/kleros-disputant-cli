import { readFileSync } from "node:fs";
import type { Abi, Hex } from "viem";
import { simulateAndMaybeBroadcast } from "../core/broadcast.js";
import { checkCostCeiling, checkValueAffordable } from "../core/cost.js";
import {
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
} from "../core/deployment.js";
import { buildEvidence } from "../core/evidence.js";
import { formatWeiAsEth, parseBigInt, parseEthToWei, parseGweiToWei } from "../core/numbers.js";
import {
  checkEffective,
  checkEvidenceAddressable,
  checkEvidencePreflight,
  checkPreflight,
} from "../core/preflight.js";
import {
  quoteArbitrationCost,
  readBalance,
  readCreateDisputeFacts,
  readCreatedDisputeID,
  readEffectiveDispute,
  readEvidenceFacts,
} from "../core/read-preflight.js";
import { err, type KlerosResult, ok } from "../core/result.js";
import { buildTemplate, NO_DATA_MAPPINGS } from "../core/template.js";
import { parseExtraDataOptions } from "./read.js";
import { type PrepareOptions, prepare, RECEIPT_TIMEOUT_MS } from "./shared.js";

/**
 * The two commands that sign — `spec/03 §2`, `spec/04`.
 *
 * The default on both is plan → simulate → stop. **Nothing is broadcast without
 * `--broadcast`**: there is no human confirmation gate here and nothing upstream
 * provides one, so the flag is the confirmation (ADR-0004).
 *
 * The two are deliberately asymmetric. Creating a dispute spends money and
 * cannot be undone, so its pre-flight is elaborate and every refusal is local —
 * `simulateContract` catches none of the ways `extraData` goes wrong
 * (`spec/01 §4.4`). Submitting evidence costs gas only and can be repeated, so
 * its pre-flight is nearly empty and warns rather than refuses (ADR-0011).
 */

export type CreateDisputeOptions = PrepareOptions & {
  court: string;
  jurors: string;
  kit: string;
  templateFile: string;
  maxCostEth: string;
  broadcast: boolean;
  maxFeeGwei?: string | undefined;
};

export async function runCreateDispute(
  options: CreateDisputeOptions,
): Promise<KlerosResult<Record<string, unknown>>> {
  // Everything local first, so a typo costs no round trip and reveals nothing
  // about an intent to send.
  const requested = parseExtraDataOptions(options);
  if (!requested.success) return requested;
  const { courtID, jurors, disputeKitID } = requested.data;

  const ceilingWei = parseEthToWei(options.maxCostEth, "--max-cost-eth");
  if (!ceilingWei.success) return ceilingWei;

  const maxFeePerGas = options.maxFeeGwei
    ? parseGweiToWei(options.maxFeeGwei, "--max-fee-gwei")
    : ok(undefined);
  if (!maxFeePerGas.success) return maxFeePerGas;

  const source = readTextFile(options.templateFile);
  if (source === null) {
    return err(
      "TEMPLATE_INVALID",
      `Could not read the dispute template from ${options.templateFile}. Nothing was sent.`,
      { hint: "--template-file takes a path to a JSON file, not the template itself." },
    );
  }

  // `_numberOfRulingOptions` is derived from the template's own `answers` array
  // and is not an option, so the two cannot disagree (`spec/02 §1.1`).
  const template = buildTemplate(source);
  if (!template.success) return template;

  const prepared = await prepare({ ...options, requireSigner: true });
  if (!prepared.success) return prepared;
  const { client, account } = prepared.data;

  const facts = await readCreateDisputeFacts({ client, courtID, disputeKitID });
  if (!facts.success) return facts;

  // The only thing standing between a typo and a paid dispute in the wrong
  // court. Every one of its refusal vectors quotes 0.015 ETH and simulates
  // cleanly (`spec/02 §1.3` X5).
  const preflight = checkPreflight({
    requested: { ...requested.data, numberOfRulingOptions: template.data.numberOfRulingOptions },
    chain: facts.data,
  });
  if (!preflight.success) return preflight;
  const { extraData, numberOfRulingOptions } = preflight.data;

  // After pre-flight passes and before simulating, with the byte-identical blob
  // that is about to be sent (`spec/04 §4`).
  const quote = await quoteArbitrationCost({ client, extraData });
  if (!quote.success) return quote;

  // Before simulating, so a refusal costs nothing and reveals nothing.
  const assessed = checkCostCeiling({ quotedWei: quote.data, ceilingWei: ceilingWei.data });
  if (!assessed.success) return assessed;

  const balanceWei = await readBalance({ client, address: account.address });
  if (!balanceWei.success) return balanceWei;

  // Before simulating, because the endpoint enforces balance inside `eth_call`:
  // without this the answer comes back as SIMULATION_REVERTED, which tells a
  // consuming agent the chain rejected the call rather than that the account
  // cannot pay. `broadcast.ts` still runs the full check, gas included.
  const affordable = checkValueAffordable({ balanceWei: balanceWei.data, valueWei: quote.data });
  if (!affordable.success) return affordable;

  const outcome = await simulateAndMaybeBroadcast({
    client,
    account,
    target: { address: DISPUTE_RESOLVER.address, abi: DISPUTE_RESOLVER_ABI as Abi },
    call: {
      functionName: "createDisputeForTemplate",
      args: [extraData, template.data.json, NO_DATA_MAPPINGS, numberOfRulingOptions],
    },
    // Exactly the quote. Not the quote plus a margin, not a rounded quote: the
    // chain reverts below it and forwards anything above it (`spec/02 §2`).
    value: quote.data,
    broadcast: options.broadcast,
    timeoutMs: RECEIPT_TIMEOUT_MS,
    balanceWei: balanceWei.data,
    ...(maxFeePerGas.data !== undefined ? { maxFeePerGas: maxFeePerGas.data } : {}),
    rpcUrls: prepared.data.rpcUrls,
  });
  if (!outcome.success) return outcome;

  const base = {
    ok: true,
    command: "create-dispute",
    status: outcome.data.status,
    broadcast: outcome.data.broadcast,
    requested: {
      court: courtID.toString(),
      jurors: jurors.toString(),
      disputeKit: disputeKitID.toString(),
    },
    arbitrationCost: { wei: quote.data.toString(), eth: assessed.data.eth },
    extraData,
    numberOfRulingOptions: numberOfRulingOptions.toString(),
    estimatedGas: outcome.data.gas,
    warnings: [...prepared.data.warnings, ...assessed.data.warnings],
  };

  if (outcome.data.status === "simulated") {
    return ok({
      ...base,
      message:
        "SIMULATION ONLY — no transaction was sent, no dispute was created and no fee was paid. " +
        `Re-run with --broadcast to create the dispute and spend ${assessed.data.eth} ETH.`,
    });
  }

  if (outcome.data.status === "reverted") {
    return err(
      "TRANSACTION_REVERTED",
      `Transaction ${outcome.data.txHash} was mined and reverted. No dispute was created. The ` +
        `${assessed.data.eth} ETH arbitration fee was returned with the revert, but the gas was ` +
        "spent. Read the transaction before re-running: a revert after a clean simulation means " +
        "chain state changed between the two.",
      { txHash: outcome.data.txHash },
    );
  }

  if (outcome.data.status === "unknown") {
    return ok({
      ...base,
      txHash: outcome.data.txHash,
      message: unknownOutcomeMessage(
        outcome.data.txHash,
        "the dispute may already exist, and re-running with --broadcast would pay the " +
          `${assessed.data.eth} ETH arbitration fee a second time and create a second dispute.`,
      ),
    });
  }

  // Mined. The core dispute ID comes from the `DisputeCreation` log and never
  // from the function's return value. The two agree — verified on a fork where
  // the local index had been driven apart from the core ID — so this is a
  // provenance rule: the log is the arbitrator's own statement (`spec/01 §7`).
  const coreDisputeID = await readCreatedDisputeID({ client, txHash: outcome.data.txHash });
  if (!coreDisputeID.success) return coreDisputeID;

  const effective = await readEffectiveDispute({ client, coreDisputeID: coreDisputeID.data });
  if (!effective.success) return effective;

  // Read back from chain state, never echoed from the inputs. A difference is an
  // error, not a warning: the money is already spent (`spec/02 §1.2`).
  const matched = checkEffective({ requested: requested.data, effective: effective.data });
  if (!matched.success) return matched;

  return ok({
    ...base,
    coreDisputeID: coreDisputeID.data.toString(),
    effective: {
      court: effective.data.courtID.toString(),
      jurors: effective.data.jurors.toString(),
      disputeKit: effective.data.disputeKitID.toString(),
    },
    valueSent: { wei: quote.data.toString(), eth: assessed.data.eth },
    txHash: outcome.data.txHash,
    blockNumber: outcome.data.blockNumber,
    gasUsed: outcome.data.gasUsed,
    message:
      `Dispute ${coreDisputeID.data} created in court ${effective.data.courtID} with ` +
      `${effective.data.jurors} jurors. ${assessed.data.eth} ETH was paid and cannot be recovered.`,
  });
}

export type SubmitEvidenceOptions = PrepareOptions & {
  dispute: string;
  name: string;
  description: string;
  fileUri?: string | undefined;
  fileTypeExtension?: string | undefined;
  broadcast: boolean;
  maxFeeGwei?: string | undefined;
};

/**
 * Submit one evidence document against an existing dispute.
 *
 * The text is **operator-supplied and opaque** (ADR-0007): it is JSON-encoded
 * and sent, never parsed for meaning, never summarised, and no URI it mentions
 * is ever dereferenced. Nothing in it can influence which call is made or with
 * what arguments.
 */
export async function runSubmitEvidence(
  options: SubmitEvidenceOptions,
): Promise<KlerosResult<Record<string, unknown>>> {
  const coreDisputeID = parseBigInt(options.dispute, "--dispute");
  if (!coreDisputeID.success) return coreDisputeID;

  const maxFeePerGas = options.maxFeeGwei
    ? parseGweiToWei(options.maxFeeGwei, "--max-fee-gwei")
    : ok(undefined);
  if (!maxFeePerGas.success) return maxFeePerGas;

  const text = resolveEvidenceText(options);
  if (!text.success) return text;

  const evidence = buildEvidence({
    name: text.data.name,
    description: text.data.description,
    ...(options.fileUri !== undefined ? { fileURI: options.fileUri } : {}),
    ...(options.fileTypeExtension !== undefined
      ? { fileTypeExtension: options.fileTypeExtension }
      : {}),
  });
  if (!evidence.success) return evidence;

  const prepared = await prepare({ ...options, requireSigner: true });
  if (!prepared.success) return prepared;
  const { client, account } = prepared.data;

  // The first of the two hard refusals on this path. `submitEvidence` has no
  // access control, no payment and no period gate, and it accepts an ID that does
  // not exist — so the harm is unreachability, not loss (ADR-0011).
  const facts = await readEvidenceFacts({ client, coreDisputeID: coreDisputeID.data });
  if (!facts.success) return facts;

  // The second hard refusal, and the one that decides which identifier is signed.
  // It is on the write path rather than in the read, because `status` shares that
  // read and reports a foreign dispute perfectly well (ADR-0014).
  const localDisputeID = checkEvidenceAddressable(facts.data);
  if (!localDisputeID.success) return localDisputeID;

  const assessment = checkEvidencePreflight(facts.data);
  if (!assessment.success) return assessment;

  const balanceWei = await readBalance({ client, address: account.address });
  if (!balanceWei.success) return balanceWei;

  const outcome = await simulateAndMaybeBroadcast({
    client,
    account,
    target: { address: EVIDENCE_MODULE.address, abi: EVIDENCE_MODULE_ABI as Abi },
    // `_externalDisputeID` is the **local** dispute ID, and that is what is sent
    // — not the core ID the caller passed. The subgraph keys the evidence group
    // on this argument verbatim and the Court client looks it up by the
    // dispute's `externalDisputeId`, so sending the core ID files the document
    // into a group nothing reads wherever the two differ. They coincide for
    // every dispute on Arbitrum One only because `DisputeResolver` created every
    // one of them (`spec/01 §7`, `spec/02 §4.2`, ADR-0014).
    call: { functionName: "submitEvidence", args: [localDisputeID.data, evidence.data.json] },
    // Not payable. There is no `value` here and adding one would be rejected.
    broadcast: options.broadcast,
    timeoutMs: RECEIPT_TIMEOUT_MS,
    balanceWei: balanceWei.data,
    ...(maxFeePerGas.data !== undefined ? { maxFeePerGas: maxFeePerGas.data } : {}),
    rpcUrls: prepared.data.rpcUrls,
  });
  if (!outcome.success) return outcome;

  const base = {
    ok: true,
    command: "submit-evidence",
    status: outcome.data.status,
    broadcast: outcome.data.broadcast,
    coreDisputeID: coreDisputeID.data.toString(),
    court: assessment.data.courtID.toString(),
    period: assessment.data.period,
    secondsRemaining:
      assessment.data.secondsRemaining === null
        ? null
        : assessment.data.secondsRemaining.toString(),
    // The document itself is not echoed back: output is kept small
    // (`spec/03 §5.1`). Its UTF-8 byte length is what proves which bytes were
    // built, without reproducing operator content in the payload.
    evidenceBytes: evidence.data.byteLength,
    estimatedGas: outcome.data.gas,
    warnings: [...prepared.data.warnings, ...assessment.data.warnings],
  };

  if (outcome.data.status === "simulated") {
    return ok({
      ...base,
      message:
        "SIMULATION ONLY — no transaction was sent and no evidence was submitted. Re-run with " +
        `--broadcast to submit ${evidence.data.byteLength} bytes of evidence against dispute ` +
        `${coreDisputeID.data}. Submitting evidence costs gas only; there is no arbitration fee ` +
        "on this path.",
    });
  }

  if (outcome.data.status === "reverted") {
    return err(
      "TRANSACTION_REVERTED",
      `Transaction ${outcome.data.txHash} was mined and reverted. No evidence was submitted, and ` +
        "the gas was spent. Nothing about the dispute changed.",
      { txHash: outcome.data.txHash },
    );
  }

  if (outcome.data.status === "unknown") {
    return ok({
      ...base,
      txHash: outcome.data.txHash,
      message: unknownOutcomeMessage(
        outcome.data.txHash,
        `the evidence may already be filed against dispute ${coreDisputeID.data}, and a second ` +
          "submission would cost gas again and file the same document twice — untidy rather " +
          "than harmful, which is the whole difference from create-dispute.",
      ),
    });
  }

  return ok({
    ...base,
    txHash: outcome.data.txHash,
    blockNumber: outcome.data.blockNumber,
    gasUsed: outcome.data.gasUsed,
    message:
      `${evidence.data.byteLength} bytes of evidence were submitted against dispute ` +
      `${coreDisputeID.data}, in court ${assessment.data.courtID}'s ${assessment.data.period} ` +
      "period. Evidence is emitted in an event and is not stored on chain.",
  });
}

/**
 * The `status: "unknown"` wording — `spec/04 §3`.
 *
 * A broadcast whose receipt never arrived is a **success**, not a failure: the
 * tool stopped watching, and the transaction may still land. **Retrying is the
 * dangerous action**, so the prose must name the hash — so the caller can check
 * instead of re-sending — and say what a blind re-send would cost. The
 * consequence differs between the two commands by an order of magnitude, which
 * is why the caller supplies it.
 *
 * Pure and exported so that requirement is asserted directly. `broadcast.ts`
 * produces the outcome and `broadcast.test.ts` covers it; reaching this string
 * through the whole stack costs twelve seconds of viem's receipt-retry ladder
 * and asserts nothing either of them already does.
 */
export function unknownOutcomeMessage(txHash: Hex, consequence: string): string {
  return (
    `The transaction was broadcast as ${txHash} but no receipt arrived before the timeout, so ` +
    `the outcome is UNKNOWN. It may still be mined. Check that hash on chain before doing ` +
    `anything else: ${consequence} This tool never retries.`
  );
}

/**
 * `--name` and `--description`, each a literal string, `@path` to read a file,
 * or `-` to read stdin.
 *
 * `spec/03 §3.3` allows this so long text stays off the command line and out of
 * the process table, and forbids the obvious alternative: **there is no flag
 * that reads either of them from an environment variable.**
 */
function resolveEvidenceText(options: {
  name: string;
  description: string;
}): KlerosResult<{ name: string; description: string }> {
  // stdin can only be drained once, and the second read would come back empty
  // and be refused as a blank field — a true refusal with a misleading reason.
  if (options.name === "-" && options.description === "-") {
    return err(
      "EVIDENCE_INVALID",
      "Only one of --name and --description can be read from stdin. Nothing was sent.",
      { hint: "Pass the other as a literal string or as @path." },
    );
  }

  const name = readEvidenceField(options.name, "--name");
  if (!name.success) return name;

  const description = readEvidenceField(options.description, "--description");
  if (!description.success) return description;

  return ok({ name: name.data, description: description.data });
}

function readEvidenceField(input: string, option: string): KlerosResult<string> {
  if (input !== "-" && !input.startsWith("@")) return ok(input);

  const text = readTextFile(input === "-" ? 0 : input.slice(1));
  if (text !== null) return ok(text);

  return err(
    "EVIDENCE_INVALID",
    `Could not read ${option} from ${input === "-" ? "stdin" : input}. Nothing was sent.`,
    { hint: `Pass ${option} as a literal string to bypass file and stdin reading.` },
  );
}

/**
 * The only filesystem read outside the key file. Never a URI, never a network
 * fetch — an operator-supplied path, opened as bytes.
 *
 * `null` rather than a `KlerosResult`: each caller names its own code, because
 * the same unreadable file is `TEMPLATE_INVALID` on one path and
 * `EVIDENCE_INVALID` on the other, and neither wants a message written here.
 */
function readTextFile(source: string | number): string | null {
  try {
    return readFileSync(source, "utf8");
  } catch {
    return null;
  }
}
