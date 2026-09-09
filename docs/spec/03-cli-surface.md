# 03. CLI surface

## 1. Shape

Binary: `kleros-disputant`. Built on `incur`, `format: "json"`.

- **One-shot.** Every command builds, decides, prints and exits. No daemon, no watcher.
- **Options only, never positional arguments.** An agent passes flags; positional arguments invite
  ordering mistakes that this tool pays for irreversibly.
- **JSON on stdout by default.** The consuming agent merges stdout and stderr into one buffer, so
  anything else on stdout breaks parsing. There is **no `--json` flag and no `--verbose` flag**;
  JSON comes from `format: "json"`, and `--format` is one of the flags incur supplies.
- **Nothing is broadcast without `--broadcast`.** There is no human confirmation gate and nothing
  upstream provides one. [ADR-0004](../adr/0004-broadcast-is-opt-in-no-human-gate.md)

incur supplies `--filter-output`, `--format`, `--full-output`, `--llms`, `--llms-full`, `--mcp`,
`--schema`, `--token-count` / `--token-limit` / `--token-offset`, and the `completions`, `mcp` and
`skills` command groups. The CLI **MUST NOT** reimplement any of them.

## 2. Commands

| Command | Writes | Contract | Call |
| --- | --- | --- | --- |
| `arbitration-cost` | no | `KlerosCore` | `arbitrationCost(extraData)` |
| `status` | no | `KlerosCore` | `disputes`, `getTimesPerPeriod`, `currentRuling` |
| `create-dispute` | **yes, payable** | `DisputeResolver` | `createDisputeForTemplate` |
| `submit-evidence` | **yes** | `EvidenceModule` | `submitEvidence` |
| `upload-file` | no chain | *(none)* | HTTP `POST` to the pinning endpoint — [06](./06-attachment-upload.md) |

Both write commands **MUST** be registered with `destructive: true`, so incur appends its
confirm-with-the-user line to `--llms-full`. So **MUST** `upload-file`: it signs nothing, but
publishing content addressed by a CID cannot be undone
([ADR-0012](../adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md)).

`upload-file` is the **only** command that opens a socket to anything but the RPC, and it is
deliberately not reachable from either write command — `submit-evidence` **MUST NOT** grow a
`--file` flag. [06 §1](./06-attachment-upload.md) has the reasoning; the short form is that a dry
run would have to either publish or lie.

`register-template` (`DisputeTemplateRegistry.setDisputeTemplate`) is a separate write surface and
is **out of scope for v1**: `createDisputeForTemplate` covers the common case by registering the
template as a side effect. Appeal funding is out of scope for the same reason it is out of scope in
[00](./00-overview.md) — the disputant is not the juror.

`create-dispute --template-uri` (`createDisputeForTemplateUri`) is **specified but not shipped in
v1**. **[live]** Zero of the 216 disputes ever created used that path, so nothing about its
behaviour has been observed. See [Appendix A §2](./appendix-a-unresolved.md).

## 3. Options

### 3.1 Shared

Every option is `z.string()`, **including numeric ones**. Numeric parsing happens in the functional
core via `parseBigInt`, so a bad number fails with a stable `code` rather than incur's own
validation error. Only booleans are `z.boolean().default(false)`. Kebab-case keys are read by
index: `c.options["rpc-url"]`.

`z` **MUST** be imported from `incur`, never from `zod` — one zod instance.

| Option | Type | Applies to | Notes |
| --- | --- | --- | --- |
| `--rpc-url` | string | all | Arbitrum One. The chain assertion runs against whatever it points at |
| `--key-file` | string | writes | Path to the signing key. **The key is never accepted from the environment or the command line** |
| `--broadcast` | boolean | writes | Default `false`. Without it the command stops after simulation |
| `--max-fee-gwei` | string | writes | Gas fee ceiling, in gwei. It caps `maxFeePerGas` and **not** the arbitration fee, which is not gas |

**The option set above is closed**, and the receipt timeout is the one thing that pays for it.
There is no `--timeout`: how long to wait before reporting `status: "unknown"` is fixed in
`src/commands/shared.ts`, because nothing is *decided* by the number — a timeout produces a
success that says the tool stopped watching ([04 §3](./04-transaction-relaying.md)), so exposing it
would add a surface without adding a choice.

