import type { Address, Hex, PublicClient } from "viem";
import { parseEventLogs } from "viem";
import { type MulticallEntry, multicall, type Outcome, rpcError } from "./client.js";
import { KLEROS_CORE, KLEROS_CORE_ABI } from "./deployment.js";
import type { ChainFacts, EffectiveDispute, EvidenceChainFacts } from "./preflight.js";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The read half of pre-flight — `spec/01 §8`, `spec/03 §8`.
 *
 * **Reading is split from judging**, and `spec/03 §8` calls that the single most
 * important structural requirement in the specification. Everything here does
 * network I/O and produces a facts struct with **no judgement applied**;
 * `preflight.ts` is a pure function over that struct. That split is what makes
 * the logic standing between a typo and a paid mistake testable without an RPC.
 *
 * Only reads that can change the decision to sign belong here (ADR-0001).
 * Discovery — listing courts, browsing disputes, reading policies — happens
 * upstream in `@kleros/agentkit`, and a read that cannot cause a refusal is a
 * read this tool does not make.
 *
 * Every startup check in `spec/03 §7` MUST have run before any function here is
 * called: these are registry-scoped reads, and on an unverified chain they read
 * the wrong core.
 */

const core = { address: KLEROS_CORE.address, abi: KLEROS_CORE_ABI } as const;

/**
 * `courts` and `getTimesPerPeriod` take a `uint96`; `disputes`, `isSupported`
 * and the dispute ID take a `uint256`. An operator can type a larger number —
 * `parseBigInt` bounds nothing but the syntax — and viem throws while *encoding*
 * it, which would fail the whole batch and surface as `RPC_ERROR`: the wrong
 * diagnosis for what is plainly an out-of-range ID. So the unencodable calls are
 * left out of the batch and read as "reverted", which is what the chain would
 * have said if it could have been asked.
 */
const UINT96_MAX = 2n ** 96n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

export type ReadCreateDisputeParams = {
  client: PublicClient;
  courtID: bigint;
  disputeKitID: bigint;
};

/**
 * The four facts `checkPreflight` needs, in one round trip.
 *
 * The mapping from an outcome to a fact is deliberate, and rests on `multicall`'s
 * `allowFailure: true` contract (see `client.ts`): a **transport** problem throws
 * and fails the whole batch, so a single failed entry can only mean that call
 * reverted. `courtExists: false` therefore reports a revert, never a flaky node.
 *
 * `isSupported` is read here on **every** invocation and is never cached: court
 * configuration is governance-mutable, so a cached support table is a stale one
 * (`spec/01 §4.2`).
 */
export async function readCreateDisputeFacts(
  params: ReadCreateDisputeParams,
): Promise<KlerosResult<ChainFacts>> {
  const { client, courtID, disputeKitID } = params;

  const courtEncodable = courtID <= UINT96_MAX;
  const kitEncodable = disputeKitID <= UINT256_MAX;

  const planned: { key: string; entry: MulticallEntry }[] = [
    { key: "kits", entry: { ...core, functionName: "getDisputeKitsLength" } },
  ];
  if (courtEncodable) {
    planned.push(
      { key: "times", entry: { ...core, functionName: "getTimesPerPeriod", args: [courtID] } },
      { key: "courts", entry: { ...core, functionName: "courts", args: [courtID] } },
    );
    if (kitEncodable) {
      planned.push({
        key: "supported",
        entry: { ...core, functionName: "isSupported", args: [courtID, disputeKitID] },
      });
    }
  }

  let results: Outcome[];
  try {
    results = await multicall(
      client,
      planned.map((p) => p.entry),
    );
  } catch (cause) {
    return rpcError(
      `Could not read court ${courtID} and dispute kit ${disputeKitID} from KlerosCore. ` +
        "Nothing was sent.",
      cause,
    );
  }

  const outcome = (key: string): Outcome | undefined => {
    const index = planned.findIndex((p) => p.key === key);
    return index < 0 ? undefined : results[index];
  };

  // `disputeKitsLength` is required and non-nullable: without it `checkPreflight`
  // cannot say what the kit range even is, so an unreadable one is an RPC
  // failure rather than a fact reported as absent.
  const kits = outcome("kits");
  if (kits?.status !== "success") {
    return rpcError(
      `KlerosCore at ${KLEROS_CORE.address} did not answer getDisputeKitsLength(). ` +
        "Nothing was sent.",
      kits?.status === "failure" ? kits.error : undefined,
    );
  }

  const times = outcome("times");
  const courts = outcome("courts");
  const supported = outcome("supported");

  return ok({
    // Absent from the batch means the ID does not fit `uint96`, which is not a
    // court; a failed entry means `getTimesPerPeriod` reverted past the end of
    // the array. Both are "no such court" — the distinction has no consumer.
    courtExists: times === undefined ? false : times.status === "success",
    disputeKitsLength: kits.result as bigint,
    courtDisabled:
      courts?.status === "success"
        ? (courts.result as readonly [bigint, boolean, bigint, bigint, bigint, bigint, boolean])[6]
        : undefined,
    kitSupported: supported?.status === "success" ? (supported.result as boolean) : undefined,
  });
}

