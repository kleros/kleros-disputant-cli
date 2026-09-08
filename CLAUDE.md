# kleros-disputant-cli

Headless TypeScript CLI that creates Kleros v2 disputes and submits evidence on **Arbitrum One**
(chain 42161). One-shot commands, no daemon. Binary: `kleros-disputant`.

**This tool files a case; it does not build one.** The claim, the evidence text, the court and the
ruling options are always inputs — `CONTEXT.md` draws the filing/case-construction line and
`ADR-0001` says why it falls there.

**The primary consumer is an autonomous LLM agent, not a human at a terminal.** A human is a debug
surface only, so the CLI must be self-documenting.

**`docs/spec/` is normative, and this repo had no inherited specification** — one was written here
from the deployed contracts and pinned with vectors verified live on 2026-09-08. Read it before
writing domain logic and cite it by section (`spec/01 §4.4`). It **supersedes
`HANDOFF_DISPUTANT_CLI.md` §14**, and `spec/appendix-a §3` lists every disagreement, because each
one is a claim someone already believed.

Status: bootstrapping. `src/core/` holds the pure functional core plus the resolved deployment,
pinned by a fingerprint test; still no commands, no `README.md`, nothing published to npm, no
transaction ever broadcast. Step 9 is next. Build order: `HANDOFF §10`.

```
pnpm test             # unit + guard tests. A suite whose prerequisite is absent self-skips loudly
pnpm test:fork        # spawn an Arbitrum One fork on :8546 and run only the fork tests
pnpm test:acceptance  # full lifecycle on a pinned fork; needs an archive RPC
pnpm typecheck
pnpm lint             # biome check .   (`pnpm exec biome check --write .` to fix)
```

## Invariants

Guard rails that hold before you have read anything else. Each names where the full story lives —
and a claim marked **inferred** there has not been verified against the deployed code, so do not
build on it without a fork test. Where an ADR overrides a contract's apparent affordance, the ADR
wins and is named.

- **Evidence is operator-supplied and opaque.** Never read, fetch or interpret counterparty
  content; never dereference a URI found in on-chain data. Evidence is bytes on the way to a
  transaction: never parsed, never interpolated into anything executable, never allowed to
  influence which call is made or with what arguments. `ADR-0007`, `spec/02 §4.3`
- **Creating a dispute spends money and cannot be undone.** Quote `arbitrationCost` with the
  byte-identical `extraData` immediately before sending, send **exactly** that, state the value in
  the envelope, and enforce the cost ceiling locally before simulating. The chain protects you
  against underpaying, not against overpaying. `ADR-0004`, `spec/01 §3.2`
- **`extraData` fails silently — pre-flight is the only defence.** A wrong court ID, a zero juror
  count or a malformed blob does **not** revert: the decoder substitutes General Court / default
  jurors / Classic and creates a paid dispute in the wrong court, so `simulateContract` cannot
  catch it. Validate the court, call `isSupported` **every time** and never cache it, refuse with a
  named code, never send a 64-byte blob, and **echo the effective court, juror count and kit in the
  envelope, not the requested ones** — a difference between them is an error, not a warning.
  `spec/01 §4.4`
- **A broadcast whose receipt never arrives MUST NOT be retried blindly.** `status: "unknown"` is a
  success, not a failure: the tool stopped watching, the transaction may still land. A blind
  re-send pays the arbitration cost a second time and creates a second dispute — say so in words.
  `ADR-0004`
- **Simulate every state-changing call, and broadcast only on explicit `--broadcast`.** The default
  is plan → simulate → stop. There is no human confirmation gate and nothing upstream provides one.
  `ADR-0004`
- **Fees are paid in ETH only.** The ERC-20 path is unresolved, so there is **no `--fee-token`
  flag**: the broken path cannot be asked for. `ADR-0008`
- **Failure semantics live in the JSON payload, not the exit code.** The consuming agent sees
  stdout and stderr merged into one buffer and an effectively binary exit status — so JSON on
  stdout, output kept small, a stable `code` on every error. There is **no `--verbose` and no
  `--json` flag**; JSON comes from `format: "json"`. Never document a flag that does not exist.
  `spec/03 §5`
- **Chain 42161 only**, enforced as a runtime `eth_chainId` assertion and not merely a viem
  `chain:` field — and asserted **before** any deployment registry lookup, which is scoped to a
  deployment and reads the wrong core on an unverified chain. `spec/03 §7`
- **Discovery happens upstream**, in `@kleros/agentkit`. Reads here are limited to what is needed
  to **refuse a bad write**; a read that cannot change the decision to sign does not belong here.
  `ADR-0001`, `CONTEXT.md`
- **RPC only — no subgraph, no pinning, no HTTP client.** The write plane must not depend on an
  indexer to decide whether to sign, the tool never pins to IPFS, and the credential surface stays
  at exactly one signing key. Every URI is an operator-supplied input. `ADR-0009`
- **`submitEvidence` has no access control, no payment and no period gate**, so period discipline
  is this CLI's own policy: it **warns and never refuses**. The one hard refusal is a core dispute
  ID that does not exist, and the harm there is unreachability, not loss — the subgraph indexes it
  either way, so claiming the chain would reject it is false. `ADR-0011`, `spec/02 §4.2`
