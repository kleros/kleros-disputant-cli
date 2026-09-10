import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address, Hex, PrivateKeyAccount, PublicClient } from "viem";
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runCreateDispute, runSubmitEvidence } from "../commands/write.js";
import { EVIDENCE_VECTORS, EXTRA_DATA_VECTORS, TEMPLATE_T1 } from "../core/__tests__/vectors.js";
import { simulateAndMaybeBroadcast } from "../core/broadcast.js";
import { createKlerosClient } from "../core/client.js";
import { contractsFor } from "../core/deployment.js";
import { DEFAULT_DEPLOYMENT } from "../core/deployments.js";
import { decodeRevert } from "../core/reverts.js";
import { NO_DATA_MAPPINGS } from "../core/template.js";

/** The default deployment. The suite is not a matrix — `spec/05 §1.6b`. */
const contracts = contractsFor(DEFAULT_DEPLOYMENT);

/**
 * The seven fork tests — `spec/05 §2`, and criteria 6, 7 and 8 of `spec/05 §5`.
 *
 * These are the only tests that spend money, and the only ones that can see the
 * things production cannot show. Two of them exist because **no test against
 * Arbitrum One can distinguish the answer**: `DisputeResolver` created every
 * dispute that exists there, so local and core dispute IDs coincide for all of
 * them (`spec/01 §7`), and every dispute ever created paid exactly its quote, so
 * what the core does with an excess has never been observed. A fork is where
 * both become observable, because a fork can be seeded.
 *
 * The prerequisite is an Arbitrum One fork on `:8546` — `pnpm test:fork`, which
 * starts anvil, waits for it and reaps it. Absent one this suite **self-skips
 * loudly** rather than being excluded by config (`spec/05 §1`): a skipped suite
 * must be visible in the run output, never silently green.
 *
 * Each test runs inside an `evm_snapshot` / `evm_revert` pair, so a test that
 * seeds the chain or spends the disputant's balance cannot change what the next
 * one measures.
 */

const FORK_URL = "http://127.0.0.1:8546";

/**
 * A chain ID alone is not enough. A bare `anvil --chain-id 42161` answers 42161
 * and holds none of the contracts, and every assertion below would then fail
 * with a decoding error rather than skip — so the probe also requires KlerosCore
 * to have code at the address `deployment.ts` resolves.
 */
async function forkAvailable(): Promise<boolean> {
  try {
    const client = createKlerosClient([FORK_URL], DEFAULT_DEPLOYMENT);
    const [chainId, code] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: contracts.klerosCore.address }),
    ]);
    return chainId === DEFAULT_DEPLOYMENT.chainId && code !== undefined && code !== "0x";
  } catch {
    return false;
  }
}

const FORK_READY = await forkAvailable();

if (!FORK_READY) {
  // Visible in the run output rather than silently green.
  console.warn(
    `[fork] no Arbitrum One fork on ${FORK_URL}; the seven fork tests are inert. Run: pnpm test:fork`,
  );
}

/** anvil's second account. A published test key, never used on a live chain. */
const DISPUTANT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/**
 * anvil's third. It plays **another arbitrable** — the one thing production has
 * never had (`spec/01 §7`). An EOA is enough: `createDispute` records
 * `msg.sender` and calls nothing back on the create path.
 */
const FOREIGN_ARBITRABLE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const X1 = EXTRA_DATA_VECTORS[0];

/** A generous per-test budget: the fork's first touch of a slot fetches it upstream. */
const TIMEOUT = 120_000;

let dir: string;
let keyFile: string;
let templateFile: string;
let client: PublicClient;
let disputant: PrivateKeyAccount;
let snapshotID: Hex;

