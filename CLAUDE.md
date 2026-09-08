# kleros-disputant-cli

Headless TypeScript CLI that creates Kleros v2 disputes and submits evidence on **Arbitrum One**
(chain 42161). One-shot commands, no daemon. Binary: `kleros-disputant`.

**This tool files a case; it does not build one.** The claim, the evidence text, the court and the
ruling options are always inputs. Nothing here decides whether a claim is worth bringing, drafts a
word of it, or reads what the other side wrote — see `CONTEXT.md` for the filing/case-construction
line and `docs/adr/0001` for why it falls there.

**The primary consumer is an autonomous LLM agent, not a human at a terminal.** A human is a debug
surface only, so the CLI must be self-documenting. Unlike its sibling `kleros-juror-cli`, this repo
has **no inherited specification**. One must be written here — `docs/spec/`, derived from the
deployed contracts and pinned with live-verified vectors — and **it does not exist yet**; it is
step 6 of the build order, and `HANDOFF_DISPUTANT_CLI.md` §14 is roughly its first 40%. Until it
lands, a normative claim cites the contract and function by name rather than a section number
nobody can honour.

Status: bootstrapping. Documentation and guards only — steps 1–5 of the build order. No domain
logic, no commands, nothing published to npm, no transaction ever broadcast.

```
pnpm test             # unit + guard tests (a suite whose prerequisite is absent self-skips loudly)
pnpm test:fork        # spawn an Arbitrum One fork on :8546 and run only the fork tests   [step 12]
pnpm test:acceptance  # full lifecycle on a pinned fork; needs an archive RPC             [step 14]
pnpm typecheck
pnpm lint             # biome check .   (`pnpm exec biome check --write .` to fix)
```

## Invariants

Guard rails that hold before you have read anything else. Where one rests on a specific contract,
function or decision, it names it; the rest are general posture and cite nothing because there is
nothing to cite. Where an ADR overrides a contract's apparent affordance, the ADR wins and is
named. A claim marked **inferred** has not been verified against the deployed code — do not build
on it without a fork test.

- **Evidence is operator-supplied and opaque.** This tool writes content the operator authored. It
  never reads, fetches or interprets counterparty content, and never dereferences a URI found in
  on-chain data. Evidence is bytes on the way to a transaction: never parsed, never interpolated
  into anything executable, never allowed to influence which call is made or with what arguments.
  `ADR-0007`
- **Creating a dispute spends money and cannot be undone.**
  `DisputeResolver.createDisputeForTemplate` is payable and forwards `msg.value` wholesale to
  `KlerosCore.createDispute`, which computes `round.nbVotes = _feeAmount / feeForJuror`. So:
  quote `KlerosCore.arbitrationCost(extraData)` with the byte-identical `extraData` immediately
  before sending, send **exactly** that, and state the value in the envelope. A cost ceiling is
  enforced locally, before simulating. `ADR-0004`
  > **The no-refund behaviour is inferred, not verified.** That overpaying buys extra jurors
  > rather than returning change is read from `master` source, and `master` is not the deployed
  > code. It is the most expensive unverified claim this repo relies on, so treat sending exactly
  > `arbitrationCost` as the rule regardless, and settle it with the fork test that asserts
  > `value == arbitrationCost` — which is on the done-list precisely because it also answers this.
- **`extraData` fails silently — pre-flight is the only defence.** `_arbitratorExtraData` is three
  32-byte words (court ID, juror count, dispute kit ID). A wrong court ID, a zero juror count or a
  malformed blob **does not revert**: the decoder substitutes General Court / default jurors /
  Classic and creates a paid dispute in the wrong court. `simulateContract` cannot catch this, so
  it is not a second layer here — it is absent. Therefore: validate the court against
  `courts.length` and its `disabled` flag, call `isSupported(courtID, disputeKitID)` **every time**
  and never cache it, refuse with a named code rather than letting the fallback fire, and **echo
  the effective court, juror count and kit in the envelope, not the requested ones** — a difference
  between them is an error, not a warning. Never send a 64-byte blob: the length guard is `>= 64`
  while the decoder reads to offset `0x60`. `KlerosCore._extraDataToCourtIDMinJurorsDisputeKit`
- **A broadcast whose receipt never arrives MUST NOT be retried blindly.** `status: "unknown"` is a
  success, not a failure: the tool stopped watching, the transaction may still land. A blind
  re-send of `createDispute` pays the arbitration cost a second time and creates a second dispute.
  The message must say so in words. `ADR-0004`
- **Simulate every state-changing call, and broadcast only on explicit `--broadcast`.** The default
  is plan → simulate → stop. There is no human confirmation gate and nothing upstream provides one.
  `ADR-0004`
