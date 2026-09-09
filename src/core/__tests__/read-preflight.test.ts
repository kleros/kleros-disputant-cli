import { describe, expect, it } from "vitest";
import { contractsFor } from "../deployment.js";
import { DEFAULT_DEPLOYMENT } from "../deployments.js";
import { checkPreflight } from "../preflight.js";
import { readCreateDisputeFacts, readEvidenceFacts } from "../read-preflight.js";
import { failure, fakeClient, functionNames, success } from "./fake-client.js";

/** The one deployment served today; ticket 04 makes the double take one. */
const contracts = contractsFor(DEFAULT_DEPLOYMENT);

/**
 * The read half of pre-flight — `spec/01 §8`, `spec/03 §8`.
 *
 * Nothing here judges anything: what is asserted is the mapping from multicall
 * outcomes to a facts struct, and which calls were made. The judging is
 * `preflight.test.ts`'s subject, and the two meet in the last block below.
 */

/** `courts(...)` returns seven fields; only the last, `disabled`, is read. */
const courtsTuple = (disabled: boolean) => [0n, false, 0n, 0n, 0n, 0n, disabled];

/** X1's court and kit: General Court, Classic. */
const HEALTHY = () => [
  success(5n),
  success([0n, 0n, 0n, 0n]),
  success(courtsTuple(false)),
  success(true),
];

describe("reading the create-dispute facts", () => {
  it("reads all four in one batch, and reads isSupported every time", async () => {
    const client = fakeClient({ multicall: HEALTHY });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 1n,
      disputeKitID: 1n,
    });

    expect(result).toEqual({
      success: true,
      data: {
        deployment: DEFAULT_DEPLOYMENT.slug,
        courtExists: true,
        disputeKitsLength: 5n,
        courtDisabled: false,
        kitSupported: true,
      },
    });
    expect(client.calls).toHaveLength(1);
    expect(functionNames(client.calls[0])).toEqual([
      "getDisputeKitsLength",
      "getTimesPerPeriod",
      "courts",
      "isSupported",
    ]);
  });

  it("reports a court whose getTimesPerPeriod reverted as absent", async () => {
    const client = fakeClient({
      multicall: () => [success(5n), failure(), failure(), success(false)],
    });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 99n,
      disputeKitID: 1n,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.courtExists).toBe(false);
    // `courts(99)` reverted too, so "disabled" was genuinely not read. It stays
    // `undefined` rather than being guessed at `false`.
    expect(result.data.courtDisabled).toBeUndefined();
  });

  it("carries a disabled court through as disabled", async () => {
    const client = fakeClient({
      multicall: () => [
        success(5n),
        success([0n, 0n, 0n, 0n]),
        success(courtsTuple(true)),
        success(true),
      ],
    });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 2n,
      disputeKitID: 1n,
    });
    expect(result.success && result.data.courtDisabled).toBe(true);
  });

  it("leaves kitSupported unread when isSupported reverted", async () => {
    const client = fakeClient({
      multicall: () => [
        success(5n),
        success([0n, 0n, 0n, 0n]),
        success(courtsTuple(false)),
        failure(),
      ],
    });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 1n,
      disputeKitID: 4n,
    });
    expect(result.success && result.data.kitSupported).toBeUndefined();
  });

  /**
   * `parseBigInt` bounds nothing but the syntax, and viem throws while *encoding*
   * a `uint96` overflow — which would fail the whole batch and be reported as
   * `RPC_ERROR`, the wrong diagnosis for what is plainly an out-of-range court.
   * The unencodable calls are left out of the batch instead.
   */
  it("does not send a court ID that cannot be encoded, and calls it absent", async () => {
    const client = fakeClient({ multicall: () => [success(5n)] });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 2n ** 96n,
      disputeKitID: 1n,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.courtExists).toBe(false);
    expect(functionNames(client.calls[0])).toEqual(["getDisputeKitsLength"]);
  });

  /**
   * `disputeKitsLength` is required and non-nullable: without it there is no kit
   * range to judge against, so it is an RPC failure rather than a fact reported
   * as absent.
   */
  it("fails with RPC_ERROR when the kit count cannot be read", async () => {
    const client = fakeClient({
      multicall: () => [
        failure(),
        success([0n, 0n, 0n, 0n]),
        success(courtsTuple(false)),
        success(true),
      ],
    });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 1n,
      disputeKitID: 1n,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("RPC_ERROR");
  });

  it("fails with RPC_ERROR when the batch itself does not come back", async () => {
    const client = fakeClient({
      multicall: () => {
        throw new Error("fetch failed");
      },
    });
    const result = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 1n,
      disputeKitID: 1n,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("RPC_ERROR");
  });
});

