import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex, PublicClient } from "viem";
import { BaseError, ContractFunctionRevertedError, formatEther, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_VECTORS, TEMPLATE_T1 } from "../core/__tests__/vectors.js";
import { createKlerosClient } from "../core/client.js";
import { contractsFor } from "../core/deployment.js";
import { DEPLOYMENTS } from "../core/deployments.js";

/**
 * The acceptance test — `spec/05 §3`, ticket 05.
 *
 * A full lifecycle against the **live v2 testnet**: quote, simulate, create,
 * submit evidence, report status. Every step runs **in a separate process,
 * through the built binary** (`dist/cli.js`) rather than the modules, because
 * this is the rehearsal for the first Arbitrum One broadcast and what is being
 * rehearsed is the whole path — argv parsing, the envelope, the signing path,
 * the endpoint and the receipt — not the parts of it that unit tests can reach.
 * It runs **before** that broadcast so the broadcast is a confirmation rather
 * than an experiment.
 *
 * **Each run broadcasts permanently.** It creates a real dispute on the v2
 * testnet and pays a real (small) testnet arbitration fee from a real key.
 * Nothing here can be undone, and re-running creates another dispute. That is
 * why it is a **release gate, not a CI job**: nothing in continuous integration
 * depends on a funded key or on testnet availability, and the suite refuses to
 * touch the network at all unless the script that is running is
 * `pnpm test:acceptance` itself.
 *
 * **Assertions are relational, never pinned** (`spec/05 §3`). A live chain
 * moves: the fee, the court tree and the period lengths are the deployment's
 * own and it is free to change them, and every number written down in this
 * document set is `arbitrum-one`'s. So the court is resolved from chain state
 * rather than assumed, the cost is whatever the deployment quotes at the moment
 * it is asked, and the ceiling is derived from that quote. The one pinned
 * values are the evidence vector's own bytes, which are ours and not the
 * chain's.
 *
 * **There is no `evm_revert` here.** The fork suite buys order-independence
 * with a snapshot pair (`spec/05 §2`); this one cannot, so the tests are
 * ordered and strictly additive, and each depends on what the previous one put
 * on chain. Vitest runs a file's tests in order, and the shared state is the
 * two module-scope `let`s below.
 */

const DEPLOYMENT = DEPLOYMENTS["arbitrum-sepolia-testnet"];
const contracts = contractsFor(DEPLOYMENT);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The **built** binary, not `src/cli.ts` under tsx. `chain-option.test.ts` runs
 * the source because it is asking what the surface renders; this suite is
 * asking whether the artefact a user installs works, so the bundle — and every
 * bundler alias it resolves (`build-alias.test.ts`) — is what has to run.
 */
const CLI = join(repoRoot, "dist", "cli.js");

/**
 * The opt-in, and it is **the name of the script that is running**, never an
 * environment variable.
 *
 * An `KLEROS_ACCEPTANCE=1` would have been inheritable: exported once while
 * iterating on this file, or set by a CI job or a `direnv` block, it silently
 * arms every later `pnpm test` in that shell — and `prepublishOnly` runs
 * `pnpm test`, so publishing would broadcast. That is the same invisible input
 * ADR-0016 refuses for `--chain`, on a switch that spends money rather than one
 * that picks an endpoint, so it gets the same answer: the invocation says it or
 * nobody does.
 *
 * `npm_lifecycle_event` is set by the package manager to the script it is
 * running, per process. `pnpm test` sets `test`; only `pnpm test:acceptance`
 * sets this. Running the file directly through vitest is therefore inert by
 * design — go through the script, which is also what builds the binary.
 */
const OPTED_IN = process.env.npm_lifecycle_event === "test:acceptance";

/** Overridable so the key need not live at the default path. */
const KEY_FILE =
  process.env.KLEROS_ACCEPTANCE_KEY_FILE ?? join(homedir(), ".kleros-disputant", "key");

/**
 * Transport only, per ADR-0016: the deployment is chosen by `--chain` on every
 * invocation below and by nothing else. Read here so the suite and the child
 * processes it spawns measure the same endpoint.
 */
