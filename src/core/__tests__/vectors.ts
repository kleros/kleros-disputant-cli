/**
 * The specification's test vectors, in one place.
 *
 * Every value here is transcribed from `docs/spec/02`, which marks each one
 * **[computed]** and its quote **[live]** on 2026-09-08. They are what bind the
 * payload builders to production: a change to an encoder or a serialiser that
 * these still accept is a change production would also accept.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite — importing
 * vectors must not re-run somebody else's assertions.
 */

/** `spec/02 §1.3` X1–X4, spanning three orders of magnitude of cost. */
export const EXTRA_DATA_VECTORS = [
  {
    name: "X1 — General Court, 3 jurors, Classic",
    words: { courtID: 1n, jurors: 3n, disputeKitID: 1n },
    blob:
      "0x0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "0000000000000000000000000000000000000000000000000000000000000001",
    costWei: 15000000000000000n,
    costEth: "0.015",
  },
  {
    name: "X2 — court 2, 5 jurors, Classic",
    words: { courtID: 2n, jurors: 5n, disputeKitID: 1n },
    blob:
      "0x0000000000000000000000000000000000000000000000000000000000000002" +
      "0000000000000000000000000000000000000000000000000000000000000005" +
      "0000000000000000000000000000000000000000000000000000000000000001",
    costWei: 34500000000000000n,
    costEth: "0.0345",
  },
  {
    name: "X3 — court 29, 7 jurors, Classic",
    words: { courtID: 29n, jurors: 7n, disputeKitID: 1n },
    blob:
      "0x000000000000000000000000000000000000000000000000000000000000001d" +
      "0000000000000000000000000000000000000000000000000000000000000007" +
      "0000000000000000000000000000000000000000000000000000000000000001",
    costWei: 37800000000000000n,
    costEth: "0.0378",
  },
  {
    name: "X4 — court 34, 3 jurors, Classic",
    words: { courtID: 34n, jurors: 3n, disputeKitID: 1n },
    blob:
      "0x0000000000000000000000000000000000000000000000000000000000000022" +
      "0000000000000000000000000000000000000000000000000000000000000003" +
      "0000000000000000000000000000000000000000000000000000000000000001",
    costWei: 810000000000000n,
    costEth: "0.00081",
  },
] as const;

/**
 * `spec/02 §3.5` T1. This exact payload simulates successfully against
 * `DisputeResolver` with X1's `extraData` and `value` 0.015 ETH **[live]**.
 */
export const TEMPLATE_T1 = {
  title: "Was the delivery completed as agreed?",
  description:
    "The buyer states the package arrived damaged. The seller states it was shipped intact.",
  question: "Should the escrowed funds be released to the seller?",
  answers: [
    { id: "0x1", title: "Yes", description: "Release the funds to the seller." },
    { id: "0x2", title: "No", description: "Return the funds to the buyer." },
  ],
  policyURI: "/ipfs/QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm",
  arbitratorChainID: "42161",
  arbitratorAddress: "0x991d2df165670b9cac3B022f4B68D65b664222ea",
  version: "1.0",
} as const;

/**
 * The `arbitratorAddress` Kleros's published template examples pair with chain
 * `42161` — **[abi]** `xKlerosLiquidAddress` for chain `100`, the Kleros v1
 * arbitrator on Gnosis, so the example is wrong in both fields at once
 * (`spec/02 §3.1`). Here to be **recognised**, never to be called: it is the
 * value ADR-0010 named as motivating a strict authoring schema, and the one that
 * schema did not catch until `spec/02 §3.2` landed.
 */
export const PUBLISHED_EXAMPLE_ARBITRATOR = "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002";

export const TEMPLATE_T1_BYTES = 555;
export const TEMPLATE_T1_KECCAK =
  "0x57c84f487148d5272dc1579c209116d8ea7a057a56b19ef139d0df41fbaf916d";

/** `spec/02 §4.4` E1–E3. */
export const EVIDENCE_VECTORS = [
  {
    name: "E1 — text only",
    document: {
      name: "Delivery photographs",
      description: "The package arrived damaged; see the attached photographs.",
    },
    byteLength: 106,
    keccak: "0x8314e0c856eabbffdbad22ed6112133b586b998cc2d10cbdb8bbf71d32137cca",
  },
  {
    name: "E2 — with an attachment",
    document: {
      name: "Delivery photographs",
      description: "The package arrived damaged; see the attached photographs.",
      fileURI: "/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
      fileTypeExtension: "pdf",
    },
    byteLength: 197,
    keccak: "0x84cfe72121367ff3afa6132ebcb36ae0474db5e556fe5607c97fd05558358ae3",
  },
  {
    name: "E3 — escaping and non-ASCII",
    document: {
      name: "Réponse — 反論",
      description: 'Quotes "inside", a backslash \\ and a newline\nhere.',
    },
    byteLength: 101,
    /** UTF-16 code units. The two MUST NOT be conflated. */
    utf16Length: 94,
    keccak: "0xc6ec4d8fc8ffaa268bf6573bce5458640da5ef710dce7d4b240fb4f7143dd237",
  },
] as const;
