---
name: kleros-disputant
description: Create Kleros v2 disputes and submit evidence on Arbitrum One through the kleros-disputant CLI. Consult this skill when the case has already been built — the court, the ruling options and the evidence text are decided elsewhere — and what remains is to quote the arbitration cost, create the dispute, pin an attachment, or submit one evidence document against an existing dispute. Read it before running any kleros-disputant command, because it carries the money rules, the period rules and the error-code table that per-command help does not.
version: 1.0.0
allowed-tools: "Bash(kleros-disputant:*)"
metadata:
  openclaw:
    requires:
      bins:
        - kleros-disputant
    emoji: "⚖️"
---

# kleros-disputant

Files a case that has already been built. The court, the ruling options, the evidence text and the
attachment are always inputs: this tool never decides whether a dispute is worth creating, never
reads or interprets what the other side filed, and never fetches a URI — not one it finds on chain,
and not one you hand it. The one HTTP read it ever performs is `upload-file` reading back the CID it
has just created, to check that the endpoint did not silently truncate the file. That read is why
`UPLOAD_MISMATCH` exists.

Output is JSON on stdout. **Branch on `code`, not on the exit status.** There is no `--json` flag and
no `--verbose` flag: `--format` selects another shape, and `--full-output` reveals the outer
envelope — `{ok, data, meta}` on success, `{ok, error, meta}` on failure, so there is no `data` key
on the branch you most need to read. A CTA moves to `meta.cta` there.

Flags are deliberately not restated here, because a copy of them goes stale. Run
`kleros-disputant <command> --help`, `kleros-disputant --llms-full` for the whole manifest, or
`kleros-disputant <command> --schema` for JSON Schema. If `kleros-disputant` is not on PATH it is not
installed, and this skill cannot install it — the repository's README covers that.

## What it will not do

- **No discovery.** It cannot tell you which disputes exist, or which ones concern you. That is
  `@kleros/agentkit`: `kleros dispute get`, `kleros dispute brief`, `kleros dispute policy`,
  `kleros evidence list`, `kleros court get`, `kleros arbitrable classify`. Every read here exists
  only to refuse a bad write — or, in one case, to decide what is signed, where the alternative is a
  write that cannot be read back.
- **No case construction.** It drafts no claim, invents no ruling option and predicts no ruling.
- **Chain 42161 only.** Arbitrum One, asserted with a live `eth_chainId` call before any address is
  looked up. Every address it holds is meaningless elsewhere, not merely wrong.
- **The arbitration cost is paid in ETH.** There is no `--fee-token`.
- **No key from the environment or the command line.** Only `--key-file`, mode 0600. The key never
  appears in any output.
- **It never retries.** Nothing is re-sent on your behalf, in any failure mode.
- **The party creating the dispute must not be a juror in the same dispute.** This tool cannot detect
  that and does not try. It is your responsibility, and nothing here is a guarantee about it.

## Before you can act

| You need | Where it comes from | Used by |
| --- | --- | --- |
| A court ID (from 1) and a juror count | Decided upstream. `kleros court list --chain arbitrum-one` in AgentKit enumerates the courts | `arbitration-cost`, `create-dispute` |
| A dispute template JSON file | You author it. The schema is strict: an unknown field is refused by name, not ignored. Answer `0x0` is reserved and never appears in `answers`, and the ruling-option count is derived from that array rather than passed as a flag | `create-dispute` |
| A cost ceiling in ETH | Your own risk limit, enforced locally the moment the quote arrives — before anything is simulated | `create-dispute` |
| A signing key file, mode 0600 | Managed outside this tool. Needed **even for a dry run**, because the sender is part of the simulation | `create-dispute`, `submit-evidence` |
| The core dispute ID | The number Kleros Court shows for the case | `status`, `submit-evidence` |
| Evidence `name` and `description` | Authored upstream. Each takes a literal string, `@path`, or `-` for stdin — but only one of the two may read stdin. The field is `name`, never `title` | `submit-evidence` |
| An attachment `fileURI`, if the evidence has one | `upload-file --publish`, or a CID you pinned yourself | `submit-evidence` |

Prefer `@path` for anything long: it keeps the text out of the process table.

## Which command is legal when