const RPC_URL = process.env[DEPLOYMENT.rpcUrlVariable] ?? DEPLOYMENT.defaultRpcUrl;

/** E1 — `spec/02 §4.4`, the vector whose exact bytes the emitted log must carry. */
const E1 = EVIDENCE_VECTORS[0];

/** E1's serialisation, transcribed from `spec/02 §4.4` rather than rebuilt here. */
const E1_JSON =
  '{"name":"Delivery photographs","description":"The package arrived damaged; see the attached photographs."}';

/** Generous: a live endpoint, a real mempool and a receipt to wait for. */
const TIMEOUT = 180_000;

/**
 * Gas units the funding check must cover: the create and the evidence
 * submission together, generously.
 *
 * **Arbitrum charges the L1 data cost by inflating `gasUsed`, not the gas
 * price**, and `createDisputeForTemplate` carries a ~550-byte template string
 * as calldata — so the real figure is dominated by a term that has nothing to
 * do with computation and moves with L1. A budget that is merely plausible
 * buys the worst outcome this suite has: readiness passes, the create is paid
 * for, and `submit-evidence` then fails for want of gas, leaving a real dispute
 * on chain with no evidence against it and a red suite that cannot be re-run
 * from where it stopped. Over-reserving costs nothing — this only decides
 * whether to skip — so it is deliberately several times the observed cost.
 */
const GAS_BUDGET = 12_000_000n;

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

type Readiness =
  | { ready: true; account: Address; court: string; costWei: bigint }
  | { ready: false; why: string };

/**
 * Resolve a court **from chain state** rather than assuming one. `spec/05 §3.1`
 * says the court must exist *on that deployment*; court 1 is the General Court
 * on both deployments today, but "today" is the word that makes assuming it
 * wrong, so it is checked and the search widens if it ever stops being true.
 */
async function resolveCourt(client: PublicClient): Promise<string | undefined> {
  for (let id = 1n; id <= 10n; id++) {
    try {
      const court = (await client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "courts",
        args: [id],
      })) as readonly unknown[];
      const disabled = court[6] as boolean;
      const supported = (await client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "isSupported",
        args: [id, 1n],
      })) as boolean;
      if (!disabled && supported) return id.toString();
    } catch (error) {
      // **Only a revert is a fact about the court tree.** A court ID past the
      // end of it panics, and that is the one error worth swallowing: keep
      // looking, because a disabled court is a gap and not the end. Anything
      // else — a rate limit from the public endpoint, a timeout — is a fact
      // about the endpoint, and swallowing it would report "no enabled court
      // supporting dispute kit 1 on this deployment": a claim about the chain,
      // made from a network fault, which is exactly the misdiagnosis
      // `spec/05 §3` forbids. Let it reach the transport branch instead.
      const reverted =
        error instanceof BaseError &&
        error.walk((cause) => cause instanceof ContractFunctionRevertedError) !== null;
      if (!reverted) throw error;
    }
  }
  return undefined;
}

/**
 * Every prerequisite, checked cheapest first so the network is reached only
 * once everything local has passed. Each failure returns its own sentence: an
 * unfunded key and a missing build are different problems and "skipped" is not
 * a diagnosis.
 */