export type ReadEvidenceParams = {
  client: PublicClient;
  coreDisputeID: bigint;
};

/**
 * The evidence path's read — `spec/02 §4.2`, `spec/01 §9`.
 *
 * Two round trips, because the court ID is an output of the first: `disputes()`
 * names the court, and only then can its period lengths be read.
 *
 * The refusal here is **the one hard refusal on this path**. `submitEvidence`
 * has no access control, no payment and no period gate, and it succeeds against
 * a dispute ID that does not exist — the subgraph does not drop that evidence
 * either, because `ensureClassicEvidenceGroup` creates the grouping entity on
 * demand. So the harm is unreachability, not loss, and the message says so
 * rather than claiming the chain would reject it (ADR-0011).
 */
export async function readEvidenceFacts(
  params: ReadEvidenceParams,
): Promise<KlerosResult<EvidenceChainFacts>> {
  const { client, coreDisputeID } = params;

  if (coreDisputeID > UINT256_MAX) {
    return disputeNotFound(coreDisputeID);
  }

  let first: Outcome[];
  let now: bigint;
  try {
    const [results, block] = await Promise.all([
      multicall(client, [{ ...core, functionName: "disputes", args: [coreDisputeID] }]),
      client.getBlock(),
    ]);
    first = results;
    // Chain time, never `Date.now()`: the two disagree by whatever the node is
    // lagging by, and this number is reported to an agent that acts on it
    // (`spec/01 §8`).
    now = block.timestamp;
  } catch (cause) {
    return rpcError(`Could not read dispute ${coreDisputeID} from KlerosCore.`, cause);
  }

  const dispute = first[0];
  // A Solidity array getter panics rather than reverting readably past the end,
  // so "does not exist" has to be named here — `spec/01 §8`.
  if (dispute?.status !== "success") return disputeNotFound(coreDisputeID);

  const [courtID, , periodIndex, ruled, lastPeriodChange] = dispute.result as readonly [
    bigint,
    Address,
    number,
    boolean,
    bigint,
  ];

  let second: Outcome[];
  try {
    second = await multicall(client, [
      { ...core, functionName: "getTimesPerPeriod", args: [courtID] },
    ]);
  } catch (cause) {
    return rpcError(`Could not read the period lengths of court ${courtID}.`, cause);
  }

  const times = second[0];
  if (times?.status !== "success") {
    return rpcError(
      `KlerosCore did not answer getTimesPerPeriod(${courtID}) for dispute ${coreDisputeID}, ` +
        "whose own record names that court.",
      times?.status === "failure" ? times.error : undefined,
    );
  }

  return ok({
    coreDisputeID,
    courtID,
    periodIndex: Number(periodIndex),
    ruled,
    lastPeriodChange,
    timesPerPeriod: times.result as readonly bigint[],
    now,
  });
}

function disputeNotFound(coreDisputeID: bigint): KlerosResult<never> {
  return err(
    "DISPUTE_NOT_FOUND",
    `KlerosCore has no dispute ${coreDisputeID}. The EvidenceModule would accept the submission ` +
      "anyway — it never looks the ID up — and the subgraph would index it under a group no " +
      "dispute references, so the evidence would be filed where nothing can read it. Nothing " +
      "was sent.",
    {
      coreDisputeID: coreDisputeID.toString(),
      hint: "--dispute takes the core dispute ID, the one Kleros Court shows for the case.",
    },
  );
}

