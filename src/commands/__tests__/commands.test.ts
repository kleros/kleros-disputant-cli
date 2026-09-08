import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeEventTopics, keccak256, toHex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXTRA_DATA_VECTORS, TEMPLATE_T1 } from "../../core/__tests__/vectors.js";
import { KLEROS_CORE, KLEROS_CORE_ABI } from "../../core/deployment.js";
import { runArbitrationCost, runStatus } from "../read.js";
import { runCreateDispute, runSubmitEvidence, unknownOutcomeMessage } from "../write.js";
import {
  type Answers,
  type FakeChain,
  healthyDeployment,
  REVERT,
  startFakeChain,
} from "./fake-chain.js";

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

describe("status", () => {
  const disputeAnswers = (period: number, ruled = false): Answers =>
    healthyCore({
      disputes: () => [1n, KLEROS_CORE.address, period, ruled, 1_756_900_000n],
      currentRuling: () => [0n, false, false],
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
      address: KLEROS_CORE.address,
      topics: encodeEventTopics({
        abi: KLEROS_CORE_ABI,
        eventName: "DisputeCreation",
        args: { _disputeID: coreDisputeID, _arbitrable: KLEROS_CORE.address },
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
        disputes: () => [courtID, KLEROS_CORE.address, 0, false, 1_757_000_000n],
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
      disputes: () => [1n, KLEROS_CORE.address, period, ruled, 1_756_900_000n],
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
});