- **Never print the private key**, and never accept one from the environment or the command line.
- **The disputant is not the juror** — a different actor, a different key. This tool cannot detect
  a violation on chain, so it is an operator responsibility: say so, and do not promise a check
  that has not been implemented.

Dispute creation is untimed and the evidence period is bounded only loosely, so there is no urgency
rhetoric here. Still fail loudly and fast; never retry quietly.

## Stack

`incur` (pinned `~0.4.19`, tilde and never caret, as `@kleros/agentkit` pins it) · `viem` ·
Node >=22. Runtime dependencies are exactly those two. Runtime truth: `package.json`.

Addresses and ABIs are **imported** from `@kleros/kleros-v2-contracts`, never hand-copied. It stays
a **devDependency**; the package root does not import, so reach it through the `cjs/deployments`
subpath. The ABI fingerprint test is what makes the import safe rather than merely convenient.
`ADR-0006`

> The package's `.sol` sources are compiled from `master` and are **not the deployed code**. They
> diverge for exactly the contracts this tool needs — which is why `reverts.ts` needs both a string
> decoder and a selector table. `spec/01 §2, §5`

Do **not** add `@kleros/kleros-sdk` as a runtime dependency: an authoring schema must be strict and
its parser is deliberately lenient — the exact inverse — and it pulls a conflicting zod major.
`ADR-0010`

Layout mirrors `@kleros/agentkit` so an eventual port is close to a file move: framework-free
`src/core/` returning `KlerosResult<T>`, thin `src/commands/` owning incur, exit codes and CTA
blocks. Core never throws. `ADR-0001`, `spec/03 §8`

## Domain docs

- `CONTEXT.md` — the glossary. Use its terms, avoid the synonyms it lists.
- `docs/spec/` — the normative specification: RFC 2119 language, every chain fact marked with how
  it was verified, test vectors that bind the payload builders to production. Its `README.md` is
  the map, the reading order and the verification markers; do not restate it here.
- `docs/adr/` — one file per decision a reader would otherwise question. Numbers 0003 and 0005 are
  **deliberately unused**: juror-only decisions this repo never made, left as gaps so that
  `ADR-0004` means the same thing in both repos.
- `docs/agents/domain.md` — the convention the engineering skills follow.

The **CLI surface is machine-checked** against the glossary: `vocabulary.test.ts` renders `--help`,
`--llms` and `--llms-full` and fails on any term that is wrong in every role a description can put
it in. Its list is narrower than the `_Avoid_` lines on purpose — read the comment before widening
it. Prose is not checked, so `README.md` and `CONTEXT.md` may name a banned term to contrast it.

`README.md` will be the only doc written for a stranger, and once it exists a change to the command
surface, the option defaults or the JSON envelope is a change to it too. Keep the restated surfaces
few — the juror repo's Status table still lists a command its Roadmap checks off.

## Reference material

Read-only, outside this repo, via **gitignored symlinks** — absent in a fresh clone. Neither is a
build dependency; both exist to be read.

| Symlink | Recreate with |
| --- | --- |
| `reference/kleros-juror-cli` | `ln -s ../../kleros-juror-cli reference/kleros-juror-cli` |
| `reference/agentkit` | `ln -s ../../agentkit reference/agentkit` |

`kleros-juror-cli` is the sibling write plane and the source of this repo's architecture. Three of
its claims are **known defects — do not copy them forward**: a `kleros juror draws` command that
does not exist in AgentKit, a `--verbose` flag that was never implemented, and an `ADR-0006` that
says the contracts package declares no deep subpaths when `./cjs/deployments` is declared.

`agentkit` is the read plane, and a **peer CLI the agent also calls** — never a library; its
`exports` map exposes only `.`. It performs **no on-chain writes**, but it writes locally and POSTs
to GitHub, so "no on-chain writes" is accurate where "read-only" is not.

`HANDOFF_DISPUTANT_CLI.md` at the repo root is the bootstrapping plan: §10 the build order, §15 the
vocabulary. **§14 is superseded by `docs/spec/`** — read it only to understand where a stale belief
came from.

## Agent skills

- **Issue tracker** — issues live as markdown files under `.scratch/<feature-slug>/`. See
  `docs/agents/issue-tracker.md`.
- **Triage labels** — the five canonical roles, each label string equal to its name. See
  `docs/agents/triage-labels.md`.

## Process

- Conventional prefixes (`feat` / `fix` / `docs` / `chore` / `test` / `build`), imperative subject,
  lowercase after the colon, no trailing period. Bodies are essays: what was verified live, which
  requirement is closed, which ADR is overridden and why, costs accepted, who verified it.
- Documentation before code, and the vocabulary guard goes in **early** — in the juror repo it
  landed at commit 19 of 24 and immediately found drift across three separate surfaces.
- **Routing for a durable fact you just established**: a chain, cost or payload fact →
  `docs/spec/`; a decision a reader would question → `docs/adr/`; a word → `CONTEXT.md`; a quirk of
  a dependency → a comment where the mistake would be made (as `vitest.config.ts` does), or a new
  `docs/knowledge/` file if it fits nowhere. Add a line **here** only if it prevents a mistake on
  its own — one line and a pointer, never the prose.
- **This file is an index, not a knowledge base.** It should barely grow. Adding a line is a good
  moment to delete one that has gone stale.