/* ------------------------------------------------------------------------- *
 * The quote and the balance — `spec/02 §2`, `spec/04 §2`.
 * ------------------------------------------------------------------------- */

/**
 * `KlerosCore.arbitrationCost(extraData)` — the exact number that will be sent.
 *
 * The blob is passed through untouched and MUST be the one `checkExtraData`
 * built: quoting with bytes that are not the bytes sent is how a dispute gets
 * created at a price nobody quoted (`spec/04 §4`).
 *
 * **[abi]** `arbitrationCost` is overloaded — `(bytes)` and `(bytes,address)`,
 * the second taking a fee token. viem selects by argument count, so a single
 * argument reaches the ETH path; `deployment.test.ts` pins both overloads so an
 * ABI that dropped the one-argument form fails the build rather than silently
 * retargeting the quote at the token path (`spec/01 §8`, ADR-0008).
 */
export async function quoteArbitrationCost(params: {
  client: PublicClient;
  extraData: Hex;
}): Promise<KlerosResult<bigint>> {
  let results: Outcome[];
  try {
    results = await multicall(params.client, [
      { ...core, functionName: "arbitrationCost", args: [params.extraData] },
    ]);
  } catch (cause) {
    return rpcError(
      "Could not read the arbitration cost from KlerosCore. Nothing was sent.",
      cause,
    );
  }

  const quote = results[0];
  if (quote?.status !== "success") {
    return rpcError(
      `KlerosCore at ${KLEROS_CORE.address} did not answer arbitrationCost(bytes). Nothing was sent.`,
      quote?.status === "failure" ? quote.error : undefined,
    );
  }
  return ok(quote.result as bigint);
}

/**
 * The sender's ETH balance, for `INSUFFICIENT_BALANCE`. Read here rather than
 * inside `broadcast.ts` so the whole balance arithmetic stays a pure function
 * over numbers somebody else fetched (`cost.ts`, `spec/04 §2`).
 */
export async function readBalance(params: {
  client: PublicClient;
  address: Address;
}): Promise<KlerosResult<bigint>> {
  try {
    return ok(await params.client.getBalance({ address: params.address }));
  } catch (cause) {
    return rpcError(`Could not read the balance of ${params.address}. Nothing was sent.`, cause);
  }
}

/* ------------------------------------------------------------------------- *
 * After the send — `spec/01 §7`, `spec/02 §1.2`.
 * ------------------------------------------------------------------------- */

/**
 * The core dispute ID, from the `DisputeCreation` log **and never from the
 * function's return value**.
 *
 * `createDisputeForTemplate` returns the core dispute ID too — settled on a
 * seeded fork, where the return value was 224 and the arbitrable's local index
 * 220 (`spec/01 §7`). So this is a **provenance** rule rather than a
 * correctness fix: the log is `KlerosCore`'s own statement of the ID it
 * assigned, and the return value is `DisputeResolver` relaying it. Only one of
 * the two stays right if the relay changes.
 *
 * The specification asserted the opposite until that fork ran — that the return
 * value was the local index — from a production reading that could not tell
 * them apart, because `DisputeResolver` created all 216 disputes in existence.
 * The rule written here survived being wrong about why, which is the argument
 * for reading the arbitrator's own log in the first place.
 *
 * The receipt is re-fetched by hash rather than threaded out of `broadcast.ts`:
 * that module is inherited verbatim from the juror CLI apart from the three
 * changes `spec/04 §2` names, and one extra read is cheaper than a fourth.
 */
