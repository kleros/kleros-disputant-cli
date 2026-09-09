# Spec: v2 testnet support on Arbitrum Sepolia

Status: ready-for-agent

Feature slug: `testnet-support`
Origin: `/grill-with-docs` session, 2026-09-09. Supersedes the root-level note
`env-vars-and-testnet-support.md`, which should be deleted once this spec lands.

## Problem Statement

This CLI files Kleros v2 disputes on one deployment only: v2 Beta on Arbitrum One. That was never
argued for — it was inherited, and then hardened into an invariant (`spec/03 §7`, "chain 42161
only") and into roughly forty sites across `src/`.

The consequences, from the caller's point of view:

- **There is nowhere to rehearse.** The primary consumer is an autonomous agent. Every path that
  creates a dispute or submits evidence spends real money, and no transaction has ever been
  broadcast on Arbitrum One from this tool. The first real broadcast would also be the first
  end-to-end exercise of the envelope, the signing path and the receipt.
- **The acceptance test cannot be written honestly.** `spec/05 §3` specifies a pinned fork. A fork
  proves determinism; it cannot prove that the tool works against real infrastructure.
- **An agent that also calls `@kleros/agentkit` sees two different worlds.** agentkit reads four
  chains and names them with slugs. This CLI takes no `--chain` at all, so an agent that has
  discovered a dispute on the v2 testnet has no way to act on it here, and no error that says so.

A measurement taken while specifying this feature found a second, larger problem. On the v2 testnet
the **core dispute ID and the external dispute ID diverge** — 42 of the 75 disputes created through
`DisputeResolver` have unequal IDs, first at core 58 against external 33, verified against contract
state as well as event logs. (Re-measured at a later block while implementing ticket 02: 77 resolver
disputes of 127, 50 foreign across 25 arbitrables. The divergence point is unchanged, and
`ADR-0014`'s table is the authority — these counts move with the chain.) `submit-evidence` keys evidence on the core dispute ID. Where the two
differ, evidence is accepted, mined, and indexed under an identifier that nothing resolves.

That is not a testnet problem. The code comment in the write path already says the equality holds
on Arbitrum One "only because `DisputeResolver` created every one of them". It is a property of
Arbitrum One's history, not of the contracts, and it expires the first time any other arbitrable
files a dispute there. Adding the testnet does not introduce this defect; it removes the
coincidence that hides it.

## Solution

Add a `--chain` option selecting one of two **deployments**, defaulting to `arbitrum-one` so every
existing invocation keeps its meaning. Fix the identifier defect as part of the same work, because
the testnet is the only place it can be observed.

From the caller's point of view:

- `--chain arbitrum-one` (v2 Beta) or `--chain arbitrum-sepolia-testnet` (v2 testnet), alias `-c`,
  on every command that touches the chain. `upload-file` does not take it.
- A named refusal, not silence, for the two slugs a caller could plausibly have learned from
  agentkit but which this tool does not serve.
- `KLEROS_RPC_URL_ARBITRUM_ONE` and `KLEROS_RPC_URL_ARBITRUM_SEPOLIA_TESTNET` override the default
  endpoint per deployment.
- Every envelope names the deployment it acted on, and every CTA carries `--chain`, so a replay
  cannot land somewhere else.
- `submit-evidence` resolves the core dispute ID to the arbitrable's local dispute ID before
  submitting, and refuses a dispute this tool cannot address.
- Identical mechanics on both deployments: same simulate-then-stop default, same cost ceiling, same
  explicit `--broadcast`. Only the reported values differ.

## User Stories

1. As an autonomous agent, I want to name the deployment I am filing on, so that a dispute I
   discovered through agentkit on the v2 testnet is actionable here.
2. As an autonomous agent, I want `--chain` to default to `arbitrum-one`, so that an invocation
   written before this feature existed still means what it meant.
3. As an autonomous agent, I want the option to appear in `--help` and `--llms` with each slug
   glossed by the name humans use for it, so that I can map "v2 Beta" in prose onto a flag value.
4. As an autonomous agent, I want the resolved deployment echoed in every envelope, success or
   failure, so that I never have to infer which deployment a result came from.
5. As an autonomous agent, I want every CTA to carry `--chain`, so that replaying a suggested
   command cannot silently target a different deployment.
6. As an autonomous agent, I want a named, stable error code when I ask for a deployment this tool
   does not serve, so that I can distinguish it from a transport failure and stop retrying.
7. As an autonomous agent, I want the refusal for the retired bare slug `arbitrum-sepolia` to name
   both replacements, so that I can correct my own call without asking a human.
8. As an autonomous agent, I want the refusal for `arbitrum-sepolia-devnet` to say why it is
   unsupported here even though agentkit reads it, so that I do not read the absence as a bug.
9. As an autonomous agent, I want an unsupported slug refused before anything is contacted, so that
   a bad argument costs no network round trip and no money.
10. As an autonomous agent, I want the same safety mechanics on both deployments, so that what I
    rehearse on the testnet is what will happen on v2 Beta.
11. As an autonomous agent, I want to submit evidence using the core dispute ID on either
    deployment, so that I never have to learn a second identifier.
12. As an autonomous agent, I want evidence to reach the identifier the Kleros Court client
    resolves, so that what I submit is readable rather than merely mined.
13. As an autonomous agent, I want a distinct refusal when a dispute exists but was created by
    another arbitrable, so that I do not mistake it for a dispute that does not exist and retry.
14. As an autonomous agent, I want that refusal to name the arbitrable that owns the dispute, so
    that I can tell the case is real and the tool is the limitation.
15. As an autonomous agent, I want `arbitration-cost` to quote the deployment I named, so that the
    figure I plan against is the figure that will be charged.
16. As an autonomous agent, I want the cost ceiling enforced on the testnet too, so that a
    misconfigured ceiling is caught in rehearsal rather than in production.
17. As an operator, I want to point each deployment at my own RPC endpoint through a named
    environment variable, so that I am not bound to a rate-limited public one.
18. As an operator, I want the environment to be unable to change which deployment is targeted, so
    that a stale shell variable cannot redirect a transaction that spends money.
19. As an operator, I want the environment variable names to match agentkit's, so that one exported
    variable serves both tools.
20. As an operator, I want a working default endpoint for each deployment, so that the testnet is no
    harder to reach than v2 Beta.
21. As an operator, I want `upload-file` to keep taking no `--chain`, so that the one command with
    no chain in it stays that way.
22. As a maintainer, I want the deployment's addresses and ABIs resolved from the contracts package
    per deployment, so that no address is ever hand-copied.
23. As a maintainer, I want a fingerprint test per deployment, so that an upstream regeneration
    breaks the build rather than a transaction.
24. As a maintainer, I want the ABI difference between the two deployments recorded, so that the
    next reader does not assume the shapes are interchangeable.
25. As a maintainer, I want the chain assertion to compare against the selected deployment's chain
    ID, so that a misdirected endpoint is caught before any contract call.
26. As a maintainer, I want no contract call to occur before that assertion, so that the safety
    property the old ordering protected survives the flag.
27. As a maintainer, I want one differential test proving the two deployments behave identically,
    so that "identical mechanics" is a pinned property rather than a promise.
28. As a maintainer, I want the identifier-divergence tests written against the v2 Beta double, so
    that the defect is recorded as reachable there rather than as a testnet quirk.
29. As a maintainer, I want a full lifecycle exercised against the live testnet before the first
    Arbitrum One broadcast, so that the first real transaction is a confirmation and not an
    experiment.
30. As a maintainer, I want the acceptance test to skip loudly without a funded testnet key, so
    that its absence is visible rather than silently green.
31. As a maintainer, I want the acceptance test kept out of CI, so that a release gate does not
    depend on a funded key or on testnet availability.
32. As a maintainer, I want the public exports renamed now, so that a chain-specific name is not
    frozen into a published package.
33. As a maintainer, I want the deployment vocabulary in `CONTEXT.md`, so that the CLI surface can
    be machine-checked against it.
34. As a maintainer, I want the decisions behind this recorded as ADRs, so that a future reader does
    not have to re-derive why the flag is named for a chain but selects a deployment.
35. As a human debugging a failure, I want the refusal to tell me which deployment was resolved and
    which chain ID was asserted, so that I can see a mismatch without reading the source.

## Implementation Decisions

### The domain model

`--chain` names a **deployment**: one address set of the Kleros v2 contracts. A chain may host
several — Arbitrum Sepolia hosts at least three, all answering chain ID 421614 — so a chain ID does
not identify a deployment. The flag keeps agentkit's name for consistency across the two CLIs the
agent calls; the model underneath is honest. `Deployment` becomes a `CONTEXT.md` term.

Naming, by surface: the **slug** (`arbitrum-one`, `arbitrum-sepolia-testnet`) is canonical at every
machine boundary — flag values, envelopes, CTAs, error messages. **"v2 Beta"** and **"v2 testnet"**
are the prose names, used in `README.md` and the skill. **"Neo"** stays a technical codename
appearing in code comments, explicitly not user-facing. The contracts package's own keys
(`mainnet`, `testnet`) are an implementation detail confined to the deployment module and mapped
exactly once. The word "mainnet" does not appear in user-facing text at all: to an agent that also
reads agentkit, it names Ethereum.

The gloss is applied **once**, in the `--chain` option description. It is not repeated across other
help strings, messages or CTAs.

### Scope

Two deployments are served: `arbitrum-one` and `arbitrum-sepolia-testnet`.

`arbitrum-sepolia-devnet` is refused, not registered. It is reachable in agentkit, but its write
surface genuinely differs — the evidence group field was removed there and the `submitEvidence`
parameter renamed — so registering a deployment this tool has never signed against would be
convenience without verification. The refusal says so.

The bare slug `arbitrum-sepolia` is refused with guidance naming both replacements, reusing
agentkit's wording so an agent that has seen one message sees the same one here.

### Module shape

A new module owns the slug-to-deployment table: a small, closed, pure data structure with no
dependency on the contracts package. It maps a slug to the package's deployment key, the expected
chain ID, the default RPC endpoint, and the name of that deployment's RPC override variable, derived
by formula rather than written twice.

The existing deployment module stops resolving module-level constants at load and becomes a function
of a deployment: addresses via the package's own chain-keyed lookup, and the ABI namespace for that
deployment. This mirrors `@kleros/agentkit`'s own separation, which the layout already tracks, and
keeps the pre-flight layer able to name a deployment without reaching the registry.

The two ABI namespaces are **not** interchangeable and are bound per deployment. Measured: the
dispute resolver and evidence module ABIs are byte-identical across the two, but the arbitrator's
differ — 123 entries against 115. The Beta-only entries are the arbitrable whitelist and juror NFT
functions and four errors. Confirmed on chain: calling the whitelist selector against the testnet
arbitrator reverts bare, while the same calldata against v2 Beta returns false.

### Startup ordering

The invariant is restated. It was "no deployment registry lookup before the chain assertion"; it
becomes **"no contract call before the chain assertion"**.

The old rule was a proxy for the real one. Resolving addresses is a local act; *using* them on an
unverified chain is the hazard. Previously the deployment was inferred from the chain, so the lookup
had to come second. Now the caller names it, so the order is: slug, deployment, expected chain ID,
`eth_chainId` assertion, first contract call. The registry lookup moves ahead of the assertion and
nothing is weakened, because no address reaches the network until after it.

The remaining startup steps are unchanged: the arbitrable's own view of itself is asserted against
the resolved addresses, and version mismatches warn without failing. No per-deployment version table
is needed — both deployments report the same versions for the two contracts that expose one.

Court validation needs no per-deployment work: court existence is already probed live rather than
tabled, so the testnet's court set is discovered.

### Configuration surface

**The environment configures transport, never target.** `KLEROS_RPC_URL_ARBITRUM_ONE` and
`KLEROS_RPC_URL_ARBITRUM_SEPOLIA_TESTNET` are honoured, matching agentkit's names and formula. No
environment variable and no config file selects the deployment: only the explicit flag does.

This is a deliberate divergence from agentkit, which resolves a chain through a four-level
precedence including an environment variable and a config file. agentkit reads; this tool signs. An
ambient variable that redirects which deployment a transaction is sent to is exactly the invisible
input the "fail loudly" posture exists to prevent, and the repo already refuses ambient
configuration elsewhere — no signing key from the environment, and the RPC default deliberately not
read from one.

Each deployment carries its own default endpoint. Noted for the record: the public Arbitrum Sepolia
endpoint was observed silently omitting logs, returning 124 events where an archive endpoint
returned 125. This does not reach the write plane, which reads logs only from a transaction receipt
and never calls `eth_getLogs`, but it is a reason the override matters more on the testnet.

### Reporting

Every envelope echoes the resolved deployment slug and the asserted chain ID, on success and on
failure, alongside the effective court, juror count and dispute kit already required. The rule is
the one that already governs `extraData`: report what was effective, never what was requested.

Every CTA carries `--chain`. This is a correctness requirement, not tidiness: a continuation command
without it re-resolves to the default and answers from a different deployment. The existing pre-flight
hint that hands agentkit a hardcoded slug is that bug already present, and is fixed here.

Error codes: a new `CHAIN_NOT_SUPPORTED` for a deployment this tool does not serve. It is distinct
from the existing wrong-chain code, which means "the endpoint answered a chain ID we did not
expect" — a runtime condition found mid-flight. This is an input condition, refused before anything
is contacted. Collapsing them would tell a caller who typed a bad slug to check their endpoint.

### The identifier defect

`submit-evidence` resolves the core dispute ID to the arbitrable's local dispute ID and submits the
local one, on both deployments.

Two reads make this safe, and both are free: the arbitrator's dispute record is already fetched in
the same multicall, and its arbitrable field is one of the fields returned; the core-to-local
mapping takes only the core dispute ID, so it joins that same first round trip. No additional
latency.

The mapping alone cannot be used as a membership test. Measured: it returns zero for a core dispute
belonging to another arbitrable, which is the default value and not a mapping — so a foreign dispute
would silently resolve to local ID zero. The arbitrable field must be checked first.

A new refusal, `DISPUTE_NOT_ADDRESSABLE`, covers a dispute that exists but was created by another
arbitrable. This tool cannot know a foreign contract's local index, and submitting the core ID would
file evidence where nothing reads it — the same harm the existing not-found refusal describes, from
a different cause. The message names the owning arbitrable so the caller can see the dispute is real.

This is the second hard refusal in a command whose policy is otherwise to warn and never refuse. The
policy holds: the exception has always been unreachability, and this is that case.

It also widens the read scope. Reads here have been limited to what is needed to refuse a bad write;
this read determines *what bytes are signed*, which is a new category. The widening is deliberate and
recorded, on the grounds that the alternative is a write that cannot be read back.

### Public surface

The chain-specific export names are renamed now — the assertion helper becomes a function of a
deployment, and the single default endpoint constant becomes per-deployment. Nothing is published, so
this costs one commit today and a major version later.

## Testing Decisions

A good test here observes the CLI through an interface it already has, and asserts on what a caller
can see: the envelope, the error code, the bytes sent. It does not reach into a module, mock an
import, or assert on the shape of an intermediate value. The strongest existing seam is the
in-process JSON-RPC node driven through `--rpc-url` — nothing injected, no module mocked, answering
from the real ABIs so a hand-written reply cannot let a test agree with a decoding mistake. The
verification spec already requires that at least one refusal be reached through that double so the
HTTP client builds the real request.

**One seam changes; no new seam is added.**

1. **The in-process JSON-RPC node takes a deployment.** It currently imports the module-level
   deployment constants and defaults to chain 42161. Once the deployment module is a function, this
   double takes the same argument and answers as either deployment.

2. **The fingerprint test gains a second table.** Pure and offline. Addresses and the ABI entries the
   tool binds to, pinned per deployment. This is also where the measured ABI difference is recorded,
   so an upstream regeneration breaks the build rather than a transaction. Accepted cost: a testnet
   redeployment will fail this test. That is the intended behaviour — a redeployment silently changes
   where transactions are sent — but it is the one place this feature adds ongoing maintenance, and
   is called out here so it is not mistaken for a regression.

3. **The vocabulary test is unchanged in mechanism.** It renders the help and machine-readable
   surfaces and checks them against the glossary, so it picks up the gloss and the deployment
   vocabulary without modification.

4. **The acceptance test runs live against the v2 testnet**, through the built binary, in separate
   processes.

**The second deployment is used in exactly three places, not as a matrix.** Mechanics are identical
by design, so running the whole suite twice would execute the same lines against different constants
— a slower suite and a standing tax on every future test, for duplicate coverage. Instead:

- **A differential test.** The same inputs against both deployments, asserting the envelopes are
  structurally identical apart from the deployment fields and the addresses. This converts "identical
  mechanics" from a design promise into a pinned property, and is the test that catches a future
  branch on the deployment — a ceiling skipped on the testnet, a confirmation gate added there.
- **The startup-ordering test at the testnet chain ID**, proving the expected value is read from the
  selected deployment rather than a constant, and that no contract call precedes the assertion.
- **The unsupported-slug refusals**, asserting zero network round trips.

**The identifier-divergence tests are written against the v2 Beta double, deliberately.** The
divergence is reachable on Arbitrum One the day a second arbitrable files there. Placing the fixture
on the testnet double would re-encode the belief this work disproves — that the defect is a testnet
quirk. Fixtures use the measured pair: a dispute record naming a foreign arbitrable, and a mapping
returning 33 for core dispute 58.

**The acceptance test changes what it asserts.** Its pinned values — a fixed arbitration cost, a
pinned block — cannot survive on a live deployment, and each run broadcasts permanently. They are
replaced with relational assertions that hold at any block: the cost reported in the envelope equals
the cost quoted immediately before; the reported core dispute ID resolves on chain; the emitted
evidence log carries the exact bytes submitted; the local dispute ID the tool resolved matches the
mapping read back from the chain; the dispute reports the expected period. The two existing
assertions are kept verbatim — that no secret reached either output stream, and that nothing was
written to disk — and they are the reason it runs in separate processes.

It is a release gate, not a CI job. It requires a funded testnet key and skips loudly when one is
absent, in the manner the repo already uses for suites with an unmet prerequisite.

**The existing fork suite is untouched** — except for one assertion, changed by ticket 02: test 7
compared the emitted `Evidence` id against the core ID it passed in, which on this fork passes
whichever identifier the CLI sends. It now reads the mapping back (`spec/05 §2.7`). Two of its tests seed state that Arbitrum One cannot
provide — an overpayment, and a second arbitrable — and the testnet now supplies the second natively,
with 26 foreign arbitrables and a live divergence. They are kept anyway: they are the only
deterministic proof, and testnet state can change underneath us.

## Out of Scope

- **`arbitrum-sepolia-devnet` and the university deployment.** Refused by name, not served.
- **Kleros v1 chains.** agentkit reads Ethereum and Gnosis; this tool writes v2 only.
- **Deployment selection from the environment or a config file.** Explicitly rejected above.
- **A `--fee-token` flag.** Fees remain ETH-only on both deployments; the unresolved ERC-20 path is
  untouched.
- **Any relaxation of safety mechanics on the testnet.** No path may exist on one deployment only.
- **Subgraph or indexer reads.** Unchanged: the write plane does not depend on an indexer.
- **`upload-file` gaining a deployment.** It signs nothing, reads no chain and loads no key.
- **Submitting evidence to a dispute created by a foreign arbitrable.** Refused, not resolved: this
  tool cannot know another contract's local index. Revisit only with a way to discover it generically.
- **The npm release itself**, and the first Arbitrum One broadcast. Both follow this work.
- **The safe-invocation idea** (`--dry-run` / `--from`) carried in the previous handover. Unrelated;
  still unrecorded and still needs its own issue.

## Further Notes

**Order of work.** Deployment support lands before the acceptance test, and both before the first
Arbitrum One broadcast and the npm release. Two reasons, both load-bearing: the public export surface
is still free to move only until something is published, and the identifier fix cannot be observed on
Arbitrum One at all, where every dispute coincides.

**Documents to update.** `docs/spec/` is normative and several sections make single-deployment
claims: the startup-check ordering, the chain facts, the payload construction section covering the
identifier, and the verification section covering the acceptance test. `CONTEXT.md` gains
**Deployment**, sharpens **Neo**, rescopes the **Arbitrable** entry — the whitelist is a Beta property
and is measurably absent on the testnet, so it can no longer be the justification for routing through
the dispute resolver — and rescopes the court-range figure. `CLAUDE.md`'s chain-only invariant is
replaced. `README.md` changes because the command surface and the envelope change.

**ADRs.** Three new: the deployment model, including why the flag is named for a chain but selects a
deployment and why the startup ordering inverts; the environment-configures-transport rule and why it
diverges from agentkit; and the core-to-local resolution with its measurements. Two amended: the read
scope, which now admits reads that determine what to sign; and the contracts-package import, which
now covers two deployments with genuinely different ABIs. The evidence-policy ADR gains a line for
the second hard refusal rather than a new file.

**Verification markers.** Every chain fact in this spec that is marked as measured was read from
Arbitrum Sepolia at block 307029795 on 2026-09-09, by direct RPC probe rather than from the fork
suite, and cross-checked against contract state where events were involved. The fork suite did not
run during this work. Facts about the ABI shapes were read from the installed contracts package, not
from chain.