- **Fees are paid in ETH only.** `KlerosCore.arbitrationCost(extraData, WETH)` returns a value 10×
  the ETH quote for the same dispute and the deployed 0.10.0 rate formula could not be read, so the
  ERC-20 path is unresolved. There is **no `--fee-token` flag** — the broken path cannot be asked
  for. `ADR-0008`
- **Failure semantics live in the JSON payload, not the exit code.** The consuming agent sees
  stdout and stderr merged into one buffer and an effectively binary exit status. JSON on stdout,
  output kept small, a stable `code` field on every error. Exit codes stay stable for shell
  callers, but they are not the machine contract. There is **no `--verbose` flag and no `--json`
  flag**; JSON comes from `format: "json"`. Do not document flags that do not exist.
- **Chain 42161 only**, enforced as a runtime `eth_chainId` assertion and not merely a viem
  `chain:` field. The chain assertion runs strictly **before** any deployment registry lookup: a
  registry lookup is scoped to a deployment, and trusting it on an unverified chain reads the
  wrong core.
- **Discovery happens upstream.** This tool does not find arbitrables, read disputes, resolve
  dispute templates or list evidence. That is `@kleros/agentkit`'s job — `kleros dispute brief`,
  `dispute get`, `dispute policy`, `court get`, `arbitrable classify`, `evidence list`. Reads here
  are limited to what is needed to **refuse a bad write**; a read that cannot change the decision
  to sign does not belong here. `ADR-0001`
- **RPC only — no subgraph, no pinning, no HTTP client.** The read plane may depend on an indexer;
  the write plane must not depend on one to decide whether to sign. The tool never pins to IPFS:
  the template body travels inline in calldata and the evidence string is inline JSON, so
  `--policy-uri`, `--template-uri` and `--file-uri` are inputs the caller supplies. The credential
  surface stays at exactly one signing key. `ADR-0009`
- **`submitEvidence` has no access control, no payment and no period gate.** Any period discipline
  is this CLI's own policy, not a contract guarantee — so it **warns, and never refuses**. The one
  hard refusal is a core dispute ID that does not exist, because the subgraph drops evidence for an
  unknown dispute on the floor. Do not add a client-side party check and present it as a guarantee.
  `ADR-0011`
- **Never print the private key**, and never accept one from the environment or the command line.
- **The disputant is not the juror.** A different actor, a different key. This tool cannot detect a
  violation on chain, so it is an operator responsibility — say so, and do not promise a check that
  has not been implemented.

Dispute creation is untimed: you choose when to file, so there is no urgency rhetoric here. The
evidence period is bounded but loosely, and it is not enforced on chain. Still fail loudly and
fast; never retry quietly.

## Stack

`incur` (pinned `~0.4.19`, tilde and never caret, as `@kleros/agentkit` pins it) · `viem` ·
Node >=22. Runtime dependencies are exactly those two. Runtime truth: `package.json`.

Addresses and ABIs are **imported** from `@kleros/kleros-v2-contracts`, never hand-copied. It stays
a **devDependency** because tsup bundles it (`ADR-0006`). Importing the package root throws
`ReferenceError: exports is not defined in ES module scope` — verified against `2.0.0-rc.2`, which
is still `latest` — so use the `cjs/deployments` subpath, which the `exports` map **does** declare.
Paths *below* it do not, which is why the build shim reaches its leaf modules by relative path.

> The package's `.sol` sources are compiled from `master` and are **not the deployed code**. They
> diverge for exactly the contracts this tool needs: the deployed `DisputeResolver` exposes
> `governor()` rather than `owner()`, has both create functions, emits a 5-argument
> `DisputeRequest`, and carries **zero custom errors** — so a live revert arrives as raw data with
> no name and `reverts.ts` must map **by selector, not by name**. Bind to `mainnetViem.*Abi` and
> pin a fingerprint test; that test is what makes the import safe rather than merely convenient.

Do **not** add `@kleros/kleros-sdk` as a runtime dependency: its `DisputeDetailsSchema` is a
*lenient* parser for third-party blobs, and an authoring schema must be **strict** — the exact
inverse. It also pulls `zod@^3`, against incur's v4. This repo hand-writes a strict schema and
imports the SDK's compiled one **only in a devDependency test**, to assert what we emit is accepted
by the canonical definition. `ADR-0010`

Layout mirrors `@kleros/agentkit` so an eventual port is close to a file move: framework-free
`src/core/` returning `KlerosResult<T>`, thin `src/commands/` owning incur, exit codes and CTA
blocks. Core never throws; try/catch lives only at boundaries and converts to `err(...)`
immediately. `ADR-0001`

Suites that need a prerequisite (an Arbitrum One fork, an archive RPC) **self-skip at module scope
and announce it with `console.warn`**, rather than being excluded by config — a skipped suite must
be visible in the run output, never silently green. That idiom needs
`disableConsoleIntercept: true`, which is already set: vitest 4 otherwise prints console output
only for *failing* files and swallows the warning entirely. Verified against 4.1.11; do not remove
it.

