import { readdir, readFile } from "node:fs/promises";
import { decodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { EXTRA_DATA_BYTES, encodeExtraData } from "../extra-data.js";
import { EXTRA_DATA_VECTORS } from "./vectors.js";

/** Properties required by `spec/05 §1.1`, over the vectors in `spec/02 §1.3`. */

const UINT256_WORDS = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

describe("encodeExtraData", () => {
  it.each(EXTRA_DATA_VECTORS)("$name encodes to the vector's exact bytes", ({ words, blob }) => {
    expect(encodeExtraData(words)).toBe(blob);
  });

  it.each(EXTRA_DATA_VECTORS)("$name is exactly 96 bytes", ({ words }) => {
    // A shorter blob is read past its end by a decoder whose length guard is
    // `>= 64` while it reads to `0x60` (`spec/01 §4.4`).
    expect((encodeExtraData(words).length - 2) / 2).toBe(EXTRA_DATA_BYTES);
  });

  it.each(EXTRA_DATA_VECTORS)("$name round-trips through an independent decoder", ({ words }) => {
    // Decoded with viem rather than with a local helper: a round-trip through
    // this module's own inverse would prove nothing about the bytes on the wire.
    const [courtID, jurors, disputeKitID] = decodeAbiParameters(
      UINT256_WORDS,
      encodeExtraData(words),
    );
    expect({ courtID, jurors, disputeKitID }).toEqual(words);
  });

  it("distinguishes the courts — three orders of magnitude of cost hang on it", () => {
    // A suite that only ever encodes X1 would not notice a court that is not
    // being encoded at all, which is the exact failure the 44-byte packed form
    // in the published documentation causes.
    const blobs = new Set(EXTRA_DATA_VECTORS.map((v) => encodeExtraData(v.words)));
    expect(blobs.size).toBe(EXTRA_DATA_VECTORS.length);
  });
});

describe("encodePacked", () => {
  it("is not reachable from any code path", async () => {
    // `spec/05 §1.1`. The packed form quotes and creates against the General
    // Court whichever court it names, silently — verified live across two
    // different court IDs (`spec/01 §4.4`). The only defence is that the call
    // does not exist in this tree.
    const entries = await readdir("src", { recursive: true, withFileTypes: true });
    const sources = entries
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => `${e.parentPath}/${e.name}`)
      .filter((path) => !path.includes("__tests__"));

    // Prose may name it — `extra-data.ts` forbids it by name, and a guard that
    // banned the word would forbid saying so. The call and the import are what
    // is checked.
    expect(sources.length).toBeGreaterThan(0);
    for (const path of sources) {
      const source = await readFile(path, "utf8");
      expect(source, `${path} calls encodePacked`).not.toMatch(/encodePacked\s*\(/);
      expect(source, `${path} imports encodePacked`).not.toMatch(/import[^;]*\bencodePacked\b/s);
    }
  });
});
