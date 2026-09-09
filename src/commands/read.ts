import { quoteWarnings } from "../core/cost.js";
import { resolveDeployment } from "../core/deployments.js";
import { formatWeiAsEth, parseBigInt } from "../core/numbers.js";
import { checkEvidencePreflight, checkExtraData } from "../core/preflight.js";
import {
  quoteArbitrationCost,
  readCreateDisputeFacts,
  readCurrentRuling,
  readEvidenceFacts,
} from "../core/read-preflight.js";
import { type KlerosResult, ok } from "../core/result.js";
import { deploymentEcho, type PrepareOptions, prepare } from "./shared.js";

/**
 * The two commands that never sign anything — `spec/03 §2`.
 *
 * Both exist to make a write refusable before it is attempted, which is the
 * boundary ADR-0001 draws: discovery — listing courts, browsing disputes,
 * resolving templates — happens upstream in `@kleros/agentkit`, and a read that
 * cannot change the decision to sign does not belong in the write plane.
 * `arbitration-cost` is `create-dispute` stopping before the quote is acted on;
 * `status` is `submit-evidence`'s pre-flight without the submission.
 */

export type ArbitrationCostOptions = Omit<PrepareOptions, "requireSigner" | "keyFile"> & {
  court: string;
  jurors: string;
  kit: string;
};

/**
 * Price a dispute without creating one.
 *
 * It runs the **same** court, juror-count and kit checks as `create-dispute`,
 * and that is not caution for its own sake: `arbitrationCost` answers for a
 * court that does not exist, returning the General Court's price, because the
 * decoder substitutes a default rather than reverting (`spec/01 §4.4`). A quote
 * that skipped pre-flight would confidently report a number for a court the
 * operator did not name — and it is the number they would then budget for.
 */
export async function runArbitrationCost(
  options: ArbitrationCostOptions,
): Promise<KlerosResult<Record<string, unknown>>> {
  // The slug first, ahead of the other local checks: a caller who named a
  // deployment this tool does not serve should be told that rather than that
  // their court ID is not a number (`spec/03 §7` step 1). `prepareLocal`
  // resolves it again, and the function is pure and total.
  const deployment = resolveDeployment(options.chain);
  if (!deployment.success) return deployment;

  const requested = parseExtraDataOptions(options);
  if (!requested.success) return requested;
  const { courtID, jurors, disputeKitID } = requested.data;

  const prepared = await prepare({ ...options, requireSigner: false });
  if (!prepared.success) return prepared;

  const facts = await readCreateDisputeFacts({
    client: prepared.data.client,
    contracts: prepared.data.contracts,
    courtID,
    disputeKitID,
  });
  if (!facts.success) return facts;

  const words = checkExtraData({ requested: requested.data, chain: facts.data });
  if (!words.success) return words;

  const quote = await quoteArbitrationCost({
    client: prepared.data.client,
    contracts: prepared.data.contracts,
    extraData: words.data.extraData,
  });
  if (!quote.success) return quote;

  const eth = formatWeiAsEth(quote.data);
  return ok({
    ok: true,
    command: "arbitration-cost",
    ...deploymentEcho(prepared.data),
    requested: {
      court: courtID.toString(),
      jurors: jurors.toString(),
      disputeKit: disputeKitID.toString(),
    },
    extraData: words.data.extraData,
    arbitrationCost: { wei: quote.data.toString(), eth },
    warnings: [...prepared.data.warnings, ...quoteWarnings(quote.data)],
    message:
      `Creating a dispute in court ${courtID} with ${jurors} jurors under dispute kit ` +
      `${disputeKitID} costs ${eth} ETH. Nothing was sent and no dispute was created. The fee is ` +
      "paid on creation and cannot be recovered; quote it again immediately before creating, " +
      "because it changes with the court's own configuration.",
  });
}

export type StatusOptions = Omit<PrepareOptions, "requireSigner" | "keyFile"> & {
  dispute: string;
};