const anvil = createTestClient({ mode: "anvil", chain: arbitrum, transport: http(FORK_URL) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kleros-disputant-fork-"));
  keyFile = join(dir, "disputant.key");
  writeFileSync(keyFile, DISPUTANT_KEY, "utf8");
  chmodSync(keyFile, 0o600);
  templateFile = join(dir, "template.json");
  writeFileSync(templateFile, JSON.stringify(TEMPLATE_T1), "utf8");
  client = createKlerosClient([FORK_URL], DEFAULT_DEPLOYMENT);
  disputant = privateKeyToAccount(DISPUTANT_KEY);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const base = () => ({
  rpcUrl: FORK_URL,
  keyFile,
  requireSigner: true as const,
  court: "1",
  jurors: "3",
  kit: "1",
  templateFile,
  maxCostEth: "0.02",
  broadcast: false,
});

function quote(extraData: Hex): Promise<bigint> {
  return client.readContract({
    address: contracts.klerosCore.address,
    abi: contracts.klerosCore.abi,
    functionName: "arbitrationCost",
    args: [extraData],
  }) as Promise<bigint>;
}

/** `getRoundInfo(id, 0)` — where the juror count the core actually recorded lives. */
async function roundZero(
  coreDisputeID: bigint,
): Promise<{ nbVotes: bigint; disputeKitID: bigint }> {
  return (await client.readContract({
    address: contracts.klerosCore.address,
    abi: contracts.klerosCore.abi,
    functionName: "getRoundInfo",
    args: [coreDisputeID, 0n],
  })) as { nbVotes: bigint; disputeKitID: bigint };
}

function coreDisputeIDFrom(logs: readonly { address: string }[]): bigint {
  const created = parseEventLogs({
    abi: contracts.klerosCore.abi,
    eventName: "DisputeCreation",
    logs: logs as never,
  }).filter((log) => log.address.toLowerCase() === contracts.klerosCore.address.toLowerCase());
  const first = created[0];
  if (first === undefined) throw new Error("no DisputeCreation log in the receipt");
  return (first.args as { _disputeID: bigint })._disputeID;
}

/**
 * Make **another arbitrable** create a dispute, breaking the coincidence that
 * makes local and core dispute IDs equal for all of production (`spec/01 §7`).
 *
 * Whitelisting is governance-only, so the governor is impersonated — the one
 * cheat code this suite uses, and it is used to reach a state Arbitrum One could
 * reach tomorrow rather than one it could not.
 */
async function seedForeignArbitrable(count: number): Promise<void> {
  const foreign = privateKeyToAccount(FOREIGN_ARBITRABLE_KEY);
  const governor = (await client.readContract({
    address: contracts.klerosCore.address,
    abi: contracts.klerosCore.abi,
    functionName: "governor",
  })) as Address;

  await anvil.impersonateAccount({ address: governor });
  await anvil.setBalance({ address: governor, value: 10n ** 20n });
  const whitelisted = await anvil.sendUnsignedTransaction({
    from: governor,
    to: contracts.klerosCore.address,
    // `eth_sendUnsignedTransaction` does not estimate, and an unset limit is
    // read as the block limit, which no balance covers.
    gas: 200_000n,
    data: encodeFunctionData({
      abi: contracts.klerosCore.abi,
      functionName: "changeArbitrableWhitelist",
      args: [foreign.address, true],
    }),
  });
  await client.waitForTransactionReceipt({ hash: whitelisted });
  await anvil.stopImpersonatingAccount({ address: governor });

  const wallet = createWalletClient({
    account: foreign,
    chain: arbitrum,
    transport: http(FORK_URL),
  });
  const cost = await quote(X1.blob as Hex);
  for (let i = 0; i < count; i++) {
    const hash = await wallet.writeContract({
      address: contracts.klerosCore.address,
      abi: contracts.klerosCore.abi,
      functionName: "createDispute",
      args: [2n, X1.blob as Hex],
      value: cost,
      chain: arbitrum,
    });
    await client.waitForTransactionReceipt({ hash });
  }
}

/** The first dispute the fork already holds in the `execution` period. */
async function findDisputeInExecution(): Promise<bigint> {
  for (let id = 1n; id <= 40n; id++) {
    const dispute = (await client.readContract({
      address: contracts.klerosCore.address,
      abi: contracts.klerosCore.abi,
      functionName: "disputes",
      args: [id],
    })) as readonly [bigint, Address, number, boolean, bigint];
    if (Number(dispute[2]) === 4) return id;
  }
  throw new Error("no dispute in the execution period in the first 40 — the fork looks wrong");
}

describe.skipIf(!FORK_READY)("fork — spec/05 §2", () => {
  beforeEach(async () => {
    snapshotID = await anvil.snapshot();
  });

  afterEach(async () => {
    await anvil.revert({ id: snapshotID });
  });

  /* --------------------------------------------------------------------- *
   * 1. `spec/05 §2.1` — a wrong court is refused, with nothing sent.
   * --------------------------------------------------------------------- */

  it(
    "refuses a deliberately wrong court ID and sends no transaction",
    async () => {
      const nonceBefore = await client.getTransactionCount({ address: disputant.address });
      const balanceBefore = await client.getBalance({ address: disputant.address });

      // `--broadcast` is passed deliberately. The refusal has to hold when the
      // operator asked to send, which is the only case that costs anything.
      const result = await runCreateDispute({ ...base(), court: "99", broadcast: true });

      expect(result.success).toBe(false);
      expect(result.success === false && result.code).toBe("COURT_OUT_OF_RANGE");

      // There is no revert to prove this: KlerosCore would have quoted 0.015 ETH
      // and created a General Court dispute without complaint (`spec/01 §4.4`).
      // The nonce is the proof, and the balance is the consequence.
      expect(await client.getTransactionCount({ address: disputant.address })).toBe(nonceBefore);
      expect(await client.getBalance({ address: disputant.address })).toBe(balanceBefore);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * 2. `spec/05 §2.2` — the value sent is the quote, exactly.
   * --------------------------------------------------------------------- */

  it(
    "sends exactly arbitrationCost, and the balance falls by exactly that plus gas",
    async () => {
      const cost = await quote(X1.blob as Hex);
      expect(cost).toBe(X1.costWei);

      const before = await client.getBalance({ address: disputant.address });
      const result = await runCreateDispute({ ...base(), broadcast: true });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.status).toBe("mined");
      expect(result.data.valueSent).toEqual({ wei: cost.toString(), eth: X1.costEth });

      const hash = result.data.txHash as Hex;
      const [sent, receipt, after] = await Promise.all([
        client.getTransaction({ hash }),
        client.getTransactionReceipt({ hash }),
        client.getBalance({ address: disputant.address }),
      ]);

      // The transaction's own `value` field, not the envelope's account of it.
      expect(sent.value).toBe(cost);

      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      expect(before - after).toBe(cost + gas);

      // The same arithmetic read the other way: nothing came back. Settles the
      // exact-payment half of `spec/appendix-a §2` claim 1; the overpayment half
      // is the next test.
      expect(before - after - gas).toBe(cost);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * 3. `spec/05 §2.3` — what the core does with an excess, observed.
   * --------------------------------------------------------------------- */

  it(
    "does not refund an overpayment — the excess buys extra jurors",
    async () => {
      const cost = await quote(X1.blob as Hex);
      const doubled = cost * 2n;

      // Deliberately **not** through `runCreateDispute`, which sends exactly the
      // quote and offers no way to ask for anything else (`spec/02 §2`). The
      // question is what the chain does, so the chain is asked directly through
      // the same broadcast path the CLI uses.
      const before = await client.getBalance({ address: disputant.address });
      const outcome = await simulateAndMaybeBroadcast({
        client,
        account: disputant,
        target: {
          address: contracts.disputeResolver.address,
          abi: contracts.disputeResolver.abi as Abi,
        },
        call: {
          functionName: "createDisputeForTemplate",
          args: [X1.blob as Hex, JSON.stringify(TEMPLATE_T1), NO_DATA_MAPPINGS, 2n],
        },
        value: doubled,
        broadcast: true,
        timeoutMs: TIMEOUT,
        balanceWei: before,
        rpcUrls: [FORK_URL],
        deployment: DEFAULT_DEPLOYMENT,
      });

      expect(outcome.success).toBe(true);
      if (!outcome.success || outcome.data.status !== "mined") throw new Error("not mined");

      const receipt = await client.getTransactionReceipt({ hash: outcome.data.txHash });
      const after = await client.getBalance({ address: disputant.address });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const round = await roundZero(coreDisputeIDFrom(receipt.logs));

      // The answer, and it is the expensive one. `spec/01 §3.2` carried this as
      // **[inferred]** until this test ran: the excess is not change, it is a
      // bigger panel nobody asked for and cannot give back.
      expect(round.nbVotes).toBe(6n);
      expect(before - after - gas).toBe(doubled);
      expect(doubled - (before - after - gas)).toBe(0n);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * 4. `spec/05 §2.4` — effective matches requested, read back from the core.
   * --------------------------------------------------------------------- */

  it(
    "echoes effective values that match X1, read back from KlerosCore",
    async () => {
      const result = await runCreateDispute({ ...base(), broadcast: true });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.effective).toEqual({ court: "1", jurors: "3", disputeKit: "1" });
      expect(result.data.requested).toEqual({ court: "1", jurors: "3", disputeKit: "1" });

      // Independently, from chain state rather than from the envelope — the
      // envelope is what is under test (`spec/05 §5` criterion 8).
      const coreDisputeID = BigInt(result.data.coreDisputeID as string);
      const dispute = (await client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "disputes",
        args: [coreDisputeID],
      })) as readonly [bigint, Address, number, boolean, bigint];
      const round = await roundZero(coreDisputeID);

      expect(dispute[0]).toBe(1n);
      expect(round.nbVotes).toBe(3n);
      expect(round.disputeKitID).toBe(1n);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * 5. `spec/05 §2.5` — the core dispute ID, on a fork where it can differ.
   * --------------------------------------------------------------------- */

  it(
    "reports the core dispute ID from the log, distinct from the arbitrable's local ID",
    async () => {
      // Three, so an off-by-one cannot look like agreement.
      await seedForeignArbitrable(3);

      const result = await runCreateDispute({ ...base(), broadcast: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const receipt = await client.getTransactionReceipt({ hash: result.data.txHash as Hex });
      const coreDisputeID = coreDisputeIDFrom(receipt.logs);

      // What `spec/05 §2.5` asks for: the reported ID is the core's own.
      expect(result.data.coreDisputeID).toBe(coreDisputeID.toString());

      // And the distinction is real here, which it is nowhere in production.
      const localID = (await client.readContract({
        address: contracts.disputeResolver.address,
        abi: contracts.disputeResolver.abi,
        functionName: "arbitratorDisputeIDToLocalID",
        args: [coreDisputeID],
      })) as bigint;
      expect(localID).not.toBe(coreDisputeID);

      // `DisputeRequest._externalDisputeID` is the arbitrable's local index —
      // `spec/appendix-a §2` claim 2, **[inferred]** and called unobservable in
      // production, settled here.
      const request = parseEventLogs({
        abi: contracts.disputeResolver.abi,
        eventName: "DisputeRequest",
        logs: receipt.logs,
      })[0];
      const args = request?.args as
        | { _arbitratorDisputeID: bigint; _externalDisputeID: bigint }
        | undefined;
      expect(args?._arbitratorDisputeID).toBe(coreDisputeID);
      expect(args?._externalDisputeID).toBe(localID);

      // **`createDisputeForTemplate` returns the CORE dispute ID, not the local
      // index.** `spec/01 §7` asserted the opposite as **[live]** until this
      // test ran, from a production reading that could not tell the two apart;
      // it now records the correction, and `spec/appendix-a §3.5` records how
      // the wrong marker got there. The CLI is unaffected — it never reads the
      // return value. Pinned here so the correction cannot quietly regress.
      const returned = (
        await client.simulateContract({
          address: contracts.disputeResolver.address,
          abi: contracts.disputeResolver.abi,
          functionName: "createDisputeForTemplate",
          args: [X1.blob as Hex, JSON.stringify(TEMPLATE_T1), NO_DATA_MAPPINGS, 2n],
          account: disputant,
          value: await quote(X1.blob as Hex),
        })
      ).result as bigint;
      expect(returned).toBe(coreDisputeID + 1n);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * `spec/appendix-a §2` claim 5 — not one of the seven, but settled by the
   * same receipt, and the appendix names a fork test as the way to settle it.
   * --------------------------------------------------------------------- */

  it(
    "emits DisputeCreation, DisputeRequest and DisputeTemplate in one transaction",
    async () => {
      const result = await runCreateDispute({ ...base(), broadcast: true });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const receipt = await client.getTransactionReceipt({ hash: result.data.txHash as Hex });
      const emitters = new Set(receipt.logs.map((log) => log.address.toLowerCase()));

      expect(emitters.has(contracts.klerosCore.address.toLowerCase())).toBe(true);
      expect(emitters.has(contracts.disputeResolver.address.toLowerCase())).toBe(true);
      expect(emitters.has(contracts.disputeTemplateRegistry.address.toLowerCase())).toBe(true);
    },
    TIMEOUT,
  );

  /* --------------------------------------------------------------------- *
   * 6. `spec/05 §2.6` — every revert row of `spec/01 §5`, named.
   * --------------------------------------------------------------------- */

  describe("revert decoding — every row of spec/01 §5", () => {
    /**
     * The first three are forced through `simulateAndMaybeBroadcast`, so what is
     * asserted is the refusal a caller would actually receive. None of them is
     * reachable through `runCreateDispute`: the template schema will not build a
     * one-option dispute, pre-flight refuses an unsupported kit before the chain
     * sees it, and the value is always the quote. Reaching them at all means
     * bypassing the guards that exist to prevent them.
     */
    async function refusal(
      args: readonly [Hex, string, string, bigint],
      value: bigint,
    ): Promise<{ code: string; message: string }> {
      const result = await simulateAndMaybeBroadcast({
        client,
        account: disputant,
        target: {
          address: contracts.disputeResolver.address,
          abi: contracts.disputeResolver.abi as Abi,
        },
        call: { functionName: "createDisputeForTemplate", args },
        value,
        broadcast: false,
        timeoutMs: TIMEOUT,
        balanceWei: await client.getBalance({ address: disputant.address }),
        rpcUrls: [FORK_URL],
        deployment: DEFAULT_DEPLOYMENT,
      });
      if (result.success) throw new Error("expected a revert");
      return { code: result.code, message: result.message };
    }

    const template = () => JSON.stringify(TEMPLATE_T1);

    it(
      "names DisputeResolver's own Error(string) for fewer than two ruling options",
      async () => {
        const cost = await quote(X1.blob as Hex);
        const { code, message } = await refusal(
          [X1.blob as Hex, template(), NO_DATA_MAPPINGS, 1n],
          cost,
        );
        expect(code).toBe("SIMULATION_REVERTED");
        // Not `ShouldBeAtLeastTwoRulingOptions()`. That error is in the package's
        // Solidity and is not what the deployment emits (`spec/01 §5`).
        expect(message).toContain("The template offers fewer than two ruling options");
      },
      TIMEOUT,
    );

    it(
      "names DisputeKitNotSupportedByCourt, forwarded from the core",
      async () => {
        // Kit 2 in court 1 — in range, so the decoder does not clamp it, and
        // unsupported, so the core reverts. Pre-flight refuses this first; the
        // point here is that the chain's own answer is named when it is reached.
        const kit2 = encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
          [1n, 3n, 2n],
        );
        const { code, message } = await refusal(
          [kit2, template(), NO_DATA_MAPPINGS, 2n],
          await quote(X1.blob as Hex),
        );
        expect(code).toBe("SIMULATION_REVERTED");
        expect(message).toContain("The court does not support the requested dispute kit");
      },
      TIMEOUT,
    );

    it(
      "names ArbitrationFeesNotEnough for one wei less than the quote",
      async () => {
        const cost = await quote(X1.blob as Hex);
        const { code, message } = await refusal(
          [X1.blob as Hex, template(), NO_DATA_MAPPINGS, 2n],
          cost - 1n,
        );
        expect(code).toBe("SIMULATION_REVERTED");
        expect(message).toContain("KlerosCore was sent less than arbitrationCost");
      },
      TIMEOUT,
    );

    it(
      "names ArbitrableNotWhitelisted when the core is called directly by an EOA",
      async () => {
        // The one row that is not on this CLI's write path at all: it is what
        // `DisputeResolver` exists to avoid (`spec/01 §3.1`). Decoded through
        // `reverts.ts` because no command can produce it.
        const cost = await quote(X1.blob as Hex);
        let decoded: ReturnType<typeof decodeRevert> | null = null;
        try {
          await client.simulateContract({
            address: contracts.klerosCore.address,
            abi: contracts.klerosCore.abi,
            functionName: "createDispute",
            args: [2n, X1.blob as Hex],
            account: disputant,
            value: cost,
          });
        } catch (cause) {
          decoded = decodeRevert(cause);
        }
        expect(decoded?.reason).toBe("ArbitrableNotWhitelisted");
        expect(decoded?.data).toBe("0x203b0c18");
        expect(decoded?.guidance).toContain("whitelisted arbitrable");
      },
      TIMEOUT,
    );
  });

  /* --------------------------------------------------------------------- *
   * 7. `spec/05 §2.7` — the evidence path: one refusal, one warning.
   * --------------------------------------------------------------------- */

  describe("submit-evidence", () => {
    const evidence = () => ({
      rpcUrl: FORK_URL,
      keyFile,
      requireSigner: true as const,
      name: "Delivery photographs",
      description: "The package arrived damaged; see the attached photographs.",
      broadcast: false,
    });

    it(
      "refuses a core dispute ID no dispute uses, and sends nothing",
      async () => {
        const nonceBefore = await client.getTransactionCount({ address: disputant.address });
        const result = await runSubmitEvidence({
          ...evidence(),
          dispute: "999999",
          broadcast: true,
        });

        expect(result.success).toBe(false);
        expect(result.success === false && result.code).toBe("DISPUTE_NOT_FOUND");
        // The harm this refusal prevents is unreachability, not loss: the module
        // has no access control and would have accepted it (ADR-0011).
        expect(await client.getTransactionCount({ address: disputant.address })).toBe(nonceBefore);
      },
      TIMEOUT,
    );

    it(
      "warns and proceeds against a dispute in the execution period",
      async () => {
        const inExecution = await findDisputeInExecution();
        const result = await runSubmitEvidence({
          ...evidence(),
          dispute: inExecution.toString(),
          broadcast: true,
        });

        // Proceeds. `submitEvidence` has no period gate, so period discipline is
        // this CLI's own policy and that policy is to warn (ADR-0011).
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.status).toBe("mined");
        expect(result.data.period).toBe("execution");
        expect(result.data.secondsRemaining).toBeNull();
        expect(result.data.evidenceBytes).toBe(106);

        const warnings = result.data.warnings as string[];
        expect(warnings.some((w) => w.includes("the evidence period is over"))).toBe(true);

        // The bytes reached the chain verbatim — the whole of ADR-0007's promise.
        // E1, byte for byte, from `spec/02 §4.4`.
        const receipt = await client.getTransactionReceipt({ hash: result.data.txHash as Hex });
        const emitted = parseEventLogs({
          abi: contracts.evidenceModule.abi,
          eventName: "Evidence",
          logs: receipt.logs,
        }).filter(
          (log) => log.address.toLowerCase() === contracts.evidenceModule.address.toLowerCase(),
        );
        const args = emitted[0]?.args as
          | { _externalDisputeID: bigint; _party: Address; _evidence: string }
          | undefined;
        // Relational, not equality-with-the-core-ID: what the module must receive
        // is the arbitrable's **local** dispute ID (`spec/02 §4.2`, ADR-0014).
        // On a fork of Arbitrum One the two coincide for every dispute, so
        // asserting `inExecution` here would pass whichever one the CLI sent —
        // which is exactly how the defect survived. Reading the mapping back
        // makes the assertion say what it means, and it will separate the day a
        // second arbitrable files on this deployment.
        const localID = (await client.readContract({
          address: contracts.disputeResolver.address,
          abi: contracts.disputeResolver.abi,
          functionName: "arbitratorDisputeIDToLocalID",
          args: [inExecution],
        })) as bigint;
        expect(args?._externalDisputeID).toBe(localID);
        expect(args?._party).toBe(disputant.address);
        expect(args?._evidence).toBe(JSON.stringify(EVIDENCE_VECTORS[0].document));
      },
      TIMEOUT,
    );
  });
});
