import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEventTopics, keccak256, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTRA_DATA_VECTORS, TEMPLATE_T1 } from "../../core/__tests__/vectors.js";
import { contractsFor } from "../../core/deployment.js";
import { DEFAULT_DEPLOYMENT } from "../../core/deployments.js";
import { runArbitrationCost, runStatus } from "../read.js";
import { runCreateDispute, runSubmitEvidence, unknownOutcomeMessage } from "../write.js";
import {
  type Answers,
  type FakeChain,
  healthyDeployment,
  REVERT,
  startFakeChain,
} from "./fake-chain.js";

/** The one deployment served today; ticket 04 makes the double take one. */
const contracts = contractsFor(DEFAULT_DEPLOYMENT);

/**
 * The four commands, end to end against an in-process chain — `spec/05 §1.7`.
 *
 * These assert the envelopes, which nothing else can: `spec/03 §5` fixes their
 * shape, and every one of its rules is about what a consuming agent reads.
 * Offline: the only network here is a loopback server this file starts.
 *
 * The key file is real, written to a fresh temporary directory at mode 0600,
 * because `loadSigner` refuses anything looser and a test that bypassed that
 * would not be testing the command.
 */

/** anvil's first account. A published test key, never used on a live chain. */
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const X1 = EXTRA_DATA_VECTORS[0];

let dir: string;
let keyFile: string;
let templateFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kleros-disputant-"));
  keyFile = join(dir, "disputant.key");
  writeFileSync(keyFile, TEST_KEY, "utf8");
  chmodSync(keyFile, 0o600);
  templateFile = join(dir, "template.json");
  writeFileSync(templateFile, JSON.stringify(TEMPLATE_T1), "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A General Court that exists, is enabled, supports Classic and quotes X1. */
function healthyCore(overrides: Answers = {}): Answers {
  return {
    ...healthyDeployment().core,
    getDisputeKitsLength: () => 5n,
    getTimesPerPeriod: ([courtID]) =>
      (courtID as bigint) <= 34n ? [280_800n, 280_800n, 280_800n, 280_800n] : REVERT,
    courts: ([courtID]) =>
      (courtID as bigint) <= 34n ? [0n, false, 1n, 1n, 5_000_000_000_000_000n, 3n, false] : REVERT,
    isSupported: ([, kitID]) => (kitID as bigint) === 1n,
    arbitrationCost: () => X1.costWei,
    ...overrides,
  };
}

const chains: FakeChain[] = [];
afterAll(async () => {
  await Promise.all(chains.map((c) => c.close()));
});

async function chain(options: Parameters<typeof startFakeChain>[0] = {}): Promise<FakeChain> {
  const healthy = healthyDeployment();
  const started = await startFakeChain({
    ...options,
    core: options.core ?? healthyCore(),
    resolver: { ...healthy.resolver, createDisputeForTemplate: () => 216n, ...options.resolver },
    evidenceModule: {
      ...healthy.evidenceModule,
      submitEvidence: () => [],
      ...options.evidenceModule,
    },
  });
  chains.push(started);
  return started;
}

/** `spec/03 §5.1` rule 1: a bigint that reached an envelope would throw here. */
function serialisable(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("arbitration-cost", () => {
  it("quotes X1 and states the price in both wei and ETH", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "1",
      jurors: "3",
      kit: "1",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.arbitrationCost).toEqual({ wei: X1.costWei.toString(), eth: X1.costEth });
    expect(result.data.extraData).toBe(X1.blob);
    expect(result.data.warnings).toEqual([]);
    expect(serialisable(result.data)).toContain(X1.costEth);
    expect(node.sent).toEqual([]);
  });

  /**
   * The reason this command runs pre-flight at all. `arbitrationCost` answers
   * for a court that does not exist — it returns the General Court's price,
   * because the decoder substitutes a default rather than reverting
   * (`spec/01 §4.4`) — so a quote that skipped the check would report a
   * confident number for a court nobody named.
   */
  it("refuses a court that does not exist rather than quoting the General Court for it", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "99",
      jurors: "3",
      kit: "1",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("COURT_OUT_OF_RANGE");
    expect(node.contractCalls).not.toContain("KlerosCore.arbitrationCost");
  });

  it("refuses court 0 without asking the chain anything about it", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "0",
      jurors: "3",
      kit: "1",
    });
    expect(result.success === false && result.code).toBe("COURT_OUT_OF_RANGE");
    expect(node.contractCalls).not.toContain("KlerosCore.arbitrationCost");
  });

  it("reads isSupported on every invocation, because court configuration is mutable", async () => {
    const node = await chain();
    await runArbitrationCost({ rpcUrl: node.url, court: "1", jurors: "3", kit: "1" });
    await runArbitrationCost({ rpcUrl: node.url, court: "1", jurors: "3", kit: "1" });
    expect(node.contractCalls.filter((c) => c === "KlerosCore.isSupported")).toHaveLength(2);
  });

  it("refuses a non-numeric court before it opens a connection", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "one",
      jurors: "3",
      kit: "1",
    });
    expect(result.success === false && result.code).toBe("NUMBER_INVALID");
    expect(node.methods).toEqual([]);
  });

  it("refuses the wrong chain before it looks anything up in the deployment", async () => {
    const node = await chain({ chainId: 1 });
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "1",
      jurors: "3",
      kit: "1",
    });
    expect(result.success === false && result.code).toBe("WRONG_CHAIN");
    expect(node.contractCalls).toEqual([]);
  });

  it("warns on a version mismatch rather than refusing", async () => {
    const node = await chain({ core: healthyCore({ version: () => "0.11.0" }) });
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "1",
      jurors: "3",
      kit: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.warnings).toHaveLength(1);
    expect(String((result.data.warnings as string[])[0])).toContain("0.11.0");
  });
});

