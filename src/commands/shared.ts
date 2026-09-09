import { z } from "incur";
import type { PrivateKeyAccount, PublicClient } from "viem";
import { createKlerosClient, parseRpcUrls, startup } from "../core/client.js";
import type { DeploymentContracts } from "../core/deployment.js";
import {
  DEFAULT_DEPLOYMENT_SLUG,
  DEPLOYMENTS,
  type Deployment,
  type DeploymentSlug,
  resolveDeployment,
} from "../core/deployments.js";
import { type ErrorCode, type KlerosResult, ok } from "../core/result.js";
import { loadSigner } from "../core/signer.js";

/**
 * The command layer's shared spine — `spec/03 §4`, `§6`, `§8`.
 *
 * `src/core/` is framework-free and returns `KlerosResult`. **This directory
 * owns incur, exit codes and CTA blocks, and nothing else does.** `run(c)`
 * contains no logic: it maps options to a core call and hands the result to
 * `finish`, which is the entire core→incur seam (`spec/03 §8`). Keeping that
 * seam one function wide is what lets `src/core/` move into `@kleros/agentkit`
 * as close to a file move as possible (ADR-0001).
 */

/**
 * `spec/03 §4`, exhaustive over `ErrorCode` by type.
 *
 * **`Record<ErrorCode, number>`, not `Record<string, number>` with a `?? 1`
 * default.** The juror CLI has two codes that fall through its default; nothing
 * is broken by it today, and that is exactly why it went unnoticed for the whole
 * of that project's life. Written this way, the next code added to the union is
 * a compile error here until it has been given a meaning.
 *
 * Exit codes are for shell callers and are **not** the machine contract: the
 * consuming agent sees an effectively binary status, so it branches on the
 * payload's `code` (`spec/03 §4`). The five buckets are therefore coarse, and
 * four placements are worth stating:
 *
 * - The three `FILE_*` codes are **1**: every one of them is refused before a
 *   request is made, so they are validation in the same sense as a bad court ID.
 * - `UPLOAD_FAILED` and `UPLOAD_MISMATCH` are **2**, which is why that bucket is
 *   "chain, RPC **or upload-service** failure". Neither can mean money was
 *   spent — `upload-file` holds no key.
 * - `BROADCAST_FAILED` is **2**, not 3. The node refused the signed transaction,
 *   so nothing was submitted and nothing reverted — there is no hash to check.
 * - `EFFECTIVE_MISMATCH` and `TRANSACTION_REVERTED` are **3**, the only bucket
 *   that does not imply nothing was sent. A mismatch is not a revert, but it is
 *   a transaction whose outcome is wrong, and reading it as validation (1) would
 *   tell a caller the money is still theirs.
 */
const EXIT_CODES: Record<ErrorCode, number> = {
  // 1 — validation or refusal. Nothing was sent.
  NUMBER_INVALID: 1,
  COURT_OUT_OF_RANGE: 1,
  COURT_DISABLED: 1,
  JURORS_INVALID: 1,
  DISPUTE_KIT_OUT_OF_RANGE: 1,
  DISPUTE_KIT_NOT_SUPPORTED: 1,
  TEMPLATE_INVALID: 1,
  RULING_OPTIONS_INVALID: 1,
  POLICY_URI_INVALID: 1,
  EVIDENCE_INVALID: 1,
  COST_CEILING_EXCEEDED: 1,
  INSUFFICIENT_BALANCE: 1,
  DISPUTE_NOT_FOUND: 1,
  DISPUTE_NOT_ADDRESSABLE: 1,
  FILE_UNREADABLE: 1,
  FILE_EMPTY: 1,
  FILE_TOO_LARGE: 1,
  // Refused at `spec/03 §7` step 1, before an endpoint is even constructed. It
  // is validation in the same sense as a bad court ID, and deliberately not 2:
  // nothing about the network was learned, because nothing was contacted.
  CHAIN_NOT_SUPPORTED: 1,
  // 2 — chain, RPC or upload-service failure. Nothing was judged, so nothing can
  // be concluded. Neither upload code can mean money was spent: `upload-file`
  // never signs.
  WRONG_CHAIN: 2,
  DEPLOYMENT_INCONSISTENT: 2,
  RPC_ERROR: 2,
  BROADCAST_FAILED: 2,
  UPLOAD_FAILED: 2,
  UPLOAD_MISMATCH: 2,
  // 3 — the transaction, or its outcome, went wrong.
  SIMULATION_REVERTED: 3,
  TRANSACTION_REVERTED: 3,
  EFFECTIVE_MISMATCH: 3,
  // 4 — signer or key failure.
  KEY_FILE_MISSING: 4,
  KEY_FILE_PERMISSIONS: 4,
  KEY_FILE_UNREADABLE: 4,
  KEY_FILE_INVALID: 4,
};

