# Kleros disputant CLI: specification

Specifications for a headless TypeScript CLI that creates Kleros v2 disputes and submits evidence
on **Arbitrum One**, without a browser and without a human at the terminal.

Status: **draft**, derived from the deployed contracts.
Target: Kleros v2 beta production deployment on Arbitrum One, `KlerosCore` `0.10.0`.

This document set is what `HANDOFF_DISPUTANT_CLI.md` §10 step 6 calls for. It supersedes §14 of
that handoff: where the two disagree, this specification is correct and §14 is the earlier draft.
The disagreements are listed in [Appendix A](./appendix-a-unresolved.md) §3, because each one is a
claim someone already believed.

## Scope at a glance

| Aspect | Decision |
| --- | --- |
| Network | Arbitrum One (chain ID 42161) only |
| Write surface | `DisputeResolver.createDisputeForTemplate`, `EvidenceModule.submitEvidence` |
| Entry point | `DisputeResolver`. An EOA **cannot** call `KlerosCore.createDispute` |
| Dispute kits | Classic (ID 1). Shutter, Gated and GatedShutter are out of scope; the ruler kits are refused by name |
| Fee token | ETH only. The ERC-20 path is unresolved — [Appendix A §1](./appendix-a-unresolved.md) |
| Template | Inline in calldata. The `…ForTemplateUri` path is specified but not shipped in v1 |
| Evidence | Inline JSON. Never a bare URI |
| Shape | One-shot commands. No daemon, no watcher, no scheduling |
| Inputs | Court, juror count, template body, ruling options, evidence text and every URI are **operator-supplied** |
| IPFS | Referenced, never pinned. No HTTP client, no credential beyond the signing key |
| Stack | TypeScript, `incur ~0.4.19`, `viem ^2.55.19`, Node ≥ 22 |

## Documents

| # | Document | Read it for |
| --- | --- | --- |
| 00 | [Overview](./00-overview.md) | Purpose, non-goals, actors, both write flows, the normative summary |
| 01 | [On-chain reference](./01-onchain-reference.md) | Verified contract surface, ABI provenance, reverts, events, the three dispute IDs |
| 02 | [Payload construction](./02-payload-construction.md) | The functional core: `extraData`, cost arithmetic, template and evidence JSON, test vectors |
| 03 | [CLI surface](./03-cli-surface.md) | Commands, options, exit codes, the JSON envelope, key handling |
| 04 | [Transaction relaying](./04-transaction-relaying.md) | Simulate, estimate, send, track. Where `value` threads through |
| 05 | [Verification](./05-verification.md) | Test plan and acceptance criteria |
| A | [Appendix A: unresolved](./appendix-a-unresolved.md) | Every claim not verified, and every §14 claim this document corrects |

## Reading order

`01` establishes the facts. `02` is the heart of the specification and depends on `01`. `03` and
`04` are engineering concerns that depend on `02`. Read `00` first for orientation, and read
[Appendix A](./appendix-a-unresolved.md) before you rely on anything load-bearing.

## Conventions

- Normative statements use RFC 2119 keywords: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**,
  **MAY**. Everything else is informative.
- Vocabulary is governed by [`CONTEXT.md`](../../CONTEXT.md), and the CLI surface is machine-checked
  against it by `vocabulary.test.ts`. This specification uses the same terms.
- Every factual claim about the chain is traceable to a deployment artifact, a source file, or a
  recorded on-chain read.

### Verification markers

| Marker | Meaning |
| --- | --- |
| **[live]** | Verified by `eth_call` or `eth_getLogs` against Arbitrum One on **2026-09-08**, at block `503066782` (chain time `1788881785`). Reproduce with [05 §4](./05-verification.md) |
| **[fork]** | Verified against the **deployed bytecode** on an Arbitrum One fork, in a state the chain could reach but has not — an overpayment, a second arbitrable. Reproduce with `pnpm test:fork` ([05 §2](./05-verification.md)) |
| **[abi]** | Read from `@kleros/kleros-v2-contracts@2.0.0-rc.2`, `cjs/deployments`. These ABIs are the deployed ones |
| **[computed]** | Produced locally by `viem` and reproducible offline — selectors, encodings, hashes |
| **[client]** | Read from the Kleros web client or subgraph source, not from the chain. **Not verified** |
| **[inferred]** | Reasoned from source that is not the deployed code. **Not verified** |
| **[maintainer]** | Stated by the Kleros v2 maintainers. Authoritative for intent and roadmap; **not** a substitute for a code-level check of what is deployed |

**[client]** and **[inferred]** claims MUST NOT be depended on without a fork test. They are
collected in [Appendix A](./appendix-a-unresolved.md). A claim that a fork test has since settled is
re-marked **[fork]** and moves out of that appendix; **[fork]** is stronger than **[live]** for
anything production has never done, because production has no sample of it to read.

> The `.sol` sources shipped in `@kleros/kleros-v2-contracts` are compiled from `master` and are
> **not** the deployed code. They disagree with the deployment for exactly the contracts this tool
> uses. Where this specification says **[abi]** it means the deployment artifact's ABI, which is
> accurate; a claim read from the package's Solidity is **[inferred]** and marked so.