| Command | Key | Spends | Legal when |
| --- | --- | --- | --- |
| `arbitration-cost` | no | nothing | Any time. Runs the same court, juror-count and dispute-kit checks as `create-dispute`, because the arbitrator quotes a price for a court that does not exist rather than refusing |
| `status` | no | nothing | Any time, for a dispute that exists |
| `create-dispute` | **yes** | the arbitration cost, unrecoverable, plus gas | Any time. Creating a dispute is untimed |
| `upload-file` | no | nothing | Any time, before `submit-evidence`. The only command that speaks HTTP, and the only one with no chain in it |
| `submit-evidence` | **yes** | gas only | Any period. Past the evidence period it warns and still submits |

## Usage

> [!WARNING]
> **Never write `--broadcast false` or `--publish false`. They mean *true*.** A boolean flag here does
> not read the following word as its value: the word is parsed as a positional and silently
> discarded, and the gate opens. `--broadcast false` creates a paid dispute and spends the
> arbitration cost; `--publish false` publishes the file permanently.
>
> **To keep a gate closed, omit the flag.** That is the default and it is what every dry run below
> relies on. If it must be explicit, use `--no-broadcast` / `--no-publish`, or the equals form
> `--broadcast=false`. Both are safe; omitting is safer, because it cannot be mistyped into its
> opposite.
>
> This matters because the CLI's own `--help` examples render `--broadcast true` and `--publish true`.
> That form is only correct for *true* — it is what makes the `false` version look plausible. Do not
> mirror it, in either direction.

```bash
# 1. What would it cost? Reads only, needs no key, sends nothing.
kleros-disputant arbitration-cost --court 1 --jurors 3

# 2. Pin the attachment, if the evidence has one. Without --publish it only checks the file.
kleros-disputant upload-file --file ./delivery-photos.pdf
kleros-disputant upload-file --file ./delivery-photos.pdf --publish

# 3. Dry run the dispute. The DEFAULT, and note there is no --broadcast here at all:
#    that absence IS the off switch. Plans, quotes, pre-flights, simulates, stops.
kleros-disputant create-dispute --court 1 --jurors 3 \
  --template-file ./dispute.json --max-cost-eth 0.02 --key-file ~/.kleros-disputant/key

# 4. Create it for real: the same command with --broadcast added. The flag takes no
#    value, so never put a bare word after it. It is the confirmation; there is no prompt.
kleros-disputant create-dispute --court 1 --jurors 3 \
  --template-file ./dispute.json --max-cost-eth 0.02 --key-file ~/.kleros-disputant/key --broadcast

# 5. Where does the dispute stand, and can evidence submitted now still reach jurors?
kleros-disputant status --dispute 215

# 6. Submit one evidence document. Dry run first, then re-run with --broadcast appended.
kleros-disputant submit-evidence --dispute 215 \
  --name "Delivery photographs" --description @statement.md \
  --file-uri /ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc --file-type-extension pdf \
  --key-file ~/.kleros-disputant/key
```

## Nothing is sent without `--broadcast`

The default for both write commands is plan → simulate → stop. `--broadcast` is the confirmation:
there is no prompt, and nothing upstream provides one. `upload-file` has the same gate under a
different name, `--publish` — nothing is broadcast to a chain there, but content addressed by a CID
cannot be withdrawn, so publishing is the irreversible step and carries its own flag.

Read `status` in the payload to know what actually happened:

| `status` | Meaning |
| --- | --- |
| `simulated` | Nothing was sent. No dispute, no submission, no cost paid |
| `mined` | The transaction was mined and its outcome was read back |
| `unknown` | Broadcast, but no receipt arrived in time. **Exit 0, and not a failure** — see below |
| `checked` | `upload-file` without `--publish`. Nothing was uploaded and no CID exists |
| `published` | `upload-file` pinned the file. `fileURI` is the value to pass on |

`arbitration-cost` and `status` carry no `status` field: they never write.

**The off switch is the absence of the flag**, never `--broadcast false` — which means true, as the
warning under Usage explains. This is the single most expensive mistake available here.

Two things a wrapping policy layer should know. The safe path is the *absence* of a flag rather than
the presence of one — there is no `--dry-run` — so the two invocations differ only by `--broadcast`.
And both write commands load the signing key even on the safe path, because the sender is part of the
simulation.