export function exitCodeFor(code: ErrorCode): number {
  return EXIT_CODES[code];
}

export type CtaBlock = {
  commands: { command: string; description?: string }[];
  description?: string;
};

/** What a CTA can quote back, so the suggested command is the one to actually run. */
export type CtaContext = {
  /**
   * The raw `--chain` value, resolved here rather than by the caller.
   *
   * **Every CTA carries `--chain`, and that is correctness rather than tidiness**
   * (ADR-0015): a continuation command without it re-resolves to the default and
   * would answer from a different deployment than the one that just refused.
   */
  chain?: string | undefined;
  court?: string | undefined;
  jurors?: string | undefined;
  kit?: string | undefined;
  dispute?: string | undefined;
};

/**
 * The slug to write into a CTA and into an error message.
 *
 * `resolveDeployment` is pure, total and offline, so calling it a second time
 * here cannot disagree with the call the core made and costs nothing. When it
 * refuses, the failure **is** `CHAIN_NOT_SUPPORTED`, whose own message names
 * what was asked for — so there is nothing to echo and the placeholder keeps a
 * suggested command from carrying the bad value forward.
 */
function slugFor(chain: string | undefined): DeploymentSlug | undefined {
  const resolved = resolveDeployment(chain);
  return resolved.success ? resolved.data.slug : undefined;
}

/**
 * The next command, for an agent that has to self-correct without a human.
 *
 * **incur prefixes the binary name onto every CTA command**, so a CTA can only
 * ever be a subcommand of this CLI. A shell remedy — `chmod 600` — or a call to
 * a different tool — `kleros court list` — goes in `details.hint`, never here
 * (`spec/03 §5.4`). The juror repo's known defect is a CTA naming a command that
 * does not exist; every command named below is registered in `cli.ts`.
 */
export function ctaFor(code: ErrorCode, context: CtaContext): CtaBlock | undefined {
  const on = ` --chain ${slugFor(context.chain) ?? "<slug>"}`;
  const at = context.dispute ? ` --dispute ${context.dispute}` : "";

  switch (code) {
    case "COURT_OUT_OF_RANGE":
    case "COURT_DISABLED":
    case "JURORS_INVALID":
    case "DISPUTE_KIT_OUT_OF_RANGE":
    case "DISPUTE_KIT_NOT_SUPPORTED":
      return {
        description:
          "None of these reverts on chain. KlerosCore substitutes the General Court, its own " +
          "juror count or the Classic kit and creates a paid dispute anyway, so this refusal is " +
          "the only thing that catches it.",
        commands: [
          {
            command: quoteCommand(context, REFUSED_WORD[code]),
            description: "Price a corrected court, juror count and kit",
          },
        ],
      };
    case "COST_CEILING_EXCEEDED":
      return {
        description: "The arbitration fee is paid on creation and cannot be recovered.",
        commands: [
          { command: quoteCommand(context), description: "Quote the fee without committing to it" },
        ],
      };
    /**
     * **The two paths refuse for different reasons and need different words.**
     *
     * `submit-evidence` pays no arbitration fee, so quoting one back would
     * name a cost the caller is not being asked for and point at a command
     * that cannot change the outcome — the shortfall there is gas, and the
     * only remedy is ETH in the account. The paying path keeps the fee CTA.
     *
     * Reachable on the evidence path only since the estimate stopped
     * pre-empting the check (`spec/04 §2.1`); before that this branch could
     * not fire at all, which is why it read as if creation were the only case.
     */
    case "INSUFFICIENT_BALANCE":
      // `court` is a **proxy** for "this command quotes a fee", not the fact
      // itself: it is required on `arbitration-cost` and `create-dispute` and
      // absent on `submit-evidence`, which passes only `dispute` (`cli.ts`).
      // Of those three only `create-dispute` can reach this code at all —
      // `arbitration-cost` signs nothing — so the proxy is exact today. A
      // future signing command taking a `--court` would inherit the fee CTA,
      // which is the thing to check when adding one.
      //
      // On the evidence path the only remedy is funding the account, and incur
      // prefixes the binary name onto every CTA command, so a CTA can only
      // name a subcommand of this CLI. None adds ETH, so the remedy travels in
      // `details.hint` (`spec/03 §5.4`).
      return context.court === undefined
        ? undefined
        : {
            description: "The arbitration fee is paid on creation and cannot be recovered.",
            commands: [
              {
                command: quoteCommand(context),
                description: "Quote the fee without committing to it",
              },
            ],
          };
    case "KEY_FILE_MISSING":
    case "KEY_FILE_PERMISSIONS":
    case "KEY_FILE_UNREADABLE":
    case "KEY_FILE_INVALID":
      return {
        description:
          "The signing key is read from a file this tool is pointed at, mode 0600. It is never " +
          "read from an environment variable or a command-line argument.",
        commands: [
          {
            command: quoteCommand(context),
            description: "Read commands need no key: price the dispute first",
          },
        ],
      };
    case "EFFECTIVE_MISMATCH":
      return {
        description: "The dispute exists and is paid for. Inspect it before doing anything else.",
        commands: [
          { command: `status${on}${at}`, description: "Show the dispute that was created" },
        ],
      };
    default:
      return undefined;
  }
}