/**
 * `--chain` — `spec/03 §7` step 1, `ADR-0015`.
 *
 * The refusal is asserted through a command rather than through
 * `resolveDeployment`, because the property that matters is not "the function
 * returns an error" but **that nothing was contacted**: the in-process node
 * records every JSON-RPC method it is asked, so an empty list is the assertion.
 */
describe("--chain", () => {
  it.each(["arbitrum-sepolia", "arbitrum-sepolia-devnet", "nonsense"])(
    "refuses %s before a single round trip",
    async (slug) => {
      const node = await chain();
      const result = await runArbitrationCost({
        chain: slug,
        rpcUrl: node.url,
        court: "1",
        jurors: "3",
        kit: "1",
      });

      expect(result.success === false && result.code).toBe("CHAIN_NOT_SUPPORTED");
      expect(node.methods).toEqual([]);
    },
  );

  /**
   * The refusal must come before the key file is opened as well. A caller who
   * named a deployment this tool does not serve should be told that, not that
   * their key is unreadable — and a signing command that reached the key first
   * would report the wrong one of the two.
   */
  it("refuses an unserved slug ahead of the signer, on a command that signs", async () => {
    const node = await chain();
    const result = await runCreateDispute({
      chain: "arbitrum-sepolia-devnet",
      rpcUrl: node.url,
      keyFile: join(dir, "no-such-key"),
      requireSigner: true,
      court: "1",
      jurors: "3",
      kit: "1",
      templateFile,
      maxCostEth: "1",
      broadcast: false,
    });

    expect(result.success === false && result.code).toBe("CHAIN_NOT_SUPPORTED");
    expect(node.methods).toEqual([]);
  });

  /** Every invocation written before the flag existed still means what it meant. */
  it("resolves to arbitrum-one when the flag is absent", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      rpcUrl: node.url,
      court: "1",
      jurors: "3",
      kit: "1",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.deployment).toBe("arbitrum-one");
  });

  /**
   * **The chain ID reported is the one that was asserted, not the one that was
   * requested** — the same rule that already governs the effective court, juror
   * count and kit (`spec/02 §1.2`). A caller must never have to infer which
   * deployment a result came from.
   */
  it("echoes the resolved deployment and the asserted chain ID in every success envelope", async () => {
    // One node answering for all four commands, so the assertion is about the
    // envelope rather than about four different fixtures.
    const node = await chain({
      core: healthyCore({
        disputes: () => [1n, contracts.disputeResolver.address, 0, false, 1_756_900_000n],
        currentRuling: () => [0n, false, false],
      }),
    });
    const echo = { deployment: "arbitrum-one", chainId: 42161 };

    const quote = await runArbitrationCost({
      chain: "arbitrum-one",
      rpcUrl: node.url,
      court: "1",
      jurors: "3",
      kit: "1",
    });
    expect(
      quote.success && { deployment: quote.data.deployment, chainId: quote.data.chainId },
    ).toEqual(echo);

    const status = await runStatus({ chain: "arbitrum-one", rpcUrl: node.url, dispute: "216" });
    expect(
      status.success && { deployment: status.data.deployment, chainId: status.data.chainId },
    ).toEqual(echo);

    const created = await runCreateDispute({
      chain: "arbitrum-one",
      rpcUrl: node.url,
      keyFile,
      requireSigner: true,
      court: "1",
      jurors: "3",
      kit: "1",
      templateFile,
      maxCostEth: "1",
      broadcast: false,
    });
    expect(
      created.success && { deployment: created.data.deployment, chainId: created.data.chainId },
    ).toEqual(echo);

    const evidence = await runSubmitEvidence({
      chain: "arbitrum-one",
      rpcUrl: node.url,
      keyFile,
      requireSigner: true,
      dispute: "216",
      name: "Delivery photographs",
      description: "The parcel arrived opened.",
      broadcast: false,
    });
    expect(
      evidence.success && { deployment: evidence.data.deployment, chainId: evidence.data.chainId },
    ).toEqual(echo);
  });

  /**
   * The hint used to hardcode `--chain arbitrum-one`, which was this bug already
   * present before the flag existed: a caller refused on one deployment was sent
   * to look up a court on another.
   */
  it("points the court-listing hint at the deployment that refused", async () => {
    const node = await chain();
    const result = await runArbitrationCost({
      chain: "arbitrum-one",
      rpcUrl: node.url,
      court: "99",
      jurors: "3",
      kit: "1",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(String((result.details as { hint: string }).hint)).toBe(
      "kleros court list --chain arbitrum-one",
    );
  });
});