## Timing

- **Creating a dispute is untimed.** Nothing expires while you decide, and there is no reason to hurry
  an irreversible payment.
- **Evidence has no on-chain period gate.** `submitEvidence` has no access control, takes no payment
  and checks no period, and a late submission is indexed either way. So period discipline here is
  this CLI's own policy: it **warns and never refuses**. Read `warnings`, and `secondsRemaining` and
  `period` from `status`.
- The two hard refusals on that path are both unreachability: a core dispute ID no dispute uses, and
  one whose dispute a **different arbitrable** created. Either submission would succeed and then be
  unreachable by anything that reads the case. The second is not about who filed the case: every
  dispute on this deployment routes through the same arbitrable, including one filed from the Kleros
  Court web client, so all of them are reachable today.
- A receipt is waited for up to two minutes. That is not configurable, and the wait timing out is
  reported as `unknown` rather than as an error.

## When something goes wrong

Read `code`. `message` already has the hint concatenated onto it, and this tool's own `details` object
is never rendered — only that hint. Most refusals with an obvious next step carry a `cta` naming the
command to run; prefer it to guessing. The framework's `VALIDATION_ERROR` is the one exception to
output being small: it carries a `fieldErrors` array *and* repeats the same detail as a JSON dump at
the end of `message`.

Exit codes are coarse buckets for shell callers, not the contract: `0` success (including `simulated`
and `unknown`) · `1` refused, nothing sent · `2` chain, RPC or pinning failure · `3` the transaction
or its outcome · `4` signing key.

### Refused, nothing was sent — exit 1

| `code` | What to do |
| --- | --- |
| `VALIDATION_ERROR` | A required option is absent or the wrong type. Read `fieldErrors[].path` — it names the option. This is the framework refusing before the command runs |
| `UNKNOWN` | An unrecognised flag, **or** a flag given no value (`Missing value for flag: --court`), **or** any error the framework could not classify. Read the message before assuming a misspelling |
| `COMMAND_NOT_FOUND` | Not one of the five commands, and not one of incur's `completions` / `mcp` / `skills` groups either. `--llms` lists the five |
| `NUMBER_INVALID` | A numeric option was empty, signed, hex, or too precise. Counts are decimal integers; `--max-cost-eth` takes at most 18 decimal places and `--max-fee-gwei` at most 9 |
| `COURT_OUT_OF_RANGE` | Court IDs start at 1 — court 0 is the Forking Court and is never a target. If the court could not be confirmed to exist, do not retry with the same ID: a paid dispute would land in the General Court |
| `COURT_DISABLED` | That court takes no new disputes. Pick another and re-quote |
| `JURORS_INVALID` | `--jurors` must be at least 1. Zero is replaced by the arbitrator's own default and charged for |
| `DISPUTE_KIT_OUT_OF_RANGE`, `DISPUTE_KIT_NOT_SUPPORTED` | Every court on Arbitrum One supports kit 1 (Classic), so kit 1 is always a safe request. Support for any other kit is per court and a few courts do have one, so a refusal here is about the pairing, not about the kit. It is re-read with `isSupported` on every invocation and never cached: trust the refusal over any table, this one included |
| `TEMPLATE_INVALID` | `--template-file` takes a *path*. The message names the reason: unreadable, not JSON, an unknown field, or an `arbitratorAddress` that is not an address |
| `RULING_OPTIONS_INVALID` | The template needs at least two answers, with hex ids from `0x1` up, no duplicates once normalised, and never `0x0` — that id is reserved for refusing to arbitrate |
| `POLICY_URI_INVALID` | `policyURI` must be a multiaddr such as `/ipfs/Qm…`. A plain `https://` URL is refused, because the Kleros Court web client's own schema refuses it |
| `EVIDENCE_INVALID` | The message names the trap: a bare URI where the document belongs (put it in `--file-uri`), `title` where the field is `name`, a blank `name` or `description`, both of them reading stdin, or an unreadable `@path` |
| `COST_CEILING_EXCEEDED` | The quote is above `--max-cost-eth`. Raise the ceiling only if that price is intended; the cost is paid on creation and cannot be recovered |
| `INSUFFICIENT_BALANCE` | The account cannot cover the arbitration cost, or the cost plus estimated gas. Reaches `submit-evidence` too, where the whole shortfall is gas. Fund it with ETH on Arbitrum One — it sends its own transactions and there is no relayer |
| `DISPUTE_NOT_FOUND` | No dispute uses that ID. `--dispute` takes the core dispute ID, the one Kleros Court shows — not a local or external one |
| `DISPUTE_NOT_ADDRESSABLE` | The dispute is real, but a different arbitrable created it, and only that contract can say how its evidence is addressed. Retrying will not help; the message names the owner. Not reachable on this deployment today |
| `FILE_UNREADABLE`, `FILE_EMPTY` | `--file` takes one readable, non-empty regular file. The endpoint pins exactly one file per request |
| `FILE_TOO_LARGE` | The practical ceiling is around 4.6 MB of file. Split or compress it, and submit one document per file |

