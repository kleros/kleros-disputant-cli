import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSigner } from "../signer.js";

/**
 * `spec/03 §6`, and `spec/05 §1.7`'s third bullet: **no envelope, on any path
 * including every failure path, contains the key material.**
 *
 * That is not a style rule here. viem's own out-of-range message is
 * `expected valid private key: 1 <= n < 1157920…, got <the key, in decimal>` —
 * verified against viem 2.55 — so a `cause.message` propagated from
 * `privateKeyToAccount`, as the sibling juror CLI does, puts the key into
 * `details`. The last test in this file is what keeps that closed.
 */

const dir = mkdtempSync(join(tmpdir(), "kleros-disputant-signer-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A well-known Anvil test key. It has never held anything and never will. */
const VALID = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VALID_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

let counter = 0;
function keyFile(contents: string, mode = 0o600): string {
  const path = join(dir, `key-${counter++}`);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

describe("loading the signing key", () => {
  it("loads a 0600 file and derives the expected address", () => {
    const result = loadSigner({ path: keyFile(VALID) });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.address).toBe(VALID_ADDRESS);
  });

  it("accepts a key with no 0x prefix, and trailing whitespace", () => {
    const result = loadSigner({ path: keyFile(`${VALID.slice(2)}\n`) });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.address).toBe(VALID_ADDRESS);
  });

  it("refuses when --key-file was not given", () => {
    const result = loadSigner({ path: undefined });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_MISSING");
    // The remedy is a shell command, so it goes in `details.hint` and never in
    // a CTA — incur prefixes the binary name onto every CTA (`spec/03 §5.4`).
    expect((result.details as { hint: string }).hint).toContain("--key-file");
  });

  it("refuses a path that does not exist", () => {
    const result = loadSigner({ path: join(dir, "absent") });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_MISSING");
  });

  it("refuses a file another account can read, and says how to fix it", () => {
    const path = keyFile(VALID, 0o644);
    const result = loadSigner({ path });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_PERMISSIONS");
    expect(result.message).toContain("644");
    expect((result.details as { hint: string }).hint).toBe(`chmod 600 ${path}`);
  });

  it.each([
    ["empty", ""],
    ["too short", "0xdeadbeef"],
    ["not hex", `0x${"z".repeat(64)}`],
    ["31 bytes", `0x${"11".repeat(31)}`],
  ])("refuses a %s key file", (_label, contents) => {
    const result = loadSigner({ path: keyFile(contents) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_INVALID");
  });

  it.each([
    ["zero", `0x${"00".repeat(32)}`],
    ["at or above the group order", `0x${"ff".repeat(32)}`],
  ])("refuses a 32-byte value that is not a valid scalar (%s)", (_label, contents) => {
    const result = loadSigner({ path: keyFile(contents) });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("KEY_FILE_INVALID");
  });
});

/**
 * The rule, asserted over every failure path at once and over the whole payload
 * rather than over `message` alone: `details` is where the leak would be.
 *
 * `0xff…ff` is the load-bearing row. It is the one input viem rejects with a
 * message quoting the key back, and the decimal form is checked as well as the
 * hex — that is the shape the leak would actually take.
 */
describe("the key never reaches a payload", () => {
  const secrets = [
    `0x${"ff".repeat(32)}`,
    `0x${"11".repeat(32)}`,
    VALID,
    `0x${"00".repeat(32)}`,
  ] as const;

  it.each(secrets)("no failure payload contains %s, in hex or in decimal", (secret) => {
    // 0o644 forces the permissions refusal on a file whose contents are valid,
    // so the sweep covers a path where the key was readable and well-formed.
    for (const mode of [0o600, 0o644] as const) {
      const result = loadSigner({ path: keyFile(secret, mode) });
      const serialised = JSON.stringify(result.success ? { address: result.data.address } : result);

      expect(serialised).not.toContain(secret);
      expect(serialised).not.toContain(secret.slice(2));

      // The zero key's decimal form is the single character `0`, which any
      // payload may legitimately contain; it carries no secret to leak. Every
      // real key is a 70-plus-digit number, so the substring check is only
      // meaningful — and is only applied — above that length.
      const decimal = BigInt(secret).toString(10);
      if (decimal.length > 32) expect(serialised).not.toContain(decimal);
    }
  });
});