export async function readCreatedDisputeID(params: {
  client: PublicClient;
  txHash: Hex;
}): Promise<KlerosResult<bigint>> {
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await params.client.getTransactionReceipt({ hash: params.txHash });
  } catch (cause) {
    return rpcError(
      `The transaction was mined but its receipt could not be re-read, so the dispute it ` +
        `created cannot be named. The arbitration fee is spent. Transaction ${params.txHash}.`,
      cause,
    );
  }

  const created = parseEventLogs({
    abi: KLEROS_CORE_ABI,
    eventName: "DisputeCreation",
    logs: receipt.logs,
  }).filter((log) => isSameAddress(log.address, KLEROS_CORE.address));

  const first = created[0];
  if (first === undefined) {
    return err(
      "DEPLOYMENT_INCONSISTENT",
      `Transaction ${params.txHash} was mined but KlerosCore at ${KLEROS_CORE.address} emitted ` +
        "no DisputeCreation event, so there is no core dispute ID to report. The arbitration " +
        "fee is spent. Check the transaction before creating a replacement.",
      {
        txHash: params.txHash,
        hint: "The dispute may still exist; read the transaction on chain.",
      },
    );
  }

  return ok((first.args as { _disputeID: bigint })._disputeID);
}

/**
 * The dispute as the core now records it — the read half of the effective-value
 * echo `spec/02 §1.2` requires. No judgement: `checkEffective` in `preflight.ts`
 * decides whether it matches what was asked for.
 *
 * The juror count and the kit come from round 0 rather than from `disputes()`,
 * which carries neither.
 */
export async function readEffectiveDispute(params: {
  client: PublicClient;
  coreDisputeID: bigint;
}): Promise<KlerosResult<EffectiveDispute>> {
  const { client, coreDisputeID } = params;

  let results: Outcome[];
  try {
    results = await multicall(client, [
      { ...core, functionName: "disputes", args: [coreDisputeID] },
      { ...core, functionName: "getRoundInfo", args: [coreDisputeID, 0n] },
    ]);
  } catch (cause) {
    return rpcError(
      `Dispute ${coreDisputeID} was created and paid for, but its court, juror count and kit ` +
        "could not be read back, so they have not been checked against what was requested.",
      cause,
    );
  }

  const [dispute, round] = results;
  if (dispute?.status !== "success" || round?.status !== "success") {
    return rpcError(
      `Dispute ${coreDisputeID} was created and paid for, but KlerosCore did not answer ` +
        "disputes() or getRoundInfo(), so the effective court, juror count and kit have not " +
        "been checked against what was requested.",
      dispute?.status === "failure" ? dispute.error : undefined,
    );
  }

  const [courtID] = dispute.result as readonly [bigint, Address, number, boolean, bigint];
  const { disputeKitID, nbVotes } = round.result as { disputeKitID: bigint; nbVotes: bigint };

  return ok({ coreDisputeID, courtID, jurors: nbVotes, disputeKitID });
}

/* ------------------------------------------------------------------------- *
 * `status` — `spec/03 §2`.
 * ------------------------------------------------------------------------- */

export type CurrentRuling = {
  /** The ruling option the dispute currently resolves to. `0` is "refuse to arbitrate". */
  ruling: bigint;
  tied: boolean;
  overridden: boolean;
};

/**
 * `KlerosCore.currentRuling(disputeID)`, named by `spec/03 §2` as one of the
 * three calls `status` makes.
 *
 * It is read **only** by `status`, and deliberately not folded into
 * `readEvidenceFacts`: nothing about a ruling changes whether this tool will
 * sign a `submitEvidence` call, which has no period gate at all (ADR-0011), and
 * a read that cannot change the decision to sign does not belong on a write
 * path (ADR-0001).
 *
 * Before the dispute is ruled the call still answers, reporting the tally so
 * far. `ruled` on the dispute itself is what says whether it is final.
 */
export async function readCurrentRuling(params: {
  client: PublicClient;
  coreDisputeID: bigint;
}): Promise<KlerosResult<CurrentRuling>> {
  let results: Outcome[];
  try {
    results = await multicall(params.client, [
      { ...core, functionName: "currentRuling", args: [params.coreDisputeID] },
    ]);
  } catch (cause) {
    return rpcError(`Could not read the current ruling of dispute ${params.coreDisputeID}.`, cause);
  }

  const ruling = results[0];
  if (ruling?.status !== "success") {
    return rpcError(
      `KlerosCore did not answer currentRuling(${params.coreDisputeID}).`,
      ruling?.status === "failure" ? ruling.error : undefined,
    );
  }

  const [value, tied, overridden] = ruling.result as readonly [bigint, boolean, boolean];
  return ok({ ruling: value, tied, overridden });
}

function isSameAddress(a: string, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