### Chain, RPC or pinning failure — exit 2

Nothing was judged, so nothing can be concluded from these. Neither upload code can mean money was
spent: `upload-file` holds no key.

| `code` | What to do |
| --- | --- |
| `WRONG_CHAIN` | The endpoint is not Arbitrum One. Point `--rpc-url` at chain 42161 |
| `DEPLOYMENT_INCONSISTENT` | The deployment does not match what this tool was built against — stop rather than work around it. One variant means a transaction *was* mined but the arbitrator emitted no creation event: the cost is spent, so read that transaction before creating anything else |
| `RPC_ERROR` | A read or an estimate failed. The message ends with `The endpoint said: …`, quoting the node — branch on that to tell a dead endpoint from a rate limit. An account that cannot pay is no longer one of these: it is `INSUFFICIENT_BALANCE` at exit 1. `--rpc-url` takes a comma-separated list for failover |
| `BROADCAST_FAILED` | The node refused the signed transaction, so nothing was submitted and there is no hash. Read the message before re-running |
| `UPLOAD_FAILED` | The pinning endpoint failed, or returned success having pinned nothing. Nothing was uploaded — with one exception the message states outright: a success status carrying a body that is not JSON, where nothing can be concluded about whether the file was pinned. Re-running is safe either way, because identical bytes address the same CID |
| `UPLOAD_MISMATCH` | The returned CID does not address the bytes that were sent. **Do not submit that `fileURI`.** Re-run the upload; if it recurs the endpoint is truncating and is unsafe |

### The transaction, or its outcome — exit 3

| `code` | What to do |
| --- | --- |
| `SIMULATION_REVERTED` | Nothing was sent and nothing was paid. The message decodes the revert: a cost that moved between the quote and the call is the usual cause on the creation path |
| `TRANSACTION_REVERTED` | Mined and reverted. Gas was spent; on the creation path the arbitration cost came back with the revert and no dispute exists. A revert after a clean simulation means chain state moved — read the transaction before re-running |
| `EFFECTIVE_MISMATCH` | **The dispute was created and paid for, but it is not the one that was requested.** The message says which of court, juror count or dispute kit differs. This cannot be undone: run `status` and decide what to do with that dispute before creating any replacement |

### Signing key — exit 4

| `code` | What to do |
| --- | --- |
| `KEY_FILE_MISSING` | Pass `--key-file <path>`. Both write commands need it even without `--broadcast` |
| `KEY_FILE_PERMISSIONS` | The file is readable by group or others. `chmod 600` it |
| `KEY_FILE_UNREADABLE` | The path exists but could not be read. Check ownership |
| `KEY_FILE_INVALID` | The file must hold 64 hex characters, optionally `0x`-prefixed, and nothing else — and the value must be a valid secp256k1 scalar |

### `"status": "unknown"` is not a failure

The tool stopped watching; **the transaction may still land.** Exit code 0, and the payload carries
the `txHash`.

Run `status` and read that hash on chain before doing anything else. **Never re-send blindly.** A
second `create-dispute` pays the arbitration cost again and creates a second, unrelated dispute — a
duplicate `submit-evidence` only files the same document twice and costs gas again, which is untidy
rather than harmful, and that difference is the whole reason to check which command you are retrying.