async function readiness(): Promise<Readiness> {
  if (!OPTED_IN) {
    return {
      ready: false,
      why: "not opted in. This suite broadcasts permanently on the live v2 testnet and creates real disputes. Run: pnpm test:acceptance",
    };
  }

  if (!existsSync(CLI)) {
    return { ready: false, why: `no built binary at ${relative(repoRoot, CLI)}. Run: pnpm build` };
  }

  if (!existsSync(KEY_FILE)) {
    return {
      ready: false,
      why: `no signing key at ${KEY_FILE}. Point KLEROS_ACCEPTANCE_KEY_FILE at a funded v2 testnet key, mode 0600.`,
    };
  }

  let account: Address;
  try {
    account = privateKeyToAccount(readKey()).address;
  } catch {
    // Deliberately says nothing about the file's contents.
    return { ready: false, why: `the key at ${KEY_FILE} could not be read as a private key.` };
  }

  const client = createKlerosClient([RPC_URL], DEPLOYMENT);

  let costWei: bigint;
  let court: string | undefined;
  let balance: bigint;
  let gasPrice: bigint;
  try {
    const chainId = await client.getChainId();
    if (chainId !== DEPLOYMENT.chainId) {
      return {
        ready: false,
        why: `${RPC_URL} answered chain ${chainId}, not ${DEPLOYMENT.chainId}. Nothing was sent.`,
      };
    }

    const code = await client.getCode({ address: contracts.klerosCore.address });
    if (code === undefined || code === "0x") {
      return {
        ready: false,
        why: `no KlerosCore at ${contracts.klerosCore.address} on ${RPC_URL}; this endpoint does not serve the v2 testnet.`,
      };
    }

    court = await resolveCourt(client);
    if (court === undefined) {
      return { ready: false, why: "no enabled court supporting dispute kit 1 on this deployment." };
    }

    [costWei, balance, gasPrice] = await Promise.all([
      client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "arbitrationCost",
        args: [extraDataFor(court)],
      }) as Promise<bigint>,
      client.getBalance({ address: account }),
      client.getGasPrice(),
    ]);
  } catch (error) {
    return { ready: false, why: `${RPC_URL} is not answering: ${(error as Error).message}` };
  }

  // Relational, like every other number here: the fee this deployment quotes
  // right now, plus enough gas for both broadcasts. Doubling the fee leaves
  // room for it to move between this check and the create.
  const required = costWei * 2n + gasPrice * GAS_BUDGET;
  if (balance < required) {
    return {
      ready: false,
      why: `${account} holds ${formatEther(balance)} ETH on the v2 testnet and this suite needs about ${formatEther(required)}. Fund it and re-run.`,
    };
  }

  return { ready: true, account, court, costWei };
}

/** X1's shape at the resolved court: 3 jurors, Classic (`spec/02 §1.3`). */
function extraDataFor(court: string): Hex {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  return `0x${word(BigInt(court))}${word(3n)}${word(1n)}`;
}

/**
 * Read once, held in memory, **never logged**. It exists here for exactly two
 * purposes: deriving the address whose balance and nonce the assertions read,
 * and giving `assertNoSecret` something to look for.
 */
function readKey(): Hex {
  return readFileSync(KEY_FILE, "utf8").trim() as Hex;
}

const READY = await readiness();

if (!READY.ready) {
  // Visible in the run output rather than silently green.
  console.warn(`[acceptance] ${READY.why}`);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let rootDir: string;
let workDir: string;
let fixtureDir: string;
let fakeHome: string;
let childTmp: string;
let templateFile: string;
let client: PublicClient;
let secret: string;

/** Set by the create test and read by everything after it. */
let coreDisputeID: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "kleros-disputant-acceptance-"));
  workDir = join(rootDir, "cwd");
  fixtureDir = join(rootDir, "fixtures");
  fakeHome = join(rootDir, "home");
  childTmp = join(rootDir, "tmp");
  for (const path of [workDir, fixtureDir, fakeHome, childTmp])
    mkdirSync(path, { recursive: true });

  // The arbitrator fields are omitted so the template is the *deployment's*:
  // T1 states Arbitrum One's arbitrator, and handing that to the testnet is a
  // refusal, correctly (`spec/02 §3.2`, ticket 07).
  const { arbitratorChainID, arbitratorAddress, ...portable } = TEMPLATE_T1;
  templateFile = join(fixtureDir, "template.json");
  writeFileSync(templateFile, JSON.stringify(portable), "utf8");
  chmodSync(templateFile, 0o600);

  client = createKlerosClient([RPC_URL], DEPLOYMENT);
  secret = READY.ready ? readKey() : "";
});

afterAll(() => {
  if (rootDir !== undefined) rmSync(rootDir, { recursive: true, force: true });
});

type Snapshot = readonly string[];