/** Which word each refusal implicates, so the CTA does not hand it straight back. */
const REFUSED_WORD = {
  COURT_OUT_OF_RANGE: "court",
  COURT_DISABLED: "court",
  JURORS_INVALID: "jurors",
  DISPUTE_KIT_OUT_OF_RANGE: "kit",
  DISPUTE_KIT_NOT_SUPPORTED: "kit",
} as const;

/**
 * An `arbitration-cost` invocation quoting back what the operator typed —
 * **except** the word that was just refused, which becomes a placeholder.
 *
 * That exception is the whole point. A CTA that re-offers the failing command
 * verbatim reads, to an agent with no human above it, as an instruction to run
 * it again; it would fail identically, and nothing in that loop breaks it.
 * Blanking the refused word makes the correction the obvious next move and
 * leaves the two words that were fine in place.
 */
function quoteCommand(context: CtaContext, refused?: "court" | "jurors" | "kit"): string {
  const word = (name: "court" | "jurors" | "kit", value: string | undefined, blank: string) =>
    name === refused || value === undefined ? blank : value;

  return (
    `arbitration-cost --chain ${slugFor(context.chain) ?? "<slug>"}` +
    ` --court ${word("court", context.court, "<id>")}` +
    ` --jurors ${word("jurors", context.jurors, "<n>")}` +
    ` --kit ${word("kit", context.kit, "<id>")}`
  );
}

/**
 * After an upload, the command that consumes it.
 *
 * The only CTA in this CLI attached to a success. `upload-file` exists to hand
 * two arguments to `submit-evidence`, and quoting them back with the dispute
 * left as a placeholder is what makes the two-command split free
 * (`spec/06 §7.3`). Nothing is quoted back when nothing was published — a check
 * produced no URI to pass on.
 */
export function uploadSuccessCta(data: Record<string, unknown>): CtaBlock | undefined {
  const fileURI = data.fileURI;
  if (typeof fileURI !== "string") return undefined;

  const extension = data.fileTypeExtension;
  const withExtension = typeof extension === "string" ? ` --file-type-extension ${extension}` : "";

  return {
    description:
      "The file is pinned and nothing has been submitted. Evidence is a separate transaction, " +
      "and it needs the core dispute ID and the deployment the dispute is on.",
    commands: [
      {
        command:
          // `--chain` is a placeholder rather than the default, and deliberately
          // so: `upload-file` touches no chain (`spec/06 §1`), so it has no
          // deployment to preserve and guessing one would be the exact silent
          // redirection the rule exists to prevent.
          `submit-evidence --chain <slug> --dispute <id> --name "<short name>"` +
          ` --description @<file> --file-uri ${fileURI}${withExtension}`,
        description: "Submit evidence referencing this attachment",
      },
    ],
  };
}

/**
 * The whole core→incur seam.
 *
 * **Only `details.hint` reaches the user** (`spec/03 §5.4`). Every error message
 * already embeds the values that matter; the rest of `details` exists for tests,
 * and dumping the object makes the payload unreadable for the agent consuming
 * it.
 */