### 3.2 `create-dispute`

| Option | Required | Notes |
| --- | --- | --- |
| `--court` | yes | Court ID, `1..34`. `0` is refused |
| `--jurors` | yes | Juror count, `>= 1` |
| `--kit` | no | Dispute kit ID. Defaults to `1` (Classic), the kit every court supports. Some courts support others as well, so this is a scope choice and **MUST NOT** be written as a claim that no other kit is supported anywhere |
| `--template-file` | yes | Path to the dispute template JSON. Validated strictly ([02 §3.2](./02-payload-construction.md)) |
| `--max-cost-eth` | yes | The local cost ceiling. **Enforced before quoting, and before simulating** |

`_numberOfRulingOptions` is **not** an option. It is derived from the template's `answers` array,
so the two cannot disagree ([02 §1.1](./02-payload-construction.md)).

There is **no `--fee-token`**: the ERC-20 path is unresolved and the broken path cannot be asked
for. [ADR-0008](../adr/0008-arbitration-fees-are-paid-in-eth-only.md)

### 3.3 `submit-evidence`

| Option | Required | Notes |
| --- | --- | --- |
| `--dispute` | yes | **The core dispute ID** ([01 §7](./01-onchain-reference.md)) |
| `--name` | yes | The evidence document's `name`. **Not `title`** |
| `--description` | yes | The body |
| `--file-uri` | no | An operator input. Never fetched, never validated beyond being a string |
| `--file-type-extension` | no | Subgraph-only field |

`--name` and `--description` **MAY** also be supplied from a file, to keep long text off the
command line and out of the process table. A CLI that adds that **MUST NOT** also add a flag that
reads them from the environment.

Both take `@path` to read a file and `-` to read stdin. Passing `-` for **both** is refused: stdin
can only be drained once, and the second read would come back empty and be rejected as a blank
field — a true refusal with a misleading reason.

### 3.4 `upload-file`

