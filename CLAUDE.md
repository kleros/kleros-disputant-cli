# kleros-disputant-cli

Headless TypeScript CLI that creates Kleros v2 disputes and submits evidence on the **v2 Beta**
deployment on Arbitrum One (chain 42161) and the **v2 testnet** on Arbitrum Sepolia (421614).
One-shot commands, no daemon. Binary: `kleros-disputant`.

**This tool files a case; it does not build one.** The claim, the evidence text, the court and the
ruling options are always inputs — `CONTEXT.md` draws the filing/case-construction line and
`ADR-0001` says why it falls there.

**The primary consumer is an autonomous LLM agent, not a human at a terminal.** A human is a debug
surface only, so the CLI must be self-documenting.

**`docs/spec/` is normative, and this repo had no inherited specification** — one was written here
from the deployed contracts and pinned with vectors verified live on 2026-09-08. Read it before
writing domain logic and cite it by section (`spec/01 §4.4`). It **supersedes the bootstrapping
handoff** the repo was seeded from, and `spec/appendix-a §3` quotes every superseded claim before
correcting it, because each one is a claim someone already believed — including two of the spec's
own, which the fork tests overturned (`spec/appendix-a §3.5`).

Status: bootstrapping. `src/core/`, `src/commands/` and the fork tests are complete — the pure
functional core, the deployment pinned by a fingerprint test, the read layer, the transaction path,
the five commands on incur, and `spec/05 §2`'s seven fork tests, which **broadcast on a fork** and
settled three of Appendix A's five unverified claims. The skill and `README.md` are written;
`upload-file` was added out of order on maintainer instruction and **has run against the live
endpoint**. Nothing published to npm, and **no transaction broadcast on Arbitrum One**. Next is
**v2 testnet support**, specced and ticketed in `.scratch/testnet-support/`: it precedes the
acceptance test, which moves from a pinned fork to the live testnet and whose `pnpm test:acceptance`
still points at a file that does not exist. Tickets 01, 02 and 03 are done — the
deployment model (`ADR-0015`), the evidence identifier defect, which was a **Beta** defect the
testnet exposed, not testnet scope (`ADR-0014`), `--chain`, and **ticket 04 — the v2 testnet
served**, with per-deployment ABIs, the RPC override variables honoured (`ADR-0016`) and a
differential test pinning that the two deployments answer identically, and **ticket 06 — the
stranger-facing sweep**, which also fixed a `pnpm build` broken since 04 (the bundler alias in
`build/` is reached only by the build, never by the suite; `build-alias.test.ts` now guards it).
**Ticket 08 retired the bootstrapping handoff** the repo was seeded from, rehousing its live content
and leaving `citations.test.ts` to hold the rule that a citation resolves in a fresh clone. Still
open: **05**, live acceptance, which waits on a funded testnet key, and **07**, which precedes the
first Arbitrum One broadcast.