export function finish<T>(
  c: {
    ok: (data: T, meta?: { cta?: CtaBlock | undefined }) => never;
    error: (options: {
      code: string;
      message: string;
      exitCode?: number | undefined;
      cta?: CtaBlock | undefined;
    }) => never;
  },
  result: KlerosResult<T>,
  context: CtaContext = {},
  /**
   * A CTA for a **success**, derived from the payload. Only `upload-file` uses
   * one: its whole purpose is to produce two arguments for another command, and
   * the CTA is what stops the split between them costing the agent a step
   * (`spec/06 §7.3`). It is a function of the data rather than a value so that
   * `run(c)` stays free of logic — it names the mapping, it does not perform it.
   */
  successCta?: (data: T) => CtaBlock | undefined,
): never {
  if (result.success) {
    const cta = successCta?.(result.data);
    return cta ? c.ok(result.data, { cta }) : c.ok(result.data);
  }

  const cta = ctaFor(result.code, context);
  const hint =
    result.details && typeof result.details === "object" && "hint" in result.details
      ? String((result.details as { hint: unknown }).hint)
      : null;

  // The hint may be a fragment the endpoint supplied — `rpcError` appends the
  // node's own words verbatim, and a node does not punctuate — so the sentence
  // is closed here before the deployment is appended. Without this the two run
  // together: "The endpoint said: fetch failed Deployment: arbitrum-one".
  const withHint = hint ? `${result.message} ${hint}` : result.message;
  const closed = /[.!?…]$/.test(withHint.trimEnd()) ? withHint : `${withHint}.`;

  return c.error({
    code: result.code,
    message: `${closed}${deploymentSuffix(context.chain)}`,
    exitCode: exitCodeFor(result.code),
    ...(cta ? { cta } : {}),
  });
}

/**
 * **Which deployment a failure came from, in the message.**
 *
 * A success payload carries `deployment` and `chainId` as fields. A failure
 * cannot: incur's error envelope is closed to `{code, message}` and a `cta`, and
 * **no output mode renders `details`** (ADR-0013) — so a fact the caller needs
 * goes in the message or it does not reach them at all. An agent that has to
 * decide whether to retry, and a human reading a refusal, both need to know
 * which deployment answered before either can act on it.
 *
 * **An absent `chain` means the command has no deployment, not that it took the
 * default.** `upload-file` touches no chain at all (`spec/03 §3.4`), and a
 * refusal from it that claimed one would be a plain falsehood — the same silent
 * redirection `uploadSuccessCta` refuses to commit. Every chain-taking command
 * passes a value here because `--chain` carries a zod default, so the two cases
 * cannot be confused at the CLI boundary; `finish` is not exported from
 * `index.ts`, so that boundary is the only one there is.
 *
 * The chain ID reported is the selected deployment's **expected** one. Every
 * failure after the assertion has that ID asserted; the two failures before it
 * name the discrepancy themselves — `WRONG_CHAIN` reports what the endpoint
 * actually said, and `CHAIN_NOT_SUPPORTED` has no deployment to report, which is
 * why this appends nothing when the slug does not resolve either.
 */
function deploymentSuffix(chain: string | undefined): string {
  if (chain === undefined) return "";

  const resolved = resolveDeployment(chain);
  if (!resolved.success) return "";
  return ` Deployment: ${resolved.data.slug} (chain ${resolved.data.chainId}).`;
}

/* ------------------------------------------------------------------------- *
 * Options — `spec/03 §3`.
 *
 * Every option is `z.string()`, **including the numeric ones**, so a bad number
 * fails with a stable `code` in the payload rather than with incur's own
 * validation error. Only booleans are `z.boolean().default(false)`. Kebab-case
 * keys are read by index: `c.options["rpc-url"]`.
 *
 * `z` is imported from `incur`, never from `zod` — one zod instance.
 * ------------------------------------------------------------------------- */

/**
 * The two options every command that touches a chain takes. **Declared per
 * command, never as a root option**: incur's global mechanism reaches handlers
 * but is not merged into the per-command tool schemas an agent calls over MCP,
 * so a root declaration would be invisible to exactly the caller this CLI is
 * built for (verified against incur 0.4.26, `Mcp.ts`'s `buildToolSchema`).
 *
 * `alias: { chain: "c" }` is declared alongside `options` on each command in
 * `cli.ts`; incur takes aliases there and not in the schema.
 */