Two incur facts that cost time if rediscovered: `z` is re-exported by incur (zod v4 internally) and
must be imported from `incur`, never from `zod`. And incur prefixes the binary name onto every CTA
command, so a CTA can only ever be a subcommand of this CLI — shell remedies go in `details.hint`,
which is the only part of `details` that reaches the user.

## Domain docs

`CONTEXT.md` is the glossary — use its terms, avoid the synonyms it lists. `docs/adr/` records the
decisions a reader would otherwise question. Convention: `docs/agents/domain.md`.

| ADR | Decision |
| --- | --- |
| [0001](docs/adr/0001-standalone-repo-shaped-for-upstreaming.md) | Standalone repo, shaped for upstreaming into `@kleros/agentkit` |
| [0002](docs/adr/0002-no-coinbase-agentkit-action-provider.md) | No Coinbase AgentKit action provider |
| [0004](docs/adr/0004-broadcast-is-opt-in-no-human-gate.md) | Broadcast is opt-in, and there is no human confirmation gate |
| [0006](docs/adr/0006-deployment-imported-from-contracts-package.md) | Addresses and ABIs come from the contracts package, bundled at build time |
| [0007](docs/adr/0007-evidence-is-opaque-operator-supplied-bytes.md) | Evidence is opaque, operator-supplied bytes |
| [0008](docs/adr/0008-arbitration-fees-are-paid-in-eth-only.md) | Arbitration fees are paid in ETH only |
| [0009](docs/adr/0009-the-cli-references-ipfs-and-never-pins.md) | The CLI references IPFS content and never pins it |
| [0010](docs/adr/0010-a-strict-authoring-schema-not-the-sdk-parser.md) | A strict authoring schema, not the SDK's lenient parser |
| [0011](docs/adr/0011-evidence-period-pressure-warns-and-never-refuses.md) | Evidence-period pressure warns, and never refuses |

Numbers 0003 and 0005 are **deliberately unused**: they are juror-only decisions (seed derivation;
hand-pinned ABI fragments) that this repo never made. The gaps keep ADR numbers comparable across
the two repos, which is what makes `ADR-0004` mean the same thing in both.

The **CLI surface is machine-checked** against that glossary: `vocabulary.test.ts` renders `--help`,
`--llms` and `--llms-full` and fails on any term that is wrong in every role a description can put
it in. Its list is narrower than the `_Avoid_` lines on purpose — read the comment before widening
it. Prose is not checked, so `README.md` and `CONTEXT.md` may still name a banned term in order to
contrast it.

`README.md` — **not written yet; step 13** — is the only doc written for a stranger. It will
restate the command surface, the option defaults and the JSON envelope, so once it exists a change
to any of those is a change to it too. Keep the restated surfaces few: the juror repo shows the
failure mode, its Status table still listing a command its Roadmap checks off.

## Reference material

Read-only, outside this repo, via **gitignored symlinks** — absent in a fresh clone. Neither is a
build dependency; both exist to be read.

| Symlink | Recreate with |
| --- | --- |
| `reference/kleros-juror-cli` | `ln -s ../../kleros-juror-cli reference/kleros-juror-cli` |
| `reference/agentkit` | `ln -s ../../agentkit reference/agentkit` |

`kleros-juror-cli` @ `b07420c` is the sibling write plane and the source of this repo's
architecture. Three of its claims are **known defects — do not copy them forward**: its `CLAUDE.md`
and `SKILL.md` cite a `kleros juror draws` command that does not exist in AgentKit; its `CLAUDE.md`
documents a `--verbose` flag that was never implemented; and its `ADR-0006` says the contracts
package's `exports` map "declares no deep subpaths" when `./cjs/deployments` is in fact declared.

`agentkit` is `@kleros/agentkit` @ 0.2.0, the **read plane**. Precise phrasing matters: it performs
**no on-chain writes**, but it does write locally and POST to GitHub, so "no on-chain writes" is
accurate where "read-only" is not. Treat it as a **peer CLI the agent also calls**, never as a
library — its `exports` map exposes only `.`.

`HANDOFF_DISPUTANT_CLI.md` at the repo root is the bootstrapping plan: §10 the build order, §14 the
twice-verified contract facts, §15 the vocabulary. Items in §14 marked *(inferred)* or
*(client-sourced)* are **not** verified — fork-test them before depending on them.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

## Process

- Conventional prefixes (`feat` / `fix` / `docs` / `chore` / `test` / `build`), imperative subject,
  lowercase after the colon, no trailing period. Bodies are essays: what was verified live, which
  requirement is closed, which ADR is overridden and why, costs accepted, who verified it.
- Documentation before code. Steps 1–5 of the build order are entirely documents and guards, and
  the vocabulary guard goes in **early** — in the juror repo it landed at commit 19 of 24 and
  immediately found drift across three separate surfaces.