/**
 * Where a dispute stands, and whether evidence submitted now can still reach
 * jurors.
 *
 * The one refusal is a core dispute ID `KlerosCore.disputes()` cannot resolve,
 * and it is the same refusal `submit-evidence` makes for the same reason: the
 * EvidenceModule would accept the submission anyway, and the subgraph would
 * index it under a group no dispute references (ADR-0011).
 *
 * Everything else is a warning. Nothing here refuses on the period, because
 * `submitEvidence` has no period gate to refuse on.
 */
export async function runStatus(
  options: StatusOptions,
): Promise<KlerosResult<Record<string, unknown>>> {
  const deployment = resolveDeployment(options.chain);
  if (!deployment.success) return deployment;

  const coreDisputeID = parseBigInt(options.dispute, "--dispute");
  if (!coreDisputeID.success) return coreDisputeID;

  const prepared = await prepare({ ...options, requireSigner: false });
  if (!prepared.success) return prepared;

  const facts = await readEvidenceFacts({
    client: prepared.data.client,
    contracts: prepared.data.contracts,
    coreDisputeID: coreDisputeID.data,
  });
  if (!facts.success) return facts;

  const assessment = checkEvidencePreflight(facts.data);
  if (!assessment.success) return assessment;

  const ruling = await readCurrentRuling({
    client: prepared.data.client,
    contracts: prepared.data.contracts,
    coreDisputeID: coreDisputeID.data,
  });
  if (!ruling.success) return ruling;

  const { period, secondsRemaining } = assessment.data;
  return ok({
    ok: true,
    command: "status",
    ...deploymentEcho(prepared.data),
    coreDisputeID: coreDisputeID.data.toString(),
    court: facts.data.courtID.toString(),
    period,
    // An upper bound, never an entitlement: `passPeriod` is permissionless and a
    // period can end early, so this is the most time there could be
    // (`spec/01 §9`).
    secondsRemaining: secondsRemaining === null ? null : secondsRemaining.toString(),
    ruled: facts.data.ruled,
    currentRuling: {
      ruling: ruling.data.ruling.toString(),
      tied: ruling.data.tied,
      overridden: ruling.data.overridden,
    },
    warnings: [...prepared.data.warnings, ...assessment.data.warnings],
    message: statusMessage({
      coreDisputeID: coreDisputeID.data,
      courtID: facts.data.courtID,
      period,
      secondsRemaining,
    }),
  });
}

function statusMessage({
  coreDisputeID,
  courtID,
  period,
  secondsRemaining,
}: {
  coreDisputeID: bigint;
  courtID: bigint;
  period: string;
  secondsRemaining: bigint | null;
}): string {
  const where = `Dispute ${coreDisputeID} is in court ${courtID}, in the ${period} period`;
  const left =
    secondsRemaining === null
      ? " which has no fixed length."
      : ` with at most ${secondsRemaining}s of it left — an upper bound, because passPeriod is ` +
        "permissionless and the period can end early.";
  const evidence =
    period === "evidence"
      ? " Evidence submitted now is within the window jurors are expected to read."
      : " The evidence period is over. A submission is still recorded on chain and indexed " +
        "against the dispute, but jurors are under no obligation to revisit it.";
  return where + left + evidence;
}

/**
 * The three `extraData` words, parsed. Shared with `create-dispute` so both
 * commands refuse the same typo with the same code.
 */
export function parseExtraDataOptions(options: {
  court: string;
  jurors: string;
  kit: string;
}): KlerosResult<{ courtID: bigint; jurors: bigint; disputeKitID: bigint }> {
  const courtID = parseBigInt(options.court, "--court");
  if (!courtID.success) return courtID;

  const jurors = parseBigInt(options.jurors, "--jurors");
  if (!jurors.success) return jurors;

  const disputeKitID = parseBigInt(options.kit, "--kit");
  if (!disputeKitID.success) return disputeKitID;

  return ok({ courtID: courtID.data, jurors: jurors.data, disputeKitID: disputeKitID.data });
}