export const chainOptions = {
  /**
   * **The gloss lives here and nowhere else.** Pairing each slug with the name
   * humans use for it is what lets an agent map "v2 Beta" in prose onto a flag
   * value, and repeating it in messages, CTAs or other help strings would be
   * four places for it to drift (ADR-0015).
   */
  chain: z
    .string()
    .default(DEFAULT_DEPLOYMENT_SLUG)
    .describe(
      `Deployment to act on: ${glossedSlugs()}. A deployment is one address set of the Kleros ` +
        "v2 contracts, and a chain may host several — the flag is named for the chain to match " +
        "the kleros CLI, and selects a deployment. It is never read from the environment.",
    ),
  "rpc-url": z
    .string()
    .optional()
    .describe(
      "RPC URL for the selected deployment's chain, comma-separated for automatic fallback. " +
        `Falls back to ${overrideVariables()}, then to that deployment's public endpoint, ` +
        "which is rate-limited. The variable is per deployment and configures transport only: " +
        "nothing outside this command line can select which deployment is acted on. The chain " +
        "assertion runs against whatever this points at.",
    ),
};

/** `arbitrum-one (v2 Beta)`, joined. The one place a slug is paired with its prose name. */
function glossedSlugs(): string {
  return Object.values(DEPLOYMENTS)
    .map((deployment) => `${deployment.slug} (${deployment.name})`)
    .join(", ");
}

/**
 * The override variables, named rather than described by formula.
 *
 * **An agent cannot apply a formula it is only told about**, and this CLI is
 * self-documenting for exactly that reader — so the names are rendered from the
 * table, which is also why adding a deployment cannot leave this listing one
 * short. It deliberately does not repeat the gloss: `--chain` owns that.
 */
function overrideVariables(): string {
  return Object.values(DEPLOYMENTS)
    .map((deployment) => deployment.rpcUrlVariable)
    .join(" / ");
}

export const writeOptions = {
  "key-file": z
    .string()
    .optional()
    .describe(
      "Path to the file holding the signing key, mode 0600. The key is never accepted from an " +
        "environment variable or a command-line argument, and never appears in any output.",
    ),
  // `--broadcast false` sets this to **true**. incur's boolean flags never consume
  // a following word, so the word is parsed as a positional and then discarded in
  // silence, because no command here declares `args`. The safe spellings for off
  // are omitting the flag, `--no-broadcast`, or `--broadcast=false`; the same
  // applies to `--publish`. Verified against incur 0.4.26 by driving `Parser.parse`
  // directly, and observed end to end on `--publish false`, which uploaded.
  //
  // This cannot be defended against here — incur owns the parser — so it is
  // documented in `skills/kleros-disputant/SKILL.md`, where the caller reads it
  // before spending money. Do not "fix" it by making this option a string.
  broadcast: z
    .boolean()
    .default(false)
    .describe(
      "Send the transaction. Without it the command plans, simulates and stops. There is no " +
        "confirmation prompt: this flag is the confirmation. Omit it, or pass --no-broadcast, to " +
        "keep it off: --broadcast false sets it to true, because the word is not read as a value.",
    ),
  "max-fee-gwei": z
    .string()
    .optional()
    .describe(
      "Gas fee ceiling in gwei, capping maxFeePerGas. It does not cap the arbitration fee, " +
        "which is not gas.",
    ),
};

/** The three `extraData` words. Shared by `arbitration-cost` and `create-dispute`. */
export const extraDataOptions = {
  court: z
    .string()
    .describe(
      "Court ID, starting at 1. Court 0 is the Forking Court and is refused. A court that does " +
        "not exist is refused rather than silently replaced with the General Court.",
    ),
  jurors: z
    .string()
    .describe("Number of jurors to draw, at least 1. The arbitration fee scales with it."),
  kit: z
    .string()
    .default("1")
    .describe(
      "Dispute kit ID. 1 is Classic, the kit every court supports on arbitrum-one, where that " +
        "was measured. A few courts " +
        "support others as well, and kit support is re-read on every invocation for the selected " +
        "deployment rather than assumed.",
    ),
};