describe("reading the evidence facts", () => {
  const dispute = (
    over: Partial<{ court: bigint; period: number; ruled: boolean; changed: bigint }> = {},
  ) =>
    success([
      over.court ?? 1n,
      "0xb5526D022962A1fFf6eD32C93e8b714c901F4323",
      over.period ?? 0,
      over.ruled ?? false,
      over.changed ?? 1_000n,
    ]);

  const times = success([280_800n, 100n, 100n, 100n]);

  it("resolves a dispute and the period lengths of its own court, in two round trips", async () => {
    const client = fakeClient({
      timestamp: 2_000n,
      multicall: (contracts) =>
        contracts[0]?.functionName === "disputes" ? [dispute(), success(215n)] : [times],
    });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 216n });

    expect(result).toEqual({
      success: true,
      data: {
        coreDisputeID: 216n,
        courtID: 1n,
        arbitrable: contracts.disputeResolver.address,
        disputeResolver: contracts.disputeResolver.address,
        localDisputeID: 215n,
        periodIndex: 0,
        ruled: false,
        lastPeriodChange: 1_000n,
        timesPerPeriod: [280_800n, 100n, 100n, 100n],
        now: 2_000n,
      },
    });
    expect(client.calls.map((batch) => functionNames(batch))).toEqual([
      // Both reads take only the core dispute ID, so they share the round trip.
      ["disputes", "arbitratorDisputeIDToLocalID"],
      ["getTimesPerPeriod"],
    ]);
  });

  /**
   * The one hard refusal on the evidence path. The message must not claim the
   * chain would reject the submission — it would not, and neither would the
   * subgraph. The harm is unreachability (`spec/02 §4.2`, ADR-0011).
   */
  it("refuses a dispute ID KlerosCore cannot resolve, and names unreachability", async () => {
    const client = fakeClient({ multicall: () => [failure(), success(0n)] });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 999_999n });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_FOUND");
    expect(result.message).toContain("would accept the submission");
    expect(result.message).toContain("nothing can read it");
    expect(result.message).not.toMatch(/revert|reject the/i);
    // The court's period lengths were never asked for: there is no court.
    expect(client.calls).toHaveLength(1);
  });

  /**
   * The measured pair, from the v2 testnet at block 306 980 776 **[live]**: core
   * dispute 58 is the resolver's local dispute 33. Production cannot show this —
   * `DisputeResolver` created every dispute on Arbitrum One, so the two numbers
   * coincide for all of them (`spec/01 §7`).
   */
  it("carries the local dispute ID, which is not the core one", async () => {
    const client = fakeClient({
      multicall: (contracts) =>
        contracts[0]?.functionName === "disputes" ? [dispute(), success(33n)] : [times],
    });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 58n });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.localDisputeID).toBe(33n);
    expect(result.data.coreDisputeID).toBe(58n);
  });

  /**
   * The reason the arbitrable is checked **before** the mapping is read. The
   * getter is a public mapping, so a foreign dispute reads as `0` rather than
   * reverting — and `0` is a real local dispute ID **[live]**: on the testnet
   * core dispute 0 is the resolver's local dispute 0. Trusting the mapping alone
   * would file evidence against that dispute.
   */
  it("reports no local ID for a dispute another arbitrable created", async () => {
    const foreign = "0xDfa9E40FcBf4f37aa09996eAF39962742299B7Bc" as const;
    const client = fakeClient({
      multicall: (contracts) =>
        contracts[0]?.functionName === "disputes"
          ? [success([1n, foreign, 0, false, 1_000n]), success(0n)]
          : [times],
    });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 98n });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.localDisputeID).toBeNull();
    expect(result.data.arbitrable).toBe(foreign);
  });

  /**
   * A public mapping getter cannot revert, so a failure is not "no local index"
   * — it means the address or ABI bound here is not the deployed resolver.
   * Reading it as a missing mapping would send evidence to local ID 0.
   */
  it("reports an unanswerable mapping as a deployment problem, not a missing ID", async () => {
    const client = fakeClient({
      multicall: (contracts) =>
        contracts[0]?.functionName === "disputes" ? [dispute(), failure()] : [times],
    });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 216n });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DEPLOYMENT_INCONSISTENT");
    expect(result.message).toContain("cannot revert");
  });

  it("refuses a dispute ID too large to be one", async () => {
    const client = fakeClient({ multicall: () => [] });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 2n ** 256n });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_FOUND");
    expect(client.calls).toHaveLength(0);
  });

  /**
   * The dispute resolved, so the court exists by construction: a court whose own
   * disputes reference it and which then fails to answer is a chain problem, not
   * a bad ID.
   */
  it("reports an unreadable court as RPC_ERROR, not as a missing dispute", async () => {
    const client = fakeClient({
      multicall: (contracts) =>
        contracts[0]?.functionName === "disputes" ? [dispute(), success(215n)] : [failure()],
    });
    const result = await readEvidenceFacts({ client, contracts, coreDisputeID: 216n });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("RPC_ERROR");
  });
});

/**
 * The seam itself. `checkPreflight` is pure and `readCreateDisputeFacts` does the
 * I/O; this asserts that what the read produces is exactly what the judge
 * consumes, with nothing adapted in between.
 */
describe("the read layer feeds the pure judge directly", () => {
  it("passes X1 end to end", async () => {
    const client = fakeClient({ multicall: HEALTHY });
    const facts = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 1n,
      disputeKitID: 1n,
    });
    expect(facts.success).toBe(true);
    if (!facts.success) return;

    const decision = checkPreflight({
      requested: { courtID: 1n, jurors: 3n, disputeKitID: 1n, numberOfRulingOptions: 2n },
      chain: facts.data,
    });
    expect(decision.success).toBe(true);
    if (!decision.success) return;
    expect(decision.data.extraData).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001" +
        "0000000000000000000000000000000000000000000000000000000000000003" +
        "0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("refuses a court the read found absent", async () => {
    const client = fakeClient({
      multicall: () => [success(5n), failure(), failure(), success(false)],
    });
    const facts = await readCreateDisputeFacts({
      client,
      contracts,
      courtID: 99n,
      disputeKitID: 1n,
    });
    expect(facts.success).toBe(true);
    if (!facts.success) return;

    const decision = checkPreflight({
      requested: { courtID: 99n, jurors: 3n, disputeKitID: 1n, numberOfRulingOptions: 2n },
      chain: facts.data,
    });
    expect(decision.success).toBe(false);
    if (decision.success) return;
    expect(decision.code).toBe("COURT_OUT_OF_RANGE");
  });
});
