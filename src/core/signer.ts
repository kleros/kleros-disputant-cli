import { readFileSync, statSync } from "node:fs";
import type { Hex, PrivateKeyAccount } from "viem";
import { isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * The signing key — `spec/03 §6`.
 *
 * **Exactly one credential exists in this tool** (ADR-0009): no pinning token,
 * no subgraph key, no API key of any kind. It is read from a file whose path is
 * given by `--key-file`, and **never** from an environment variable or a
 * command-line argument. This process is launched by an agent gateway that also
 * runs model-authored shell commands, so anything in the environment is
 * inherited by every child and readable from the process table; a file is not a
 * security boundary against a compromised host either, but it is not *ambient*,
 * which is the difference that matters.
 *
 * **The key MUST NOT appear in any output, error, log line or `details` object,
 * including on the failure paths.** Every refusal below is written to that rule:
 * none of them echoes the file's contents, and the one place a dependency would
 * have leaked it is disarmed at the point of the mistake.
 */

export type LoadSignerOptions = {
  /** `--key-file`. There is no default path: an absent option is an absent key. */
  path: string | undefined;
};

/** Owner-only. Group or other bits set means the key is readable by another account. */
const PERMISSION_MASK = 0o077;

export function loadSigner({ path }: LoadSignerOptions): KlerosResult<PrivateKeyAccount> {
  if (path === undefined || path.trim() === "") {
    return err("KEY_FILE_MISSING", "No signing key: --key-file was not given. Nothing was sent.", {
      hint:
        "Write the private key to a file, run chmod 600 on it, and pass --key-file <path>. " +
        "This tool does not accept a key from the environment or the command line.",
    });
  }

  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return err("KEY_FILE_MISSING", `No signing key at ${path}. Nothing was sent.`, {
      hint: `Write the private key there and run: chmod 600 ${path}`,
    });
  }

  // A SHOULD in `spec/03 §6`, enforced: a key file another account can read is
  // a key that has already left this tool's control, and the remedy goes in
  // `details.hint` rather than a CTA because it is a shell command, not a
  // subcommand of this CLI (`spec/03 §5.4`).
  if ((mode & PERMISSION_MASK) !== 0) {
    return err(
      "KEY_FILE_PERMISSIONS",
      `${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}). ` +
        "Nothing was sent.",
      { hint: `chmod 600 ${path}` },
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (cause) {
    // `cause.message` from `readFileSync` names the path and the errno, never
    // the contents — the read failed, so there are no contents to name.
    return err("KEY_FILE_UNREADABLE", `Could not read ${path}. Nothing was sent.`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`).toLowerCase();
  if (!isHex(hex) || hex.length !== 66) {
    return err(
      "KEY_FILE_INVALID",
      `${path} does not contain a 32-byte hex private key. Nothing was sent.`,
      { hint: "The file must hold 64 hex characters, optionally 0x-prefixed, and nothing else." },
    );
  }

  try {
    return ok(privateKeyToAccount(hex as Hex));
  } catch {
    // **The cause is deliberately dropped.** viem's out-of-range message is
    //   "expected valid private key: 1 <= n < 1157920…, got 1157920…"
    // and that trailing number *is* the key, in decimal — verified against
    // viem 2.55. Propagating `cause.message` here, as the juror CLI does, puts
    // the key material into `details` on a failure path, which `spec/03 §6`
    // forbids outright. Nothing about the value is reported back.
    return err(
      "KEY_FILE_INVALID",
      `The key in ${path} is not a valid secp256k1 private key. Nothing was sent.`,
      { hint: "The value must be a non-zero scalar below the secp256k1 group order." },
    );
  }
}