/**
 * How long to wait for a receipt before reporting the outcome as `unknown`.
 *
 * **Not an option.** `spec/03 §3` fixes the option set, and this is not a safety
 * parameter: a timeout produces `status: "unknown"`, which is a success that
 * says the tool stopped watching and the transaction may still land
 * (`spec/04 §3`). Nothing is decided by the number, so nothing is gained by
 * exposing it.
 */
export const RECEIPT_TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------------------- *
 * Preparation — `spec/03 §6`, `§7`.
 * ------------------------------------------------------------------------- */

export type PrepareOptions = {
  /** The raw `--chain` value. Absent means the default (`spec/03 §7` step 1). */
  chain?: string | undefined;
  rpcUrl?: string | undefined;
  keyFile?: string | undefined;
  /** Read commands work without a key; the two write commands cannot (`spec/03 §6`). */
  requireSigner: boolean;
};

export type LocallyPrepared = {
  deployment: Deployment;
  rpcUrls: string[];
  account: PrivateKeyAccount | null;
};

/**
 * Everything resolvable with no network at all: the deployment, the endpoint
 * list and the key.
 *
 * Split from `prepare` so an unserved slug and a key that is missing or
 * world-readable are both refused before a single RPC round trip, and so the
 * signer gate is visible as one boolean rather than buried in each command.
 *
 * **The slug is resolved first**, because a caller who named a deployment this
 * tool does not serve should be told that and not that their key file is
 * unreadable — and because `spec/03 §7` step 1 is where it belongs.
 */
export function prepareLocal(options: PrepareOptions): KlerosResult<LocallyPrepared> {
  const deployment = resolveDeployment(options.chain);
  if (!deployment.success) return deployment;

  // The endpoint resolves flag > the **selected deployment's own** override
  // variable > that deployment's default (`ADR-0016`, `spec/03 §3.1`). The
  // environment configures transport and never target: nothing ambient selects a
  // deployment, and the signing key is still refused from it entirely.
  const rpcUrls = parseRpcUrls(options.rpcUrl, deployment.data);

  const signer = loadSigner({ path: options.keyFile });
  if (!signer.success) {
    if (options.requireSigner) return signer;
    return ok({ deployment: deployment.data, rpcUrls, account: null });
  }

  return ok({ deployment: deployment.data, rpcUrls, account: signer.data });
}

export type Prepared = LocallyPrepared & {
  client: PublicClient;
  /** The deployment's contracts, resolved once by `startup` and threaded on. */
  contracts: DeploymentContracts;
  /** The chain ID that was asserted — echoed by every success envelope. */
  chainId: number;
  /** Version mismatches from `spec/03 §7` step 5. Never a failure; always echoed. */
  warnings: string[];
};

/**
 * `prepareLocal`, then the whole of `spec/03 §7` in the order that section
 * fixes: slug, then addresses, then `eth_chainId` against **that deployment's**
 * expected chain ID, then the deployment's own view of itself, then versions.
 *
 * Command-specific pre-flight is step 6 and is the caller's next move. Nothing
 * in `read-preflight.ts` may run before this returns: those are contract calls,
 * and on an unverified chain they read the wrong core.
 *
 * The overload is what removes the dead `if (!account)` branch every write
 * command would otherwise carry: `requireSigner: true` has already refused, so
 * there is no null left to check at runtime.
 */
export async function prepare(
  options: PrepareOptions & { requireSigner: true },
): Promise<KlerosResult<Prepared & { account: PrivateKeyAccount }>>;
export async function prepare(options: PrepareOptions): Promise<KlerosResult<Prepared>>;
export async function prepare(options: PrepareOptions): Promise<KlerosResult<Prepared>> {
  const local = prepareLocal(options);
  if (!local.success) return local;

  const client = createKlerosClient(local.data.rpcUrls, local.data.deployment);

  const facts = await startup(client, local.data.deployment);
  if (!facts.success) return facts;

  return ok({
    ...local.data,
    client,
    contracts: facts.data.contracts,
    chainId: facts.data.chainId,
    warnings: facts.data.warnings,
  });
}

/**
 * The two fields every envelope carries, success or failure — the resolved
 * deployment and the chain ID that was asserted, never the ones requested. The
 * same rule that already governs the effective court, juror count and kit
 * (`spec/02 §1.2`).
 */
export function deploymentEcho(prepared: Prepared): {
  deployment: DeploymentSlug;
  chainId: number;
} {
  return { deployment: prepared.deployment.slug, chainId: prepared.chainId };
}