| Option | Required | Notes |
| --- | --- | --- |
| `--file` | yes | Path to the local file. The **only** path this tool ever reads that is not a key or a template |
| `--publish` | no | Default `false`. Without it the command checks the file and stops. **Not** `--broadcast`: nothing is broadcast to a chain |
| `--upload-url` | no | Override the endpoint. No environment variable, per [§3.1](#31-shared) |
| `--verify` | no | Default `true`. `--no-verify` skips the round-trip check — [06 §4.2](./06-attachment-upload.md). Named `verify`, because incur reads a leading `--no-` as its own negation prefix and an option *named* `no-verify` is unreachable |

It takes **none** of `--rpc-url`, `--key-file`, `--broadcast` or `--max-fee-gwei`. There is no
chain interaction to configure and no key to load.

## 4. Exit codes

Exit codes exist for shell callers. **They are not the machine contract** — the consuming agent
sees an effectively binary status, so failure semantics live in the JSON payload's `code` field.

| Code | Meaning |
| --- | --- |
| 0 | Success, including `status: "simulated"` and `status: "unknown"` |
| 1 | Validation or refusal — every pre-flight rejection |
| 2 | Chain, RPC or upload-service failure |
| 3 | Transaction reverted |
| 4 | Signer or key failure |

The map **MUST** be a `Record<ErrorCode, number>` over the error-code union, **not** a
`Record<string, number>` with a `?? 1` default. The juror CLI has two codes that fall through its
default; nothing is broken by it today, and that is exactly why it went unnoticed. An exhaustive
map makes the next added code a type error.

Five buckets over two dozen codes leaves three placements worth stating, because each one is a
claim about what the caller still holds:

| Code | Exit | Why not the obvious bucket |
| --- | --- | --- |
| `BROADCAST_FAILED` | 2 | The node refused the signed transaction, so nothing was submitted and nothing reverted. There is no hash to check. Not 3 |
| `TRANSACTION_REVERTED` | 3 | Mined and reverted: a hash exists and gas was spent. Distinct from `SIMULATION_REVERTED`, where nothing was sent |
| `EFFECTIVE_MISMATCH` | 3 | Not a revert, but the only bucket that does not imply nothing was sent. Reading it as validation would tell a caller the money is still theirs |

## 5. Output

Because `format: "json"` and stdout is not a TTY, incur prints the **unwrapped payload**. The
payload therefore carries `ok` and `command` itself, deliberately duplicating incur's envelope,
because the agent still needs to know which command spoke. `--full-output` reveals the outer
`{ok, data, meta}` / `{ok, error, meta}` envelope.

### 5.1 Rules for every payload

1. **Every bigint is `.toString()`'d at the envelope boundary**, or `JSON.stringify` throws.
2. **Every success payload carries `warnings: string[]`**, even when empty. Version mismatches,
   evidence-period pressure and cost-magnitude advisories land there.
3. **A prose `message` restates the machine state.** `"broadcast": false` alone is not enough for an
   LLM consumer.
4. Output is kept small. The template body and the evidence text **MUST NOT** be echoed back in
   full.

### 5.2 `create-dispute`, simulate only

```json
{
  "ok": true,
  "command": "create-dispute",
  "status": "simulated",
  "broadcast": false,
  "requested": { "court": "1", "jurors": "3", "disputeKit": "1" },
  "arbitrationCost": { "wei": "15000000000000000", "eth": "0.015" },
  "extraData": "0x0000…0001",
  "numberOfRulingOptions": "2",
  "estimatedGas": "698736",
  "warnings": [],
  "message": "SIMULATION ONLY — no transaction was sent, no dispute was created and no fee was paid. Re-run with --broadcast to create the dispute and spend 0.015 ETH."
}
```

### 5.3 `create-dispute`, mined

`effective` is read back from chain state and **MUST** be reported alongside `requested`. A
difference between them is an **error**, not a warning ([02 §1.2](./02-payload-construction.md)).

```json
{
  "ok": true,
  "command": "create-dispute",
  "status": "mined",
  "broadcast": true,
  "coreDisputeID": "216",
  "requested": { "court": "1", "jurors": "3", "disputeKit": "1" },
  "effective": { "court": "1", "jurors": "3", "disputeKit": "1" },
  "valueSent": { "wei": "15000000000000000", "eth": "0.015" },
  "txHash": "0x…",
  "blockNumber": "503066782",
  "gasUsed": "…",
  "warnings": [],
  "message": "Dispute 216 created in court 1 with 3 jurors. 0.015 ETH was paid and cannot be recovered."
}
```

`coreDisputeID` **MUST** come from the `DisputeCreation` log, never from the function's return
value ([01 §7](./01-onchain-reference.md)).

### 5.4 Errors

```json
{
  "ok": false,
  "command": "create-dispute",
  "code": "COURT_OUT_OF_RANGE",
  "message": "Court 99 does not exist: KlerosCore has courts 1 through 34. Nothing was sent.",
  "details": { "hint": "kleros court list --chain arbitrum-one" }
}
```

`court list` is a top-level group in `@kleros/agentkit`, not a subcommand of `dispute` — verified
against its own command tree on 2026-09-08. Citing a command a peer CLI does not have is the
juror repo's known defect; do not reintroduce it here.

**Only `details.hint` reaches the user.** Everything else in `details` is for tests; dumping the
whole object makes messages unreadable for the consuming agent.

**incur prefixes the binary name onto every CTA command**, so a CTA can only ever be a subcommand
of this CLI. A shell remedy or a call to a *different* tool goes in `details.hint`, never in a CTA.

A CTA **MUST NOT** re-offer the invocation that just failed. The consumer is an agent with no human
above it, so a suggestion reading `arbitration-cost --court 99 …` after court 99 was refused is an
instruction to run the failing command again, and nothing in that loop breaks it. The refused word
becomes a placeholder; the words that were fine are quoted back.

### 5.5 Error codes

Not exhaustive — the list grows with the implementation — but these are fixed by this
specification and **MUST NOT** be renamed.

| Code | Raised when |
| --- | --- |
| `WRONG_CHAIN` | `eth_chainId != 42161` |
| `COURT_OUT_OF_RANGE` | `--court` is `0`, or `getTimesPerPeriod(courtID)` reverts |
| `COURT_DISABLED` | `courts(courtID).disabled` |
| `JURORS_INVALID` | `--jurors < 1` |
| `DISPUTE_KIT_OUT_OF_RANGE` | `--kit` is `0` or `>= disputeKits.length` |
| `DISPUTE_KIT_NOT_SUPPORTED` | `isSupported(courtID, kitID)` is false |
| `TEMPLATE_INVALID` | The strict authoring schema rejected the template |
| `RULING_OPTIONS_INVALID` | Fewer than two answers, or a reserved `0x0` answer was submitted |
| `POLICY_URI_INVALID` | `policyURI` is not a multiaddr |
| `COST_CEILING_EXCEEDED` | The quote exceeds `--max-cost-eth` |
| `INSUFFICIENT_BALANCE` | `balance < estimatedFee + value` |
| `DISPUTE_NOT_FOUND` | `KlerosCore.disputes()` does not resolve `--dispute` |
| `EVIDENCE_INVALID` | The evidence document failed the strict schema |
| `EFFECTIVE_MISMATCH` | The created dispute's court, jurors or kit differ from those requested |
| `SIMULATION_REVERTED` | `simulateContract` reverted. Carries the decoded reason or the raw selector |
| `TRANSACTION_REVERTED` | The transaction was mined and reverted. The `message` **MUST** name the hash, and for `create-dispute` **MUST** say the fee was returned with the revert while the gas was not |
| `FILE_UNREADABLE` | `--file` is missing, is not a regular file, or cannot be read |
| `FILE_EMPTY` | `--file` is zero bytes. The service answers `200` and pins nothing |
| `FILE_TOO_LARGE` | The encoded upload request would exceed the platform budget ([06 §3.1](./06-attachment-upload.md)) |
| `UPLOAD_FAILED` | The endpoint returned non-`2xx`, could not be reached, or returned `2xx` with no CID |
| `UPLOAD_MISMATCH` | The gateway returned different bytes for the returned CID than were uploaded |

## 6. Signer

- **Exactly one credential: the signing key.** No pinning service token, no subgraph key, no API
  key of any kind. This survives `upload-file` intact: that endpoint is unauthenticated, which is
  the single largest reason it was the one chosen.
  [ADR-0009](../adr/0009-the-cli-references-ipfs-and-never-pins.md),
  [ADR-0012](../adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md)
- The key **MUST** be read from a file whose path is given by `--key-file`. It **MUST NOT** be
  accepted from an environment variable or a command-line argument.
- The key **MUST NOT** appear in any output, any error, any log line, or any `details` object —
  including on the failure paths.
- The CLI **SHOULD** refuse a key file with permissions looser than `0600`, and the remedy
  **MUST** go in `details.hint` rather than a CTA.
- `prepareLocal` (no signer) and `prepare` (signer required) **MUST** be separate, gated by
  `requireSigner: boolean`, so read commands work without a key.

## 7. Startup checks

Ordering is a safety property, not style. Every command that touches the chain **MUST** run these
in order. `upload-file` runs **none** of them, because it makes no chain call for them to protect
([06 §1](./06-attachment-upload.md)):

1. **`eth_chainId == 42161`.** Strictly before any deployment registry lookup — a registry lookup
   is scoped to a deployment, and trusting it on an unverified chain reads the wrong core.
2. Resolve addresses from the contracts package for chain 42161.
3. Assert `DisputeResolver.arbitrator()` and `.templateRegistry()` match the resolved addresses.
4. Read `version()` where available and **warn** on a mismatch. Never fail.
5. Only then, command-specific pre-flight.

## 8. Architecture

Layout mirrors `@kleros/agentkit`, so an eventual port is close to a file move.
[ADR-0001](../adr/0001-standalone-repo-shaped-for-upstreaming.md)

- `src/core/` is framework-free and returns `KlerosResult<T>`. **Core never throws.**
- `src/commands/` owns incur, exit codes and CTA blocks. `run(c)` contains **no logic**: it maps
  options to a core call and hands the `KlerosResult` to a single `finish()` adapter. That adapter
  is the entire core→incur seam.
- try/catch lives only at boundaries, and converts to `err(...)` immediately.
- Reading is split from judging: `read-preflight.ts` does network I/O and produces a facts struct
  with no judgement applied; `preflight.ts` is a **pure function** over that struct. This is what
  makes the safety logic testable without a network, and it is the single most important structural
  requirement in this document.
- Shared option fragments (`chainOptions`, `writeOptions`) are plain objects spread with `...`.
