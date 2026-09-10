import { ContractFunctionRevertedError, encodeErrorResult, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { simulateAndMaybeBroadcast } from "../../core/broadcast.js";
import { contractsFor } from "../../core/deployment.js";
import { DEFAULT_DEPLOYMENT, DEPLOYMENTS } from "../../core/deployments.js";
import { FOREIGN_TEXT_LIMIT } from "../../core/foreign-text.js";
import type { ErrorCode } from "../../core/result.js";
import { err, ok } from "../../core/result.js";
import { ctaFor, exitCodeFor, finish, prepareLocal } from "../shared.js";

/**
 * The command layer's seam — `spec/03 §4`, `§5.4`, `§6`.
 *
 * Offline: nothing here reads the chain, a key file it did not write, or the
 * network.
 */

/**
 * Every member of the union, written out.
 *
 * The exhaustiveness `spec/03 §4` demands is enforced at **compile time** by
 * `Record<ErrorCode, number>` in `shared.ts` — this list is the other half of
 * the same guard, and the `satisfies` below is what fails to compile if the two
 * ever drift. A runtime `Object.keys` over the map could not do that: it would
 * agree with a map that had gained a key the union never had.
 */
const ALL_CODES = [
  "WRONG_CHAIN",
  "DEPLOYMENT_INCONSISTENT",
  "RPC_ERROR",
  "KEY_FILE_MISSING",
  "KEY_FILE_PERMISSIONS",
  "KEY_FILE_UNREADABLE",
  "KEY_FILE_INVALID",
  "COURT_OUT_OF_RANGE",
  "COURT_DISABLED",
  "JURORS_INVALID",
  "DISPUTE_KIT_OUT_OF_RANGE",
  "DISPUTE_KIT_NOT_SUPPORTED",
  "TEMPLATE_INVALID",
  "RULING_OPTIONS_INVALID",
  "POLICY_URI_INVALID",
  "EVIDENCE_INVALID",
  "COST_CEILING_EXCEEDED",
  "INSUFFICIENT_BALANCE",
  "DISPUTE_NOT_FOUND",
  "EFFECTIVE_MISMATCH",
  "SIMULATION_REVERTED",
  "TRANSACTION_REVERTED",
  "BROADCAST_FAILED",
  "FILE_UNREADABLE",
  "FILE_EMPTY",
  "FILE_TOO_LARGE",
  "UPLOAD_FAILED",
  "UPLOAD_MISMATCH",
  "NUMBER_INVALID",
  "DISPUTE_NOT_ADDRESSABLE",
  "CHAIN_NOT_SUPPORTED",
] as const satisfies readonly ErrorCode[];

/** The other direction: every listed code is real, and none is missing. */
type Missing = Exclude<ErrorCode, (typeof ALL_CODES)[number]>;
const _exhaustive: Missing extends never ? true : Missing = true;

describe("exit codes", () => {
  it("gives every error code one of the five meanings in spec/03 §4", () => {
    for (const code of ALL_CODES) {
      expect(exitCodeFor(code), code).toBeGreaterThanOrEqual(1);
      expect(exitCodeFor(code), code).toBeLessThanOrEqual(4);
    }
    expect(_exhaustive).toBe(true);
  });

  it("puts every pre-flight refusal in bucket 1, so nothing-was-sent reads as one thing", () => {
    for (const code of [
      "COURT_OUT_OF_RANGE",
      "COURT_DISABLED",
      "JURORS_INVALID",
      "DISPUTE_KIT_OUT_OF_RANGE",
      "DISPUTE_KIT_NOT_SUPPORTED",
      "TEMPLATE_INVALID",
      "RULING_OPTIONS_INVALID",
      "POLICY_URI_INVALID",
      "EVIDENCE_INVALID",
      "COST_CEILING_EXCEEDED",
      "INSUFFICIENT_BALANCE",
      "DISPUTE_NOT_FOUND",
      "NUMBER_INVALID",
    ] as const) {
      expect(exitCodeFor(code), code).toBe(1);
    }
  });

  it("separates a key failure from a validation failure", () => {
    for (const code of [
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "KEY_FILE_UNREADABLE",
      "KEY_FILE_INVALID",
    ] as const) {
      expect(exitCodeFor(code), code).toBe(4);
    }
  });

  it("does not report a refused broadcast as a revert: nothing was submitted", () => {
    expect(exitCodeFor("BROADCAST_FAILED")).toBe(2);
    expect(exitCodeFor("SIMULATION_REVERTED")).toBe(3);
    expect(exitCodeFor("TRANSACTION_REVERTED")).toBe(3);
  });

  it("keeps EFFECTIVE_MISMATCH out of bucket 1, where the money would read as unspent", () => {
    expect(exitCodeFor("EFFECTIVE_MISMATCH")).toBe(3);
    expect(exitCodeFor("EFFECTIVE_MISMATCH")).not.toBe(exitCodeFor("COURT_OUT_OF_RANGE"));
  });
});

describe("CTA blocks", () => {
  /**
   * `spec/03 §5.4`: incur prefixes the binary name onto every CTA command, so a
   * CTA can only ever name a subcommand of this CLI. Citing a command a peer CLI
   * does not have is the juror repo's known defect; this is what stops it here.
   */
  const REGISTERED = ["arbitration-cost", "status", "create-dispute", "submit-evidence"];

  it("only ever names a command this CLI registers", () => {
    for (const code of ALL_CODES) {
      for (const entry of ctaFor(code, { court: "1", jurors: "3", dispute: "215" })?.commands ??
        []) {
        expect(REGISTERED, `${code} suggests ${entry.command}`).toContain(
          entry.command.split(" ")[0],
        );
      }
    }
  });

  it("never puts a shell remedy in a CTA, where incur would prefix the binary name", () => {
    for (const code of ALL_CODES) {
      const rendered = JSON.stringify(ctaFor(code, {}) ?? {});
      expect(rendered, code).not.toMatch(/chmod|kleros court|\bsudo\b/);
    }
  });

  it("keeps the words that were fine and blanks the one that was refused", () => {
    expect(
      ctaFor("COURT_OUT_OF_RANGE", { court: "99", jurors: "7", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --chain arbitrum-one --court <id> --jurors 7 --kit 1");
    expect(
      ctaFor("JURORS_INVALID", { court: "1", jurors: "0", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --chain arbitrum-one --court 1 --jurors <n> --kit 1");
    expect(
      ctaFor("DISPUTE_KIT_NOT_SUPPORTED", { court: "1", jurors: "3", kit: "2" })?.commands[0]
        ?.command,
    ).toBe("arbitration-cost --chain arbitrum-one --court 1 --jurors 3 --kit <id>");
  });

  /**
   * The consumer is an agent with no human above it. These five are the codes
   * `arbitration-cost` raises about itself, so a CTA that re-offered the same
   * three words would read as an instruction to run the failing command again,
   * would fail identically, and nothing in that loop would break it.
   *
   * The key and cost codes are deliberately not in this list: they are raised by
   * `create-dispute`, and the same three words under `arbitration-cost` succeed
   * — that is exactly why they are the suggestion.
   */
  it("never re-offers the words that were just refused about themselves", () => {
    const typed = { court: "99", jurors: "0", kit: "2" };
    const verbatim = `arbitration-cost --court ${typed.court} --jurors ${typed.jurors} --kit ${typed.kit}`;

    for (const code of [
      "COURT_OUT_OF_RANGE",
      "COURT_DISABLED",
      "JURORS_INVALID",
      "DISPUTE_KIT_OUT_OF_RANGE",
      "DISPUTE_KIT_NOT_SUPPORTED",
    ] as const) {
      for (const entry of ctaFor(code, typed)?.commands ?? []) {
        expect(entry.command, code).not.toBe(verbatim);
        expect(entry.command, code).toContain("<");
      }
    }
  });

  it("quotes what it can when the refusal was not about any of the three words", () => {
    expect(
      ctaFor("COST_CEILING_EXCEEDED", { court: "1", jurors: "3", kit: "1" })?.commands[0]?.command,
    ).toBe("arbitration-cost --chain arbitrum-one --court 1 --jurors 3 --kit 1");
  });

  it("offers a key-less command when the key is what failed", () => {
    for (const code of [
      "KEY_FILE_MISSING",
      "KEY_FILE_PERMISSIONS",
      "KEY_FILE_UNREADABLE",
      "KEY_FILE_INVALID",
    ] as const) {
      expect(ctaFor(code, { court: "1", jurors: "3" })?.commands[0]?.command, code).toContain(
        "arbitration-cost",
      );
    }
  });
});

describe("finish", () => {
  const context = () => {
    const seen: { ok?: unknown; error?: Record<string, unknown> } = {};
    return {
      seen,
      c: {
        ok: ((data: unknown) => {
          seen.ok = data;
          return undefined as never;
        }) as (data: never) => never,
        error: ((options: Record<string, unknown>) => {
          seen.error = options;
          return undefined as never;
        }) as never,
      },
    };
  };

  it("passes a success through untouched", () => {
    const { seen, c } = context();
    finish(c as never, ok({ command: "status" }));
    expect(seen.ok).toEqual({ command: "status" });
    expect(seen.error).toBeUndefined();
  });

  it("appends details.hint and nothing else from details", () => {
    const { seen, c } = context();
    finish(
      c as never,
      err("DISPUTE_NOT_FOUND", "No such dispute.", {
        hint: "Use the core dispute ID.",
        coreDisputeID: "999999",
      }),
      { chain: "arbitrum-one" },
    );
    expect(seen.error?.message).toBe(
      "No such dispute. Use the core dispute ID. Deployment: arbitrum-one (chain 42161).",
    );
    expect(JSON.stringify(seen.error)).not.toContain("999999");
  });

  /**
   * **A failure envelope has nowhere else to say which deployment answered.**
   * incur's error envelope is closed to `{code, message}` and a `cta`, and no
   * output mode renders `details` (ADR-0013) — so the fact goes in the message
   * or it does not reach the caller at all (`spec/03 §3.1`).
   */
  it("names the deployment and the chain ID on a failure, where no field can carry them", () => {
    const { seen, c } = context();
    finish(c as never, err("DISPUTE_NOT_FOUND", "No such dispute."), { chain: "arbitrum-one" });
    expect(seen.error?.message).toBe("No such dispute. Deployment: arbitrum-one (chain 42161).");
  });

  /**
   * `rpcError` appends the node's own words verbatim, and a node does not
   * punctuate. Without closing the sentence the two run together as
   * "fetch failed Deployment: arbitrum-one".
   */
  it("closes an unpunctuated hint before appending the deployment", () => {
    const { seen, c } = context();
    finish(
      c as never,
      err("RPC_ERROR", "Could not read the chain ID.", {
        hint: "The endpoint said: fetch failed",
      }),
      { chain: "arbitrum-one" },
    );
    expect(seen.error?.message).toBe(
      "Could not read the chain ID. The endpoint said: fetch failed. " +
        "Deployment: arbitrum-one (chain 42161).",
    );
  });

  /**
   * **`upload-file` has no deployment, and a refusal from it must not claim
   * one.** It touches no chain at all (`spec/03 §3.4`), so an absent `chain`
   * here means "this command has no deployment" and never "the default applied"
   * — every chain-taking command passes a value, because `--chain` carries a zod
   * default. Appending one would be the same silent redirection
   * `uploadSuccessCta` refuses to commit.
   */
  it("claims no deployment for a command that has none", () => {
    const { seen, c } = context();
    finish(c as never, err("FILE_UNREADABLE", "Could not read the file."), {});
    expect(seen.error?.message).toBe("Could not read the file.");
  });

  /**
   * The one failure with no deployment to name. `CHAIN_NOT_SUPPORTED`'s own
   * message already says what was asked for, and appending a resolved slug
   * would name one the caller did not choose.
   */
  it("appends nothing when the slug did not resolve", () => {
    const { seen, c } = context();
    finish(c as never, err("CHAIN_NOT_SUPPORTED", "Unsupported chain."), { chain: "nonsense" });
    expect(seen.error?.message).toBe("Unsupported chain.");
  });

  it("carries the exit code and the CTA for the code", () => {
    const { seen, c } = context();
    finish(c as never, err("COURT_OUT_OF_RANGE", "No such court."), { court: "99", jurors: "3" });
    expect(seen.error?.code).toBe("COURT_OUT_OF_RANGE");
    expect(seen.error?.exitCode).toBe(1);
    expect(seen.error?.cta).toBeDefined();
  });

  it("omits the CTA rather than inventing one for a code that has none", () => {
    const { seen, c } = context();
    finish(c as never, err("RPC_ERROR", "The endpoint did not answer."));
    expect(seen.error?.cta).toBeUndefined();
  });
});

describe("prepareLocal", () => {
  it("refuses a missing key on a write path and never names a key file it did not open", () => {
    const result = prepareLocal({ requireSigner: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_MISSING");
  });

  it("lets a read command run with no key at all", () => {
    const result = prepareLocal({ requireSigner: false });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.account).toBeNull();
  });

  /**
   * **This used to assert the opposite of what the tool now does**, and it did
   * so by setting `ARBITRUM_RPC` — the *juror* CLI's variable, which this tool
   * has never read. So it proved nothing either way.
   *
   * The rule it should have been pinning is `ADR-0016`'s: the environment
   * configures **transport**, never **target**. The variable is read, and it is
   * the selected deployment's own; nothing ambient reaches the endpoint that is
   * not named per deployment, and nothing ambient selects a deployment at all.
   *
   * Both branches run with the variable explicitly removed and then explicitly
   * set, rather than relying on the ambient environment — an operator who has
   * followed `ADR-0016` and exported it must still be able to run this suite.
   */
  it("reads the selected deployment's own variable, and nothing else's", () => {
    const before = { ...process.env };
    try {
      delete process.env[DEFAULT_DEPLOYMENT.rpcUrlVariable];
      process.env.ARBITRUM_RPC = "https://juror-cli.invalid";
      process.env.KLEROS_RPC_URL = "https://ambient.invalid";
      process.env[DEPLOYMENTS["arbitrum-sepolia-testnet"].rpcUrlVariable] =
        "https://other-deployment.invalid";

      const defaulted = prepareLocal({ requireSigner: false });
      expect(defaulted.success).toBe(true);
      if (!defaulted.success) return;
      expect(defaulted.data.rpcUrls).toEqual([DEFAULT_DEPLOYMENT.defaultRpcUrl]);

      process.env[DEFAULT_DEPLOYMENT.rpcUrlVariable] = "https://mine.invalid";
      const overridden = prepareLocal({ requireSigner: false });
      expect(overridden.success && overridden.data.rpcUrls).toEqual(["https://mine.invalid"]);

      // And the flag still outranks it — the other half of the rule.
      const explicit = prepareLocal({ requireSigner: false, rpcUrl: "https://flag.invalid" });
      expect(explicit.success && explicit.data.rpcUrls).toEqual(["https://flag.invalid"]);
    } finally {
      process.env = before;
    }
  });

  it("splits a comma-separated endpoint list for fallback", () => {
    const result = prepareLocal({ requireSigner: false, rpcUrl: "https://a.test, https://b.test" });
    expect(result.success && result.data.rpcUrls).toEqual(["https://a.test", "https://b.test"]);
  });
});

/**
 * `spec/04 §2.1` made this branch reachable, and reaching it showed the
 * words were wrong: `submit-evidence` pays no arbitration fee, so quoting one
 * back names a cost the caller was never asked for.
 */
describe("the balance CTA follows the path, not the code", () => {
  it("offers the fee quote only where a fee is actually paid", () => {
    const paying = ctaFor("INSUFFICIENT_BALANCE", { court: "1", jurors: "3", kit: "1" });

    expect(paying?.commands[0]?.command).toBe(
      "arbitration-cost --chain arbitrum-one --court 1 --jurors 3 --kit 1",
    );
    expect(paying?.description).toContain("arbitration fee");
  });

  it("offers nothing on the evidence path, because no subcommand adds ETH", () => {
    // incur prefixes the binary name onto every CTA command, so a CTA can only
    // name a subcommand of this CLI. The remedy is funding the account, which
    // is not one — it travels in `details.hint` (`spec/03 §5.4`).
    expect(ctaFor("INSUFFICIENT_BALANCE", { dispute: "1" })).toBeUndefined();
  });
});

/**
 * `ADR-0017` — the bound is worth nothing if the command layer puts the size
 * back. `finish` appends `details.hint` and the deployment suffix after core
 * has had its say, so the only honest place to measure a rendered message is
 * here, with a real revert underneath rather than a fabricated `err()`.
 *
 * The 8 KiB payload is the one measured through the built binary, where it
 * produced **8250 characters** of `message`
 * (`.scratch/revert-message-bounds/spec.md`).
 */
describe("a rendered revert message stays small", () => {
  const contracts = contractsFor(DEFAULT_DEPLOYMENT);

  /** The same incur-context double the `finish` suite uses, in this scope. */
  const context = () => {
    const seen: { error?: Record<string, unknown> } = {};
    return {
      seen,
      c: {
        error: ((options: Record<string, unknown>) => {
          seen.error = options;
          return undefined as never;
        }) as never,
      },
    };
  };

  const reverting = (reason: string) =>
    ({
      async simulateContract() {
        throw new ContractFunctionRevertedError({
          abi: contracts.disputeResolver.abi as never,
          data: encodeErrorResult({
            abi: [{ type: "error", name: "Error", inputs: [{ type: "string" }] }],
            errorName: "Error",
            args: [reason],
          }),
          functionName: "createDisputeForTemplate",
        });
      },
    }) as never;

  const reverted = (reason: string) =>
    simulateAndMaybeBroadcast({
      client: reverting(reason),
      account: privateKeyToAccount(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      ),
      target: {
        address: contracts.disputeResolver.address,
        abi: contracts.disputeResolver.abi as never,
      },
      call: { functionName: "createDisputeForTemplate", args: [] },
      broadcast: false,
      timeoutMs: 1_000,
      balanceWei: parseEther("1"),
      rpcUrls: ["http://127.0.0.1:1"],
      deployment: DEFAULT_DEPLOYMENT,
    } as never);

  it("renders an 8 KiB revert string as a short line, cut visibly", async () => {
    const result = await reverted("A".repeat(8192));
    expect(result.success).toBe(false);
    if (result.success) return;

    const { seen, c } = context();
    finish(c as never, result, { chain: "arbitrum-one" });
    const message = String(seen.error?.message);

    // Measured at 8250 before the bound; the whole rendered envelope now fits
    // in a fraction of one fragment's former length.
    expect(message.length).toBeLessThan(FOREIGN_TEXT_LIMIT + 120);
    expect(message).toContain("…");
    expect(seen.error?.code).toBe("SIMULATION_REVERTED");
    // The parts the caller acts on survive the cut, at both ends.
    expect(message).toContain("Nothing was sent.");
    expect(message).toContain("Deployment: arbitrum-one (chain 42161).");
  });

  it("keeps a control character out of what the caller is handed", async () => {
    const result = await reverted(`Reverted.\n${String.fromCharCode(0x1b)}[2J{"success":true}`);
    expect(result.success).toBe(false);
    if (result.success) return;

    const { seen, c } = context();
    finish(c as never, result, { chain: "arbitrum-one" });
    const message = String(seen.error?.message);

    expect(message).not.toContain(String.fromCharCode(0x1b));
    expect(message).not.toContain("\n");
  });
});