describe("status", () => {
  const disputeAnswers = (period: number, ruled = false): Answers =>
    healthyCore({
      disputes: () => [1n, contracts.disputeResolver.address, period, ruled, 1_756_900_000n],
      currentRuling: () => [0n, false, false],
    });

  /**
   * The reason `checkEvidenceAddressable` is on the write path and not in the
   * read layer both commands share (ADR-0014). `status` reads a dispute another
   * arbitrable created perfectly well, and **must not** refuse it — the read is
   * correct, and only a command that signs needs a local dispute ID.
   *
   * This coverage existed by accident until 2026-09-09, when every fixture named
   * KlerosCore as its own arbitrable. Making the fixtures realistic removed it,
   * so it is asserted deliberately here instead.
   */
  it("reports a dispute another arbitrable created, rather than refusing it", async () => {
    const foreign = "0xDfa9E40FcBf4f37aa09996eAF39962742299B7Bc" as const;
    const node = await chain({
      core: healthyCore({
        disputes: () => [1n, foreign, 0, false, 1_756_900_000n],
        currentRuling: () => [0n, false, false],
      }),
      resolver: { arbitratorDisputeIDToLocalID: () => 0n },
    });
    const result = await runStatus({ rpcUrl: node.url, dispute: "98" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe("evidence");
    expect(result.data.coreDisputeID).toBe("98");
    // And it still says nothing about an identifier it did not resolve.
    expect(Object.keys(result.data)).not.toContain("localDisputeID");
  });

  it("reports the period, the court and an upper bound on what is left", async () => {
    const node = await chain({ core: disputeAnswers(0) });
    const result = await runStatus({ rpcUrl: node.url, dispute: "215" });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe("evidence");
    expect(result.data.court).toBe("1");
    expect(result.data.coreDisputeID).toBe("215");
    expect(typeof result.data.secondsRemaining).toBe("string");
    expect(result.data.warnings).toEqual([]);
    expect(String(result.data.message)).toContain("upper bound");
    serialisable(result.data);
  });

  it("warns, and does not refuse, once the evidence period is over", async () => {
    const node = await chain({ core: disputeAnswers(2) });
    const result = await runStatus({ rpcUrl: node.url, dispute: "215" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.period).toBe("vote");
    expect((result.data.warnings as string[]).join(" ")).toContain("evidence period is over");
  });

  it("refuses a dispute ID KlerosCore cannot resolve", async () => {
    const node = await chain({ core: healthyCore({ disputes: () => REVERT }) });
    const result = await runStatus({ rpcUrl: node.url, dispute: "999999" });
    expect(result.success === false && result.code).toBe("DISPUTE_NOT_FOUND");
  });
});

describe("create-dispute", () => {
  const base = () => ({
    keyFile,
    requireSigner: true as const,
    court: "1",
    jurors: "3",
    kit: "1",
    templateFile,
    maxCostEth: "0.02",
    broadcast: false,
  });

  it("simulates, sends nothing, and says so in words", async () => {
    const node = await chain();
    const result = await runCreateDispute({ ...base(), rpcUrl: node.url });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("simulated");
    expect(result.data.broadcast).toBe(false);
    expect(result.data.extraData).toBe(X1.blob);
    expect(result.data.numberOfRulingOptions).toBe("2");
    expect(result.data.arbitrationCost).toEqual({ wei: X1.costWei.toString(), eth: X1.costEth });
    expect(result.data.warnings).toEqual([]);
    // `spec/03 §5.1` rule 3 and `spec/05 §5` criterion 5: the machine state alone
    // is not enough for an LLM consumer.
    expect(String(result.data.message)).toContain("SIMULATION ONLY");
    expect(String(result.data.message)).toContain("--broadcast");
    expect(String(result.data.message)).toContain(X1.costEth);
    expect(node.sent).toEqual([]);
    serialisable(result.data);
  });

  it("quotes with the same bytes it is about to send", async () => {
    let quotedWith: string | undefined;
    const node = await chain({
      core: healthyCore({
        arbitrationCost: ([extraData]) => {
          quotedWith = extraData as string;
          return X1.costWei;
        },
      }),
    });
    await runCreateDispute({ ...base(), rpcUrl: node.url });
    expect(quotedWith).toBe(X1.blob);
  });

  it("refuses above the cost ceiling before it simulates anything", async () => {
    const node = await chain();
    const result = await runCreateDispute({ ...base(), rpcUrl: node.url, maxCostEth: "0.001" });

    expect(result.success === false && result.code).toBe("COST_CEILING_EXCEEDED");
    expect(node.contractCalls).not.toContain("DisputeResolver.createDisputeForTemplate");
    expect(node.sent).toEqual([]);
  });

  /**
   * **[live]** The Arbitrum One public endpoint enforces balance inside
   * `eth_call`, so without a local check first an unfunded account comes back as
   * `SIMULATION_REVERTED` — exit 3, "the chain rejected the call" — when the
   * answer is "fund the account", exit 1. The consuming agent branches on the
   * code, and those two ask for different things.
   */
  it("names an unaffordable fee as such, and refuses before it simulates", async () => {
    const node = await chain({ balanceWei: 10n ** 15n });
    const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(node.contractCalls).not.toContain("DisputeResolver.createDisputeForTemplate");
    expect(node.sent).toEqual([]);
  });

  it("counts the arbitration fee in the balance check, not only the gas", async () => {
    // Covers the fee with a little to spare, and nowhere near enough for the gas
    // on top: the comparison this guards against — `balance < fee` — passes here.
    const node = await chain({ balanceWei: X1.costWei + 10n ** 13n });
    const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("estimated gas");
    expect(node.sent).toEqual([]);
  });

  it("refuses a template the strict schema rejects, before the chain is touched", async () => {
    const bad = join(dir, "bad-template.json");
    writeFileSync(bad, JSON.stringify({ ...TEMPLATE_T1, surprise: true }), "utf8");
    const node = await chain();
    const result = await runCreateDispute({ ...base(), rpcUrl: node.url, templateFile: bad });

    expect(result.success === false && result.code).toBe("TEMPLATE_INVALID");
    expect(node.methods).toEqual([]);
  });

  it("names the file rather than the schema when the template cannot be read", async () => {
    const node = await chain();
    const result = await runCreateDispute({
      ...base(),
      rpcUrl: node.url,
      templateFile: join(dir, "absent.json"),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("TEMPLATE_INVALID");
    expect(result.message).toContain("absent.json");
  });

  it("refuses without a key before it opens a connection", async () => {
    const node = await chain();
    const result = await runCreateDispute({
      ...base(),
      rpcUrl: node.url,
      keyFile: undefined,
    });
    expect(result.success === false && result.code).toBe("KEY_FILE_MISSING");
    expect(node.methods).toEqual([]);
  });

  it("never lets the key reach any payload, on the success path or the failure paths", async () => {
    const node = await chain();
    const payloads = [
      await runCreateDispute({ ...base(), rpcUrl: node.url }),
      await runCreateDispute({ ...base(), rpcUrl: node.url, court: "99" }),
      await runCreateDispute({ ...base(), rpcUrl: node.url, maxCostEth: "0.0001" }),
      await runCreateDispute({ ...base(), rpcUrl: node.url, keyFile: join(dir, "absent.key") }),
    ];
    for (const payload of payloads) {
      const rendered = JSON.stringify(payload);
      expect(rendered).not.toContain(TEST_KEY);
      expect(rendered).not.toContain(TEST_KEY.slice(2));
      // viem's out-of-range message quotes the key back in decimal.
      expect(rendered).not.toContain(BigInt(TEST_KEY).toString(10));
    }
  });

  describe("once it is broadcast", () => {
    /** `DisputeCreation(uint256 indexed, address indexed)`, as the core emits it. */
    const disputeCreationLog = (coreDisputeID: bigint) => ({
      address: contracts.klerosCore.address,
      topics: encodeEventTopics({
        abi: contracts.klerosCore.abi,
        eventName: "DisputeCreation",
        args: { _disputeID: coreDisputeID, _arbitrable: contracts.disputeResolver.address },
      }),
      data: "0x",
      blockNumber: toHex(300_000_000n),
      blockHash: `0x${"ab".repeat(32)}`,
      transactionHash: `0x${"11".repeat(32)}`,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    });

    const mined = (coreDisputeID: bigint, courtID = 1n, jurors = 3n, kitID = 1n) => ({
      core: healthyCore({
        disputes: () => [courtID, contracts.disputeResolver.address, 0, false, 1_757_000_000n],
        getRoundInfo: () => ({
          disputeKitID: kitID,
          pnkAtStakePerJuror: 0n,
          totalFeesForJurors: 0n,
          nbVotes: jurors,
          repartitions: 0n,
          pnkPenalties: 0n,
          drawnJurors: [],
          sumFeeRewardPaid: 0n,
          sumPnkRewardPaid: 0n,
          feeToken: "0x0000000000000000000000000000000000000000" as const,
          drawIterations: 0n,
        }),
      }),
      receipt: {
        status: "0x1",
        blockNumber: toHex(300_000_000n),
        gasUsed: toHex(650_000n),
        effectiveGasPrice: toHex(10_000_000n),
        transactionHash: `0x${"11".repeat(32)}`,
        logs: [disputeCreationLog(coreDisputeID)],
      },
    });

    it("reports the core dispute ID from the log and echoes the effective values", async () => {
      const { core, receipt } = mined(216n);
      const node = await chain({ core, receipt });
      const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe("mined");
      expect(result.data.coreDisputeID).toBe("216");
      expect(result.data.effective).toEqual({ court: "1", jurors: "3", disputeKit: "1" });
      expect(result.data.valueSent).toEqual({ wei: X1.costWei.toString(), eth: X1.costEth });
      expect(String(result.data.message)).toContain("cannot be recovered");
      expect(node.sent).toHaveLength(1);
      serialisable(result.data);
    });

    /**
     * The two agree on chain — `createDisputeForTemplate` returns the core
     * dispute ID, settled on a seeded fork (`spec/01 §7`) — so nothing on a
     * real node can show which of them the code read. A fake chain can: the
     * resolver returns one number and the log carries another.
     */
    it("takes the ID from the log, not from the function's return value", async () => {
      const { core, receipt } = mined(981n);
      const node = await chain({
        core,
        receipt,
        resolver: { createDisputeForTemplate: () => 216n },
      });
      const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });
      expect(result.success && result.data.coreDisputeID).toBe("981");
    });

    it("reports a mined revert as a failure, distinct from a refused broadcast", async () => {
      const { core, receipt } = mined(216n);
      const node = await chain({ core, receipt: { ...receipt, status: "0x0" } });
      const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.code).toBe("TRANSACTION_REVERTED");
      expect(result.message).toContain(`0x${"11".repeat(32)}`);
      // A revert returns the value and keeps the gas. Saying so is the whole
      // point: the caller has to know what it still holds.
      expect(result.message).toContain("returned with the revert");
    });

    it("treats a court that is not the one requested as an error, not a warning", async () => {
      const { core, receipt } = mined(216n, 1n, 15n);
      const node = await chain({ core, receipt });
      const result = await runCreateDispute({ ...base(), rpcUrl: node.url, broadcast: true });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.code).toBe("EFFECTIVE_MISMATCH");
      expect(result.message).toContain("juror count 15 was recorded, 3 was requested");
    });
  });
});

/**
 * `spec/04 §3`, asserted on the wording itself. `broadcast.test.ts` covers
 * producing the outcome; what matters here is that the envelope tells an agent
 * not to do the one dangerous thing.
 */
describe("the unknown-outcome message", () => {
  const hash = `0x${"11".repeat(32)}` as const;

  it("names the hash, so the caller can check instead of re-sending", () => {
    expect(unknownOutcomeMessage(hash, "nothing follows.")).toContain(hash);
  });

  it("says the outcome is unknown, not that it failed", () => {
    const message = unknownOutcomeMessage(hash, "nothing follows.");
    expect(message).toContain("UNKNOWN");
    expect(message).toContain("may still be mined");
    expect(message).not.toMatch(/failed|error/i);
  });

  it("states what a blind re-send would cost, and that this tool never retries", () => {
    const message = unknownOutcomeMessage(hash, "it would pay the fee a second time.");
    expect(message).toContain("a second time");
    expect(message).toContain("never retries");
  });
});

describe("submit-evidence", () => {
  const base = () => ({
    keyFile,
    requireSigner: true as const,
    dispute: "215",
    name: "Delivery photographs",
    description: "The package arrived damaged; see the attached photographs.",
    broadcast: false,
  });

  const inEvidencePeriod = (period = 0, ruled = false): Answers =>
    healthyCore({
      disputes: () => [1n, contracts.disputeResolver.address, period, ruled, 1_756_900_000n],
    });

  /**
   * **The one test that drives real viem over HTTP at a node that prechecks.**
   *
   * `spec/04 §2.1`'s reproduction, end to end: a signer with no ETH,
   * `submit-evidence`, no `--broadcast`. Everything else covering this runs
   * against a hand-written `estimateContractGas` double, which cannot falsify
   * a claim about viem's own account-shape behaviour — this can, because
   * `fake-chain` speaks JSON-RPC and viem builds the request itself.
   *
   * Against the old code the node's precheck fires, `estimateContractGas`
   * throws, and this comes back `RPC_ERROR` at exit 2.
   */
  it("names an unfunded signer, rather than blaming the endpoint", async () => {
    const node = await chain({ core: inEvidencePeriod(), balanceWei: 0n });
    const result = await runSubmitEvidence({ ...base(), rpcUrl: node.url });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("INSUFFICIENT_BALANCE");
    expect(result.message).toContain("no arbitration fee");
    expect((result.details as { hint: string }).hint).toContain("Fund the signing account");
    expect(node.sent).toEqual([]);
  });

  it("simulates, sends nothing, and reports the byte length rather than the text", async () => {
    const node = await chain({ core: inEvidencePeriod() });
    const result = await runSubmitEvidence({ ...base(), rpcUrl: node.url });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("simulated");
    // E1 from `spec/02 §4.4`.
    expect(result.data.evidenceBytes).toBe(106);
    expect(result.data.warnings).toEqual([]);
    expect(String(result.data.message)).toContain("SIMULATION ONLY");
    // `spec/03 §5.1` rule 4: the evidence text is not echoed back in full.
    expect(JSON.stringify(result.data)).not.toContain("arrived damaged");
    expect(node.sent).toEqual([]);
    serialisable(result.data);
  });

  it("warns and proceeds when the evidence period is over", async () => {
    const node = await chain({ core: inEvidencePeriod(4, true) });
    const result = await runSubmitEvidence({ ...base(), rpcUrl: node.url });

    expect(result.success).toBe(true);
    if (!result.success) return;
    const warnings = (result.data.warnings as string[]).join(" ");
    expect(warnings).toContain("execution period");
    expect(warnings).toContain("already reached its ruling");
  });

  it("refuses a core dispute ID no dispute uses", async () => {
    const node = await chain({ core: healthyCore({ disputes: () => REVERT }) });
    const result = await runSubmitEvidence({ ...base(), rpcUrl: node.url, dispute: "999999" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_FOUND");
    expect(node.sent).toEqual([]);
  });

  it("refuses a document keyed title before the chain is touched", async () => {
    const node = await chain({ core: inEvidencePeriod() });
    const result = await runSubmitEvidence({ ...base(), rpcUrl: node.url, name: "" });
    expect(result.success === false && result.code).toBe("EVIDENCE_INVALID");
    expect(node.methods).toEqual([]);
  });

  it("reads long text from a file, so it stays out of the process table", async () => {
    const body = join(dir, "statement.txt");
    writeFileSync(body, "The package arrived damaged; see the attached photographs.", "utf8");
    const node = await chain({ core: inEvidencePeriod() });
    const result = await runSubmitEvidence({
      ...base(),
      rpcUrl: node.url,
      description: `@${body}`,
    });
    expect(result.success && result.data.evidenceBytes).toBe(106);
  });

  it("refuses an unreadable @path rather than submitting the path as the text", async () => {
    const node = await chain({ core: inEvidencePeriod() });
    const result = await runSubmitEvidence({
      ...base(),
      rpcUrl: node.url,
      description: `@${join(dir, "absent.txt")}`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("EVIDENCE_INVALID");
    expect(result.message).toContain("--description");
  });

  it("refuses to read both fields from stdin, which can only be drained once", async () => {
    const node = await chain({ core: inEvidencePeriod() });
    const result = await runSubmitEvidence({
      ...base(),
      rpcUrl: node.url,
      name: "-",
      description: "-",
    });
    expect(result.success === false && result.code).toBe("EVIDENCE_INVALID");
  });

  it("passes the exact E1 bytes and never a URI in their place", async () => {
    let submitted: string | undefined;
    const node = await chain({
      core: inEvidencePeriod(),
      evidenceModule: {
        submitEvidence: ([, evidence]) => {
          submitted = evidence as string;
          return [];
        },
      },
    });
    await runSubmitEvidence({ ...base(), rpcUrl: node.url });
    expect(submitted).toBe(
      '{"name":"Delivery photographs","description":"The package arrived damaged; see the attached photographs."}',
    );
    expect(keccak256(toHex(submitted ?? ""))).toBe(
      "0x8314e0c856eabbffdbad22ed6112133b586b998cc2d10cbdb8bbf71d32137cca",
    );
  });

  /**
   * `spec/02 §4.2` — which identifier reaches the chain.
   *
   * Deliberately against the **v2 Beta** double, not the testnet one. The
   * divergence is reachable on Arbitrum One the day a second arbitrable files
   * there; putting the fixture on a testnet double would re-encode the belief
   * this work disproves, that the defect is a testnet quirk (ADR-0014).
   *
   * The fixture is the measured pair **[live]**: core dispute 58 is the
   * resolver's local dispute 33. Verified on the v2 testnet subgraph the same
   * way — of 47 evidence groups, every id lies in the local range 4..76 and none
   * in the core-only range 77..126, so the core ID names a group nothing reads.
   */
  it("submits the local dispute ID, not the core ID the caller passed", async () => {
    let submittedID: bigint | undefined;
    const node = await chain({
      core: healthyCore({
        disputes: () => [8n, contracts.disputeResolver.address, 0, false, 1_756_900_000n],
      }),
      resolver: { arbitratorDisputeIDToLocalID: () => 33n },
      evidenceModule: {
        submitEvidence: ([id]) => {
          submittedID = id as bigint;
          return [];
        },
      },
    });

    const result = await runSubmitEvidence({ ...base(), dispute: "58", rpcUrl: node.url });

    expect(result.success).toBe(true);
    expect(submittedID).toBe(33n);
    // The caller passed the core ID and is told about the core ID; the second
    // identifier is resolved, used, and never surfaced.
    if (!result.success) return;
    expect(result.data.coreDisputeID).toBe("58");
    // `spec/05 §1.6a`: the core dispute ID "and nothing else". Key-wise rather
    // than a substring search — "33" can appear inside a byte count or a gas
    // figure, and a leak assertion that fails for that reason says the wrong
    // thing.
    expect(Object.keys(result.data)).not.toContain("localDisputeID");
    expect(Object.keys(result.data)).not.toContain("externalDisputeID");
  });

  /**
   * The refusal reached through the JSON-RPC double, as `spec/05 §1.5` requires
   * of a refusal this load-bearing: viem builds the request and the node answers
   * from the real ABIs, so nothing here can agree with a decoding mistake.
   *
   * Core dispute 98 on the v2 testnet **[live]**: a foreign arbitrable, and a
   * mapping that answers 0 — which is a real local dispute ID, not a miss.
   */
  it("refuses a dispute another arbitrable created, and sends nothing", async () => {
    const foreign = "0xDfa9E40FcBf4f37aa09996eAF39962742299B7Bc" as const;
    const node = await chain({
      core: healthyCore({ disputes: () => [8n, foreign, 0, false, 1_756_900_000n] }),
      resolver: { arbitratorDisputeIDToLocalID: () => 0n },
    });

    const result = await runSubmitEvidence({ ...base(), dispute: "98", rpcUrl: node.url });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DISPUTE_NOT_ADDRESSABLE");
    expect(result.message).toContain(foreign);
    // `node.sent` is empty on every path through this block — `base()` never
    // broadcasts — so asserting on it would prove nothing. The refusal fires
    // before `simulateContract`, and that is what can be falsified.
    expect(node.contractCalls).not.toContain("EvidenceModule.submitEvidence");
  });
});