```
pnpm test             # unit + guard tests. A suite whose prerequisite is absent self-skips loudly
pnpm test:fork        # spawn an Arbitrum One fork on :8546 and run only the fork tests.
                      # The only tests that broadcast, and the only ones that can seed the state
                      # production lacks: an overpayment, and a second arbitrable.
                      # Free :8546 first — docs/knowledge/fork-harness-port-8546.md
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
  influence which call is made or with what arguments. The one read-back — `upload-file` fetching a
  CID it just created, to compare against bytes it already holds — is not an exception to this and
  `ADR-0012` says why. `ADR-0007`, `spec/02 §4.3`
- **Creating a dispute spends money and cannot be undone.** Quote `arbitrationCost` with the
  byte-identical `extraData` immediately before sending, send **exactly** that, state the value in
  the envelope, and enforce the cost ceiling locally before simulating. Underpaying reverts;
  overpaying does not, and **the excess is never refunded — it buys jurors nobody asked for**
  (`[fork]`, settled). `ADR-0004`, `spec/01 §3.2`
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
- **`--broadcast false` means *true*, and so does `--publish false`.** incur's boolean flags never
  read a following word as a value; the word is dropped in silence. The off switch is omitting the
  flag. Never write one into an example or a doc. `boolean-flags.test.ts` pins it.
- **Fees are paid in ETH only.** The ERC-20 path is unresolved, so there is **no `--fee-token`
  flag**: the broken path cannot be asked for. `ADR-0008`
- **Failure semantics live in the JSON payload, not the exit code.** The consuming agent sees
  stdout and stderr merged into one buffer and an effectively binary exit status — so JSON on
  stdout, output kept small, a stable `code` on every error. There is **no `--verbose` and no
  `--json` flag**; JSON comes from `format: "json"`. Never document a flag that does not exist.
  `spec/03 §5`
- **incur's error envelope is closed.** A fact the caller needs goes in `message`, in
  `details.hint` (appended to `message`), or in the `cta` — and nowhere else. **No output mode
  renders `details`**, so any other key on it is invisible to callers. `ADR-0013`
- **A chain ID does not name a deployment** — at least three share 421614. What is pinned is a
  deployment: the `eth_chainId` assertion is a runtime check against *that deployment's* expected
  ID, never a viem `chain:` field, and **no contract call may precede it**. `--chain` (alias `-c`)
  selects one, defaults to `arbitrum-one` and is the **only** thing that can — never the
  environment, never a config file. It is declared **per command**, because incur's globals never
  reach the MCP tool schemas. Two slugs are served — `arbitrum-one` and
  `arbitrum-sepolia-testnet` — and an unserved one is `CHAIN_NOT_SUPPORTED`, refused before
  anything is contacted. **The two ABI namespaces are not interchangeable**, so they are bound per
  deployment. `ADR-0015`, `spec/01 §1.0b`, `spec/03 §7`
- **The environment configures transport, never target.** `KLEROS_RPC_URL_<SLUG>` picks an
  endpoint, below `--rpc-url` and above the default. There is deliberately **no** variable that
  applies to whichever deployment is selected, and none that selects one. `ADR-0016`
- **Discovery happens upstream**, in `@kleros/agentkit`. Reads here are limited to what is needed
  to **refuse a bad write** — or, in exactly one case, to decide **what** is signed, where the
  alternative is a write that cannot be read back. A read that does neither does not belong here.
  `ADR-0001`, `ADR-0014`, `CONTEXT.md`
- **No subgraph, and HTTP in exactly one command.** The write plane must not depend on an indexer
  to decide whether to sign. `upload-file` pins an attachment and is the only command that speaks
  HTTP: it never signs, reads the chain or loads a key, and `submit-evidence` **must not** grow a
  `--file` flag — a dry run would have to publish or lie. The credential surface is still exactly
  one signing key, because the endpoint is unauthenticated. A URI the operator *hands* the tool is
  still never dereferenced. `ADR-0012` reverses `ADR-0009`; `spec/06` has what was measured.
- **`submitEvidence` has no access control, no payment and no period gate**, so period discipline
  is this CLI's own policy: it **warns and never refuses**. Both hard refusals are unreachability,
  not loss — the subgraph indexes the evidence either way, so claiming the chain would reject it is
  false: a core dispute ID that does not exist, and one belonging to another arbitrable.
  `ADR-0011`, `ADR-0014`, `spec/02 §4.2`
- **What `submitEvidence` is given is the LOCAL dispute ID, not the core one `--dispute` takes.**
  The evidence group is keyed by it and the Court client resolves by it; the two coincide on
  Arbitrum One only because `DisputeResolver` created every dispute there. Check
  `disputes().arbitrated` **before** trusting `arbitratorDisputeIDToLocalID` — it is a mapping
  getter, so a foreign dispute reads as `0`, and `0` is a real dispute. Never report the local ID.
  `ADR-0014`, `spec/02 §4.2`
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
- `docs/knowledge/` — traps that fit nowhere else: what a green fork run may not prove, and why an
  elided address must never be expanded by hand.
- `docs/agents/domain.md` — the convention the engineering skills follow.

The **CLI surface is machine-checked** against the glossary: `vocabulary.test.ts` renders `--help`,
`--llms` and `--llms-full` and fails on any term that is wrong in every role a description can put
it in. Its list is narrower than the `_Avoid_` lines on purpose — read the comment before widening
it. Prose is not checked, so `README.md` and `CONTEXT.md` may name a banned term to contrast it.

`README.md` is the only doc written for a stranger, so a change to the command surface, the option
defaults or the JSON envelope is a change to it too. It restates few surfaces on purpose — options
point at `--help`, addresses at `ADR-0006` — and its Roadmap names nothing its Status table lists,
which is the contradiction still live in the juror repo's README.

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

There was a third source, the untracked root note this repo was bootstrapped from. **It is
retired** — its build order is spent, `docs/spec/` superseded its chain facts and `CONTEXT.md` its
vocabulary, and `spec/appendix-a §3` names it, says what it was and quotes every claim it got wrong.
`.gitignore` carries its filename so it cannot be committed by accident. Do not reintroduce it and
do not cite it: `citations.test.ts` fails a reader-facing document that points at a file a fresh
clone does not have.

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