/** Path, size and mtime for every file under a root, sorted. */
function snapshot(root: string): Snapshot {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${relative(root, full)}/`);
        walk(full);
      } else {
        const stat = statSync(full);
        entries.push(`${relative(root, full)} ${stat.size} ${stat.mtimeMs} ${stat.mode}`);
      }
    }
  };
  walk(root);
  return entries;
}

/**
 * Everywhere the child could plausibly write. Its working directory is empty
 * and stays empty; its `HOME`, `XDG_CONFIG_HOME` and `TMPDIR` are redirected
 * into this tree so that a config file, a cache or a scratch file would land
 * somewhere this sees; and the two files it is *given* — the key and the
 * template — are watched for modification in place.
 *
 * This is the honest scope of "nothing was written to disk": it is not a
 * syscall trace. What it proves is that a tool handed a key and a template
 * wrote nowhere it would naturally write, and changed neither file it was
 * given.
 */
function diskSnapshot(): { tree: Snapshot; key: string } {
  const stat = statSync(KEY_FILE);
  return {
    tree: [
      ...snapshot(workDir).map((line) => `cwd/${line}`),
      ...snapshot(fixtureDir).map((line) => `fixtures/${line}`),
      ...snapshot(fakeHome).map((line) => `home/${line}`),
      ...snapshot(childTmp).map((line) => `tmp/${line}`),
    ],
    key: `${stat.size} ${stat.mtimeMs} ${stat.mode}`,
  };
}

/**
 * **Never `expect(output).not.toContain(secret)`.** A failing `not.toContain`
 * prints its expected substring, so the assertion that catches a leaked key
 * would itself print the key — into a terminal, a CI log and a bug report. The
 * comparison is reduced to a boolean before it reaches `expect`.
 */
function assertNoSecret(where: string, combined: string): void {
  const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
  const needles = [secret, bare, bare.toLowerCase(), bare.toUpperCase()].filter(
    (needle) => needle.length > 0,
  );
  const leaked = needles.some((needle) => combined.includes(needle));
  expect(leaked, `${where} leaked key material into its output`).toBe(false);
}

/**
 * `execFile`'s error carries the exit status in three different shapes, and the
 * obvious `error.code ?? 0` reads two of them as a clean exit: a spawn failure
 * puts a **string** there (`ENOENT`), and a child killed by the `timeout`
 * option leaves it `undefined` and sets `killed`. Anything that is not a
 * numeric status is reported as `1` rather than as success.
 */
function exitStatusOf(error: unknown): number {
  if (error === null || error === undefined) return 0;
  const { code, killed } = error as { code?: number | string; killed?: boolean };
  if (killed === true) return 1;
  return typeof code === "number" ? code : 1;
}

type Run = {
  exitCode: number;
  stdout: string;
  stderr: string;
  // The consuming agent sees one buffer and a binary exit status (`spec/03 §5`).
  combined: string;
  json: Record<string, unknown>;
};

/** Every invocation the suite makes, for the summary assertions at the end. */
const transcript: Run[] = [];

/**
 * One command, one process, one envelope — and the two standing assertions
 * applied to **every** invocation rather than to a chosen one. Putting them
 * here rather than in a test of their own is deliberate: a test can only assert
 * about the runs it remembers to make, and the requirement is about all of
 * them.
 */
function runCli(args: readonly string[]): Promise<Run> {
  const before = diskSnapshot();

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args, "--chain", DEPLOYMENT.slug, "--rpc-url", RPC_URL, "--format", "json"],
      {
        cwd: workDir,
        // Deliberately minimal, and deliberately without the key: it is never
        // accepted from the environment, and this is where that would show.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fakeHome,
          XDG_CONFIG_HOME: join(fakeHome, ".config"),
          TMPDIR: childTmp,
        },
        maxBuffer: 8 * 1024 * 1024,
        timeout: TIMEOUT,
      },
      (error, stdout, stderr) => {
        // **Every path out of this callback must settle the promise.** An
        // `expect` that throws here is not inside the executor, so nothing
        // catches it and nothing rejects: the failure would surface as a
        // per-test timeout minutes later rather than as the assertion that
        // actually fired. Found by falsifying `assertNoSecret` and watching a
        // leak report itself as a hang.
        try {
          const combined = `${stdout}${stderr}`;
          assertNoSecret(args[0] ?? "cli", combined);

          const after = diskSnapshot();
          expect(after.tree, `${args[0]} wrote to disk`).toEqual(before.tree);
          expect(after.key, `${args[0]} modified the key file`).toBe(before.key);

          let json: Record<string, unknown>;
          try {
            json = JSON.parse(stdout) as Record<string, unknown>;
          } catch {
            throw new Error(`${args.join(" ")} printed no JSON envelope.\n${combined}`);
          }

          const run: Run = { exitCode: exitStatusOf(error), stdout, stderr, combined, json };

          // The one place this contract can be checked at all: `spec/03 §5`
          // makes the exit status part of what the consuming agent sees, and
          // this is the only suite that runs the built binary in a real
          // process. Every invocation the lifecycle makes is a success path.
          expect(run.exitCode, `${args[0]} exited non-zero`).toBe(0);

          transcript.push(run);
          resolve(run);
        } catch (failure) {
          reject(failure as Error);
        }
      },
    );
  });
}

function field<T>(run: Run, key: string): T {
  return run.json[key] as T;
}

/**
 * A read that follows a broadcast, retried.
 *
 * The CLI already waited for the receipt, so the block exists — but the
 * endpoint behind `RPC_URL` is a load balancer over many nodes, and the next
 * read can land on one that has not caught up and throw
 * `TransactionNotFoundError`. That would fail the test **after** the
 * arbitration fee was spent, which is the wrong price for a lagging replica.
 * A fork on `127.0.0.1` cannot show this, which is why it is written here
 * rather than discovered on the first live run. This deployment's public
 * endpoint has already been observed dropping data this repo asked for
 * (`deployments.ts`).
 */
async function settled<T>(read: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await read();
    } catch (error) {
      last = error;
      await new Promise((resume) => setTimeout(resume, 1_000));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

describe.skipIf(!READY.ready)("acceptance — the live v2 testnet, spec/05 §3", () => {
  const court = READY.ready ? READY.court : "1";
  const account = READY.ready ? READY.account : ("0x" as Address);

  const createArgs = (extra: readonly string[]): string[] => [
    "create-dispute",
    "--court",
    court,
    "--jurors",
    "3",
    "--kit",
    "1",
    "--template-file",
    templateFile,
    ...extra,
  ];

  /**
   * §3.1. The court is resolved rather than assumed, and the quote is whatever
   * this deployment says today — asserted only against itself, twice.
   */
  it(
    "quotes a court that exists on this deployment, and quotes it the same twice",
    async () => {
      const first = await runCli(["arbitration-cost", "--court", court, "--jurors", "3"]);

      expect(first.json.ok).toBe(true);
      expect(first.json.deployment).toBe(DEPLOYMENT.slug);
      expect(first.json.chainId).toBe(DEPLOYMENT.chainId);
      expect(field<{ court: string }>(first, "requested").court).toBe(court);

      const quoted = BigInt(field<{ wei: string }>(first, "arbitrationCost").wei);
      expect(quoted).toBeGreaterThan(0n);

      // The court the CLI priced is one the chain actually holds, and it holds
      // it enabled and supporting the kit that was asked for.
      const onChain = (await client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "courts",
        args: [BigInt(court)],
      })) as readonly unknown[];
      expect(onChain[6]).toBe(false);

      const second = await runCli(["arbitration-cost", "--court", court, "--jurors", "3"]);
      expect(field<{ wei: string }>(second, "arbitrationCost").wei).toBe(quoted.toString());
    },
    TIMEOUT,
  );

  /**
   * §3.2. The default is plan → simulate → stop (ADR-0004). The proof that
   * nothing was sent is the nonce, and the balance is the consequence.
   */
  it(
    "simulates create-dispute and sends nothing",
    async () => {
      const nonceBefore = await client.getTransactionCount({ address: account });
      const balanceBefore = await client.getBalance({ address: account });

      const quote = await runCli(["arbitration-cost", "--court", court, "--jurors", "3"]);
      const ceiling = ceilingFor(quote);

      const result = await runCli(createArgs(["--key-file", KEY_FILE, "--max-cost-eth", ceiling]));

      expect(result.json.ok).toBe(true);
      expect(result.json.status).toBe("simulated");
      expect(result.json.broadcast).toBe(false);
      expect(result.json.message).toContain("SIMULATION ONLY");
      // The simulate branch carries no receipt fields at all.
      expect(result.json).not.toHaveProperty("txHash");
      expect(result.json).not.toHaveProperty("coreDisputeID");

      expect(await client.getTransactionCount({ address: account })).toBe(nonceBefore);
      expect(await client.getBalance({ address: account })).toBe(balanceBefore);
    },
    TIMEOUT,
  );

  /**
   * §3.3. The first broadcast. The value sent is the quote **exactly** — read
   * off the transaction rather than out of the envelope's account of it,
   * because an envelope that echoed its input would pass either way — and the
   * reported core dispute ID is looked up on chain.
   */
  it(
    "creates the dispute, sending exactly the quote",
    async () => {
      const quote = await runCli(["arbitration-cost", "--court", court, "--jurors", "3"]);
      const quotedWei = field<{ wei: string }>(quote, "arbitrationCost").wei;

      const balanceBefore = await client.getBalance({ address: account });

      const result = await runCli(
        createArgs([
          "--key-file",
          KEY_FILE,
          "--max-cost-eth",
          ceilingFor(quote),
          // Bare, never `--broadcast true`: incur's boolean flags drop a
          // following word in silence (`boolean-flags.test.ts`).
          "--broadcast",
        ]),
      );

      expect(result.json.ok).toBe(true);
      expect(result.json.status).toBe("mined");
      expect(result.json.broadcast).toBe(true);

      // The envelope's own account of the cost equals what was quoted
      // immediately before it.
      expect(field<{ wei: string }>(result, "valueSent").wei).toBe(quotedWei);
      expect(field<{ wei: string }>(result, "arbitrationCost").wei).toBe(quotedWei);

      const txHash = field<Hex>(result, "txHash");
      const transaction = await settled(() => client.getTransaction({ hash: txHash }));
      // The chain's account of it, which is the one that spent the money.
      expect(transaction.value).toBe(BigInt(quotedWei));
      expect(transaction.to?.toLowerCase()).toBe(contracts.disputeResolver.address.toLowerCase());
      expect(transaction.from.toLowerCase()).toBe(account.toLowerCase());

      coreDisputeID = field<string>(result, "coreDisputeID");

      // The reported ID resolves on chain, to a dispute this deployment's
      // DisputeResolver created in the court that was asked for.
      const dispute = (await client.readContract({
        address: contracts.klerosCore.address,
        abi: contracts.klerosCore.abi,
        functionName: "disputes",
        args: [BigInt(coreDisputeID)],
      })) as readonly unknown[];
      expect((dispute[0] as bigint).toString()).toBe(court);
      expect((dispute[1] as Address).toLowerCase()).toBe(
        contracts.disputeResolver.address.toLowerCase(),
      );

      // `effective`, not `requested` — the difference is the whole point of
      // echoing it (`spec/01 §4.4`).
      expect(result.json.effective).toEqual({ court, jurors: "3", disputeKit: "1" });

      // The fee is gone and is never refunded (`spec/01 §3.2`). Gas makes the
      // exact figure unpredictable on a live chain, so this is the direction,
      // not the arithmetic — `spec/05 §2.2` pins the arithmetic on a fork.
      const balanceAfter = await client.getBalance({ address: account });
      expect(balanceBefore - balanceAfter).toBeGreaterThanOrEqual(BigInt(quotedWei));
    },
    TIMEOUT,
  );

  /**
   * §3.4, and the assertion this deployment exists to make possible. The
   * evidence is filed under the **local** dispute ID, and on the testnet the
   * two identifiers have already separated — a second arbitrable has filed
   * here — so an assertion against the core ID passed in would fail rather than
   * pass by coincidence, which is exactly how the defect in ADR-0014 survived
   * on Arbitrum One.
   */
  it(
    "submits evidence under the local dispute ID, with E1's bytes verbatim",
    async () => {
      expect(coreDisputeID, "the create test must have run first").toBeDefined();

      const result = await runCli([
        "submit-evidence",
        "--dispute",
        coreDisputeID,
        "--name",
        E1.document.name,
        "--description",
        E1.document.description,
        "--key-file",
        KEY_FILE,
        "--broadcast",
      ]);

      expect(result.json.ok).toBe(true);
      expect(result.json.status).toBe("mined");
      expect(result.json.evidenceBytes).toBe(E1.byteLength);

      // The caller is shown the identifier they gave, and never the other one
      // (ADR-0014, `spec/05 §1.6a`).
      expect(result.json.coreDisputeID).toBe(coreDisputeID);
      expect(result.json).not.toHaveProperty("localDisputeID");

      const evidenceTxHash = field<Hex>(result, "txHash");
      const receipt = await settled(() => client.getTransactionReceipt({ hash: evidenceTxHash }));

      const logs = parseEventLogs({
        abi: contracts.evidenceModule.abi,
        eventName: "Evidence",
        logs: receipt.logs,
      }).filter(
        (log) => log.address.toLowerCase() === contracts.evidenceModule.address.toLowerCase(),
      );
      expect(logs).toHaveLength(1);
      const args = logs[0]?.args as {
        _externalDisputeID: bigint;
        _party: Address;
        _evidence: string;
      };

      // The exact bytes, not a hash of them and not a length.
      expect(args._evidence).toBe(E1_JSON);
      expect(Buffer.byteLength(args._evidence, "utf8")).toBe(E1.byteLength);
      expect(args._party.toLowerCase()).toBe(account.toLowerCase());

      // What the module was actually given, against what the mapping says.
      const localDisputeID = (await client.readContract({
        address: contracts.disputeResolver.address,
        abi: contracts.disputeResolver.abi,
        functionName: "arbitratorDisputeIDToLocalID",
        args: [BigInt(coreDisputeID)],
      })) as bigint;

      expect(args._externalDisputeID).toBe(localDisputeID);
      // The teeth. A failure here is a question about the deployment — the two
      // identifiers re-converging would mean this arbitrable is the only one
      // filing again — never a number to update.
      expect(localDisputeID).not.toBe(BigInt(coreDisputeID));
    },
    TIMEOUT,
  );

  /** §3.5. A dispute created moments ago is in the period evidence can reach. */
  it(
    "reports the dispute in the evidence period",
    async () => {
      expect(coreDisputeID, "the create test must have run first").toBeDefined();

      const result = await runCli(["status", "--dispute", coreDisputeID]);

      expect(result.json.ok).toBe(true);
      expect(result.json.coreDisputeID).toBe(coreDisputeID);
      expect(result.json.court).toBe(court);
      expect(result.json.period).toBe("evidence");
      expect(result.json.ruled).toBe(false);
      expect(BigInt(field<string>(result, "secondsRemaining"))).toBeGreaterThan(0n);
    },
    TIMEOUT,
  );

  /**
   * The two standing assertions of `spec/05 §3`, restated as a test so the
   * requirement is visible in the run output. `runCli` has already applied both
   * to every invocation individually — this is the one that fails if the suite
   * ever stops making invocations at all.
   */
  it("leaked no key material and wrote nothing to disk, across every invocation", () => {
    expect(transcript.length).toBeGreaterThanOrEqual(5);
    for (const run of transcript) assertNoSecret("the lifecycle", run.combined);
    expect(snapshot(workDir)).toEqual([]);
    expect(snapshot(fakeHome)).toEqual([]);
    expect(snapshot(childTmp)).toEqual([]);
  });
});

/** Twice the live quote, in ETH. Relational: nothing here is a pinned number. */
function ceilingFor(quote: Run): string {
  const wei = BigInt((quote.json.arbitrationCost as { wei: string }).wei);
  return formatEther(wei * 2n);
}
