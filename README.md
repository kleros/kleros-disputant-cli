<h1 align="center">⚖️ kleros-disputant-cli</h1>

<p align="center">
  <strong>A headless CLI that creates Kleros v2 disputes and submits evidence on Arbitrum One, and on the Arbitrum Sepolia testnet.</strong><br>
  One-shot commands, no daemon, JSON in and JSON out.<br>
  <sub>package <code>@kleros/kleros-disputant-cli</code> · binary <code>kleros-disputant</code></sub>
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Node >=22" src="https://img.shields.io/badge/node-%3E%3D22-3c873a.svg">
  <img alt="Chains: Arbitrum One and Arbitrum Sepolia" src="https://img.shields.io/badge/chains-Arbitrum%20One%20%7C%20Arbitrum%20Sepolia-28a0f0.svg">
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-orange.svg">
</p>

---

> [!IMPORTANT]
> **This tool files a case; it does not build one.** The claim, the evidence text, the court and the
> ruling options are always inputs. It never reads counterparty content, never fetches a URI it
> finds on chain, and never decides whether a dispute is worth creating. Case construction happens
> upstream — a human, an agent, your business logic.

## Why this exists

Today, creating a Kleros v2 dispute means opening the Court web client and signing in a browser.
That rules out the party who is a server, a cron job, or an autonomous agent.

This CLI makes the same two writes directly against the selected deployment — Arbitrum One by
default:

```
   create-dispute                       submit-evidence
   ──────────────                       ───────────────
   DisputeResolver                      EvidenceModule
     .createDisputeForTemplate            .submitEvidence
     payable — the arbitration fee        gas only
     template inline in calldata          evidence JSON inline
            │                                    │
            ▼                                    ▼
     KlerosCore holds the dispute         indexed against the dispute
     and draws the jurors                 by the subgraph
```

`DisputeResolver` is the entry point on both deployments: it is the generic permissionless
arbitrable, so one write path and one payload builder serve either. On Arbitrum One it is also the
*only* path — the deployed core enforces `arbitrableWhitelist` unconditionally, so an EOA **cannot**
call `KlerosCore.createDispute` at all. That whitelist is a v2 Beta property rather than a Kleros v2
one, which is why it is how the constraint was discovered and not what holds it.

| It does | It does not |
| --- | --- |
| Quote the arbitration fee before you commit to it | Decide the claim, the court, or the ruling options |
| Create a dispute and register its template | Decide what to upload, or keep it pinned afterwards |
| Submit one evidence document, and upload its attachment | Read, parse or fetch a URI *you* hand it |
| Report which period a dispute is in | Discover which disputes you are party to |
| Refuse anything that looks wrong, before spending money | Broadcast anything without `--broadcast` |

Discovery — *which* disputes exist, what state they are in, what the other side filed — belongs to
[`@kleros/agentkit`](https://github.com/kleros/agentkit), not here. The only reads in this repo are
the ones that can change the decision to sign.

## Status

**Pre-release.** All five commands are built and tested. The read paths are verified live against
Arbitrum One; the second deployment's addresses, versions and wiring are verified live on Arbitrum
Sepolia, though no command has yet been exercised there end to end — that is the acceptance test
below. Both write paths broadcast on an Arbitrum One fork under `pnpm test:fork`, and `upload-file`
is measured against the live pinning endpoint.
**No transaction has ever been broadcast to either deployment** — not to Arbitrum One, and not yet
to the testnet that exists to rehearse it. Treat the first live dispute as the shakedown run, on a
cheap court, with a ceiling you can afford to lose.

| Command | Signing key | On-chain write |
| --- | :---: | --- |
| `arbitration-cost` | — | never |
| `status` | — | never |
| `create-dispute` | required | `createDisputeForTemplate`, only with `--broadcast` |
| `submit-evidence` | required | `submitEvidence`, only with `--broadcast` |
| `upload-file` | — | never — no chain at all, only with `--publish` |

Nothing is published to npm yet, deliberately — see [`CHANGELOG.md`](CHANGELOG.md).

## Requirements

- **Node.js ≥ 22** and [pnpm](https://pnpm.io)
- An **RPC endpoint for the deployment you are acting on** — Arbitrum One by default, Arbitrum
  Sepolia with `--chain arbitrum-sepolia-testnet`. The public ones work and are rate-limited; pass
  your own with `--rpc-url` (comma-separated for automatic failover), or export
  `KLEROS_RPC_URL_ARBITRUM_ONE` / `KLEROS_RPC_URL_ARBITRUM_SEPOLIA_TESTNET`. **The variable picks an
  endpoint and never a deployment** ([ADR-0016](docs/adr/0016-the-environment-configures-transport-never-target.md))
- The **private key** of the party creating the dispute, in a file this tool is pointed at
- **ETH on that deployment's chain** in that account. It sends its own transactions and pays its
  own arbitration fee; there is no relayer

## Install

```bash
git clone git@github.com:kleros/kleros-disputant-cli.git
cd kleros-disputant-cli
pnpm install
pnpm build
pnpm link --global      # puts `kleros-disputant` on your PATH
```

Or skip the link and run it in place: `pnpm dev arbitration-cost --court 1 --jurors 3`.

## Set up the key

```bash
mkdir -p ~/.kleros-disputant
printf '0x%s' "<64 hex chars>" > ~/.kleros-disputant/key
chmod 600 ~/.kleros-disputant/key
```

Then pass `--key-file ~/.kleros-disputant/key`.

The key is read **only** from a file. There is deliberately no `--private-key` flag and no
`PRIVATE_KEY` environment variable: this process is meant to be launched by an agent gateway that
also runs model-authored shell commands, and anything in the environment is inherited by every
child process. A file is not a security boundary against a compromised host — but it is not
*ambient*, which is the difference that matters here. The tool refuses to run if the file is
readable by group or others, and the key never appears in any output.

> [!NOTE]
> **The party creating the dispute must not be a juror in the same dispute.** That is not cheaply
> detectable on chain and this tool does not check it. It is your responsibility, and nothing here
> should be read as a guarantee about it.

## Quick start

### 1. What would it cost?

```bash
kleros-disputant arbitration-cost --court 1 --jurors 3
```

```json
{
  "ok": true,
  "command": "arbitration-cost",
  "deployment": "arbitrum-one",
  "chainId": 42161,
  "requested": { "court": "1", "jurors": "3", "disputeKit": "1" },
  "extraData": "0x00…0001",
  "arbitrationCost": { "wei": "15000000000000000", "eth": "0.015" },
  "warnings": [],
  "message": "Creating a dispute in court 1 with 3 jurors costs 0.015 ETH. Nothing was sent…"
}
```

Reads only, needs no key. It runs the *same* court, juror-count and kit checks as `create-dispute`,
because KlerosCore will happily quote a price for a court that does not exist.

### 2. Write the dispute template

The template is what jurors are actually asked. It is a JSON file you author, and it travels
**inline in the calldata** — there is no CID and no upload step.

```json
{
  "title": "Late delivery under order #4417",
  "description": "The seller did not deliver within the agreed window.",
  "question": "Should the escrowed funds be released to the buyer?",
  "answers": [
    { "id": "0x1", "title": "Yes, refund the buyer",  "description": "The goods never arrived." },
    { "id": "0x2", "title": "No, pay the seller",     "description": "Delivery was made on time." }
  ],
  "policyURI": "/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
  "arbitratorChainID": "42161",
  "arbitratorAddress": "0x991d2df165670b9cac3B022f4B68D65b664222ea",
  "version": "1.0"
}
```

Four things to know:

- **`arbitratorChainID` and `arbitratorAddress` name the deployment you are filing on**, and the two
  values above are Arbitrum One's. Nothing checks them against `--chain` yet, so a template copied
  onto the testnet registers the wrong arbitrator — resolve them from
  [ADR-0006](docs/adr/0006-deployment-imported-from-contracts-package.md)'s source of addresses, not
  by hand.
- **Answer `0x0` is reserved** for *Refuse to Arbitrate* and is never in the array. The number of
  ruling options is derived from `answers`, so there is no separate flag that could disagree with it.
- **The schema is strict.** An unknown field is rejected by name, not silently ignored — a typo'd
  key would otherwise reach jurors as a missing one. Why it is strict rather than lenient:
  [ADR-0010](docs/adr/0010-a-strict-authoring-schema-not-the-sdk-parser.md).
- **`policyURI` is recorded, never fetched.** So is any `--file-uri` you attach to evidence.

### 3. Dry run — this is the default

```bash
kleros-disputant create-dispute \
  --court 1 --jurors 3 \
  --template-file ./dispute.json \
  --max-cost-eth 0.02 \
  --key-file ~/.kleros-disputant/key
```

Plans, quotes, pre-flights and simulates — then stops. `"status": "simulated"`, and the `message`
says in words that nothing was sent.

### 4. Actually create it

```bash
kleros-disputant create-dispute … --broadcast
```

`--broadcast` **is** the confirmation. There is no prompt, because there is no human assumed to be
watching.

### 5. Upload the attachment, if there is one

```bash
kleros-disputant upload-file --file ./delivery-photos.pdf            # checks, uploads nothing
kleros-disputant upload-file --file ./delivery-photos.pdf --publish  # uploads, prints the URI
```

Skip this if you already have a pinned URI — `--file-uri` still accepts one you produced yourself.

This is the only command that speaks HTTP, and the only one with no chain in it: it never signs,
never reads the chain and never loads a key. `--publish` is to it what `--broadcast` is to the
other two, for the same reason — content addressed by a CID cannot be withdrawn. It prints the
`--file-uri` and `--file-type-extension` for the next step, and says in words that nothing has been
submitted yet.

Uploads go to the unauthenticated Kleros pinning endpoint, so there is still exactly one credential
in this tool: the signing key. Point `--upload-url` at your own deployment of the same function if
you would rather not use it. What was measured against it, and what could not be, is in
[`docs/spec/06-attachment-upload.md`](docs/spec/06-attachment-upload.md) and
[ADR-0012](docs/adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md).

### 6. Submit evidence

```bash
kleros-disputant status --dispute 215        # is the evidence period still open?

kleros-disputant submit-evidence \
  --dispute 215 \
  --name "Delivery photographs" \
  --description @statement.md \
  --file-uri /ipfs/QmWQV5… --file-type-extension pdf \
  --key-file ~/.kleros-disputant/key --broadcast
```

`--name` and `--description` each take a literal string, `@path` to read a file, or `-` for stdin.
Prefer `@path` for anything long: it keeps the text out of the process table.

Full option reference is in the tool itself — `kleros-disputant <command> --help`, or
`kleros-disputant --llms-full` for the machine-readable manifest. It is not repeated here, so it
cannot go stale here.

## Output, and what to branch on

Output is **JSON on stdout by default**, because the primary consumer is a program. There is no
`--json` flag and no `--verbose` flag; `--format` selects another shape if you want one, and
`--full-output` reveals incur's outer `{ok, data, meta}` envelope.

Errors carry a stable machine-readable `code`, a message that says whether anything was sent, and
often a `cta` naming the next command to run:

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "The account holds 0 ETH and the arbitration fee alone is 0.015 ETH, before any gas. Nothing was sent. Deployment: arbitrum-one (chain 42161).",
  "cta": {
    "description": "The arbitration fee is paid on creation and cannot be recovered.",
    "commands": [
      {
        "command": "kleros-disputant arbitration-cost --chain arbitrum-one --court 1 --jurors 3 --kit 1",
        "description": "Quote the fee without committing to it"
      }
    ]
  }
}
```

**Branch on `code`, not on the exit status.** Exit codes are coarse buckets for shell callers —
`0` success (including `simulated` and `unknown`) · `1` validation or refusal, nothing sent ·
`2` chain or RPC failure · `3` the transaction or its outcome went wrong · `4` signer or key
failure — but the payload is the real contract.

> [!WARNING]
> If a broadcast returns `"status": "unknown"`, the CLI stopped watching; **the transaction may
> still land**. Run `status` before doing anything else. Never re-send blindly — a duplicate
> `create-dispute` pays the arbitration fee a second time and creates a second dispute.

## The rules it will not let you break

These are enforced in code, not left to the caller:

- **A wrong court is refused locally, because the chain will not refuse it.** A bad court ID, a zero
  juror count or a malformed `extraData` does *not* revert: KlerosCore's decoder substitutes the
  General Court, its own juror count and the Classic kit, and creates a paid dispute in the wrong
  place. `simulateContract` cannot catch that. So the court is validated, kit support is re-read
  every time, and the *effective* court, juror count and kit are echoed back — a difference from
  what you asked for is an error, not a warning.
- **The fee is quoted with the byte-identical `extraData`, immediately before sending, and exactly
  that amount is sent.** The chain protects you against underpaying, not against overpaying.
  `--max-cost-eth` is enforced locally the moment the quote arrives, before anything is simulated.
- **Simulate first, always.** Every state-changing call is simulated, and nothing is broadcast
  without `--broadcast` ([ADR-0004](docs/adr/0004-broadcast-is-opt-in-no-human-gate.md)).
- **Two deployments served** — `arbitrum-one` (v2 Beta, chain 42161), which is the default, and
  `arbitrum-sepolia-testnet` (v2 testnet, chain 421614) — selected by `--chain`. A chain ID does not
  identify a deployment; three answer 421614. A slug this tool does not serve is refused before
  anything is contacted. The chain ID is
  asserted with a live `eth_chainId` call against that deployment's own expected value, and **no
  contract call is made before it** — resolving an address is local, using one on an unverified
  chain is the hazard ([ADR-0015](docs/adr/0015-a-deployment-is-not-a-chain.md)). The two refusals
  are distinct on purpose: `CHAIN_NOT_SUPPORTED` is a slug this tool does not serve, refused before
  anything is contacted, and `WRONG_CHAIN` is an endpoint answering a chain ID the selected
  deployment does not expect. Collapsing them would tell someone who mistyped a slug to go and check
  their endpoint.
- **Fees are paid in ETH.** The ERC-20 path is unresolved, so there is no `--fee-token` flag: the
  broken path cannot be asked for
  ([ADR-0008](docs/adr/0008-arbitration-fees-are-paid-in-eth-only.md)).
- **Late evidence warns; it never refuses.** `submitEvidence` has no period gate on chain, and the
  submission is indexed either way, so refusing would be this CLI inventing a rule the protocol does
  not have. The two hard refusals are both unreachability: a dispute ID that does not exist, and a
  dispute another arbitrable created
  ([ADR-0011](docs/adr/0011-evidence-period-pressure-warns-and-never-refuses.md),
  [ADR-0014](docs/adr/0014-evidence-is-filed-under-the-local-dispute-id.md)).
- **Evidence never enters this process as data.** It is bytes on the way to a transaction: never
  parsed, never interpolated into anything executable, never able to influence which call is made.
  Everything written in a dispute is authored by someone with an interest in the outcome
  ([ADR-0007](docs/adr/0007-evidence-is-opaque-operator-supplied-bytes.md)).

> [!CAUTION]
> **Creating a dispute spends money and cannot be undone.** The arbitration fee is paid on creation
> and is not refundable to the creator. There is no cancel, no withdraw, and no second chance at
> choosing the court.

## Using it from an agent

Every command is self-describing: `--help` for humans, `--llms` / `--llms-full` for a manifest,
`--schema` for JSON Schema. `incur` also gives the binary a `mcp` group (register it as an MCP
server) and a `skills` group.

```bash
kleros-disputant skills add      # installs six skills: one per command, plus the hand-written one
```

`incur` generates a skill per command from the definitions themselves, so the flag tables can never
drift. [`skills/kleros-disputant/SKILL.md`](skills/kleros-disputant/SKILL.md) is the one written by
hand and carries what a generator cannot: the order to call things in, what each irreversible step
costs, and a troubleshooting table keyed on error `code`. It restates no flags, for the same reason
this file does not.

The framework-free core is importable too, if you would rather build the calls yourself:

```ts
import { encodeExtraData, buildTemplate, checkPreflight } from "@kleros/kleros-disputant-cli";
```

Everything under `src/core/` is free of CLI concerns, never throws, and returns a `KlerosResult<T>`;
`src/commands/` is the thin layer that owns argument parsing, exit codes and output. That split is
deliberate — it is what should let the core move into `@kleros/agentkit` as close to a file move as
possible ([ADR-0001](docs/adr/0001-standalone-repo-shaped-for-upstreaming.md)).

## Development

```bash
pnpm test             # unit + guard tests; a suite whose prerequisite is absent self-skips loudly
pnpm test:fork        # spawn an Arbitrum One fork on :8546 and run only the fork tests (needs anvil)
pnpm test:acceptance  # full lifecycle against the live v2 testnet; needs a funded testnet key.
                      # Not written yet
pnpm typecheck
pnpm lint             # biome check .   (`pnpm exec biome check --write .` to fix)
pnpm build
pnpm dev status --dispute 215
```

Addresses and ABIs are **imported** from `@kleros/kleros-v2-contracts` in
[`src/core/deployment.ts`](src/core/deployment.ts) and never hand-copied; it is bundled at build
time, so it stays a devDependency and adds nothing to your install. The package ships the *deployed*
artifacts, which differ from what `master` compiles to — a fingerprint test asserts exactly that on
every run and fails the build if upstream drifts, rather than letting a transaction find out
([ADR-0006](docs/adr/0006-deployment-imported-from-contracts-package.md)).

The runtime dependencies are exactly two: `incur` and `viem`. `upload-file` speaks HTTP through
Node's own `fetch`, `FormData` and `Blob`, so it adds no third.

## Where things live

| Where | What |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | **The glossary — read this first.** Filing vs case construction, the three dispute IDs, ruling option vs choice, and the near-synonyms to avoid |
| [`docs/spec/`](docs/spec/) | The normative specification. Start at its [`README.md`](docs/spec/README.md) for the map, the reading order and the verification markers |
| [`docs/adr/`](docs/adr/) | One file per decision a reader would otherwise question. Numbers 0003 and 0005 are deliberately unused — juror-only decisions this repo never made, left as gaps so `ADR-0004` means the same thing in both repos |
| [`CLAUDE.md`](CLAUDE.md) | The invariants, as a guard-rail index for agents contributing to this repo |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed, and why nothing is on npm yet |

This repo inherited no specification: one was written here from the deployed contracts, and every
chain fact in it carries a marker saying how it was established — `[live]`, `[fork]`, `[abi]`,
`[computed]`, `[client]`, `[inferred]`, `[maintainer]`, and `[service]` for the one thing here that
is not a contract. **`[client]` and `[inferred]` claims must not be depended on without a fork
test**, and `[fork]` is what a claim becomes once one has settled
it. `[live]` claims are stamped with a date and a block; re-run
[`docs/spec/05-verification.md`](docs/spec/05-verification.md) §4 to refresh them.

Sibling repos, for orientation: [`kleros-juror-cli`](https://github.com/kleros/kleros-juror-cli) is
the other half of the write plane and the source of this architecture;
[`@kleros/agentkit`](https://github.com/kleros/agentkit) is the read plane and a peer CLI the same
agent calls.

## Roadmap

- [ ] The acceptance test — the full lifecycle against the live v2 testnet, in separate processes
      (`docs/spec/05-verification.md` §3)
- [ ] First broadcast against Arbitrum One, then the first npm release
- [ ] Upstreaming `src/core/` into `@kleros/agentkit` once its write milestone lands

## Contributing

Issues and pull requests are welcome. Three things to know before you start:

1. **Read [`CONTEXT.md`](CONTEXT.md) and use its vocabulary.** This domain is full of near-synonyms
   that quietly mean different things — core dispute ID vs local dispute ID, dispute template vs the
   v1 term for it, ruling option vs choice. The CLI's own surface is machine-checked against that
   glossary, so a wrong word fails the test suite.
2. **`docs/spec/` is normative.** Read it before writing domain logic and cite it by section
   (`spec/01 §4.4`). If you establish a new chain fact, it goes there with a marker.
3. **A change to the command surface, the option defaults or the JSON envelope is a change to this
   file too.** If an ADR covers the behaviour you are changing, update the ADR in the same PR.

## Security

Please do not open a public issue for a vulnerability in key handling, payload construction, or the
broadcast path. Use GitHub's private vulnerability reporting on this repository, or contact the
maintainers directly.

This is pre-release software that holds a key and spends real ETH on an irreversible action. Read
the code before you point it at a real dispute.

## License

MIT — see [LICENSE](LICENSE).
