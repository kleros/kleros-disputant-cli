# Uploading an attachment is in scope, behind its own command

Status: **accepted**, 2026-09-09. Supersedes the *conclusion* of
[ADR-0009](./0009-the-cli-references-ipfs-and-never-pins.md); its research and its endpoint
ranking still stand and this decision follows them.

ADR-0009 decided that this tool "takes already-pinned URIs as inputs and never pins anything". That
was wrong, and a Kleros v2 maintainer has reversed it **[maintainer]**. This ADR records what
replaces it, what survives it, and what was measured against the service before anything was built.

## Why the old reasoning failed

ADR-0009's division of labour — "the party that authored the content is the party that should be
keeping it available" — is sound when the caller is a person with a pinning workflow. It assumed a
caller who *already holds a CID*.

The primary consumer of this CLI is an autonomous agent (`CLAUDE.md`), and for an agent handed a
PDF and told to file it, that assumption is simply false. The agent has bytes on disk and no way to
turn them into a `fileURI`. Under ADR-0009 the tool would refuse the one step that stands between
it and a complete filing, and the "honest division of labour" becomes a job the tool declines to
finish. Evidence with an attachment was not filable end to end.

The threat ADR-0009 actually guarded against was narrower than the rule it wrote: **a pinning
credential and an HTTP client in the signing path**. That threat is still real, and the design
below removes it without removing the capability.

## Decision

A new command, **`upload-file`**, uploads one local file to IPFS and prints its `fileURI`. It is
the *only* command that speaks HTTP.

- It **never signs, never reads the chain and never loads a key.** No `prepare()`, no
  `eth_chainId` assertion, no deployment lookup — there is no chain interaction to scope, so the
  42161 invariant has nothing to bite on here.
- It is **not** folded into `submit-evidence`, and `submit-evidence` gains no `--file` flag.
- Uploading requires **`--publish`**. Without it the command validates the file locally and stops.

### Why a separate command, and not a flag on `submit-evidence`

Three reasons, the first decisive.

1. **The dry run would have to lie or to publish.** Every write command here defaults to
   plan → simulate → stop (ADR-0004). Fold the upload in, and a run without `--broadcast` must
   either upload anyway — an irreversible public side effect on the path whose entire promise is
   that it has none — or skip it and simulate a payload whose `fileURI` is not the one that would
   really be sent. Both break the one guarantee the default mode makes. There is no third option,
   because the CID is not knowable without doing the upload.
2. **The two halves have opposite cost and idempotency.** The upload is free, repeatable and
   content-addressed: identical bytes return an identical CID (**[service]**, measured). The
   transaction costs gas and is not repeatable. Split, a failed submission is retried without
   re-uploading and one upload is reused across submissions. Fused, every retry re-uploads.
3. **It keeps the HTTP client out of the signing path**, which is what ADR-0009 was really
   protecting. Two commands are two processes; the process that holds the key opens no socket to
   anything but the RPC.

ADR-0009 named this shape itself, in the escape clause it wrote for a decision it did not expect to
be reversed: *"behind its own ADR and its own separate, non-signing subcommand — never in the same
process invocation as a broadcast."* The conclusion is overturned. That sentence is not.

### Why `--publish`, and why not `--broadcast`

Pinning is irreversible in the way that matters: content pushed to a public pinning service and
addressed by CID cannot be unpublished, and an agent pointed at the wrong path leaks a private
document permanently. Unlike a wasted arbitration fee, no amount of money undoes it. Every other
irreversible action in this tool is gated, and this one is gated the same way.

It is **`--publish`** and not `--broadcast` because nothing is broadcast to a chain. Reusing the
word would make `--broadcast` mean two different irreversible things and would put an HTTP publish
behind a flag whose description says "Send the transaction."

The gate is cheap: without it the command still reports the size, the SHA-256, the derived
`fileTypeExtension` and every refusal, so the second invocation is the only one that surprises
anybody.

## The endpoint

```
POST https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs?operation=evidence&pinToGraph=false
```

`kleros/court-functions`, `functions/upload-to-ipfs.ts` — ADR-0009's first-ranked option, and the
one Kleros's own code reaches for (`kleros/reputation-oracle`, `web/src/lib/ipfs.ts`). It is
unauthenticated, needs no second chain and no second token. Backed by Filebase; `pinToGraph`
additionally publishes to a Graph node.

Overridable with `--upload-url`, mirroring the `NEXT_PUBLIC_COURT_FUNCTIONS_URL` the reputation
oracle exposes — because this is a service rather than a contract, and its availability and terms
are somebody else's to change. There is no environment variable for it, and that survived
[ADR-0016](./0016-the-environment-configures-transport-never-target.md): the override variables it
admits are named **per deployment**, and `upload-file` has no deployment — it signs nothing, reads
no chain and loads no key. So there is no name to derive one from, which is a better reason than
the one this line used to give.

### What was measured before anything was built

All **[service]**, against the live function on **2026-09-09**; reproduce with
[`spec/06 §5`](../spec/06-attachment-upload.md). The function's source was read from the private
`kleros/court-functions` repository at `master`.

| Behaviour | Measured |
| --- | --- |
| Success | `200` `{"message":…,"cids":["/ipfs/Qm…"],"inconsistentCids":[]}` — **already `/ipfs/`-prefixed** |
| `operation` absent or empty | `400 {"message":"Invalid query parameters"}` |
| `operation=banana` | **`200`.** Presence is checked; the value is passed to `pinFiles` and never read |
| Empty file, or no file part | **`200` with `cids: []`** — a success status and no CID |
| Two file parts, same field name | **One CID.** Parts are keyed by field name and the last one wins |
| Request body over 6 MiB base64 | `413`, `text/plain`, **empty body** — from the edge, not the function |
| Largest raw file accepted | between `4,700,000` and `4,718,592` bytes |
| Same bytes, different filename | **same CID** — content-addressed, no directory wrap, CIDv0 |
| `GET`, `PUT` | `405` |
| Latency | 0.3–2 s across 23 B to 4 MiB |

Four of those rows are load-bearing and each one becomes a rule in `spec/06`:

- **A `200` is not a success.** An empty or absent file yields `200` with an empty `cids` array.
  The CLI treats a `2xx` carrying no CID as a failure, and refuses an empty file locally first.
- **The size ceiling is on the base64-encoded request, not the file.** Netlify caps the encoded
  body at 6 MiB, so the file plus its multipart framing must stay under three quarters of that. The
  CLI enforces it locally, because the `413` arrives with an empty body and explains nothing.
- **Exactly one file part per request**, or a file is silently dropped.
- **`operation` must be sent** even though its value is discarded, or every upload is a `400`.

### The latent bug this design assumes nothing about

The function's multipart handler assigns the file on **every** `data` event:

```ts
bb.on("file", (name, file, { filename, mimeType }) =>
  file.on("data", (content) => {
    fields[name] = { isFile: true, filename, mimeType, content };
  })
)
```

Each chunk *replaces* the last, so a file delivered in more than one chunk would be pinned as its
final chunk alone — silently, under a CID that is perfectly valid for the truncated bytes. It does
not fire today only because the handler feeds busboy the whole body in a single `bb.write()`, so
one `data` event carries the part. That was confirmed by round-tripping 23 B, 16 KiB, 64 KiB,
128 KiB, 512 KiB, 1 MiB, 2 MiB and 4 MiB through the gateway byte for byte **[service]**.

The CLI therefore **verifies by default**: it fetches the returned CID back and compares it to the
bytes it sent, refusing on a mismatch (`--verify` is on by default; `--no-verify` opts out). This
is the only check that catches a silent truncation, and it turns a latent corruption into a loud
refusal.

Reading back bytes the tool itself just uploaded is **not** a breach of
[ADR-0007](./0007-evidence-is-opaque-operator-supplied-bytes.md). That rule forbids dereferencing
operator-supplied and counterparty URIs and interpreting what comes back. Here the tool already
holds the bytes, compares them, and discards the response; nothing read can influence which call is
made or with what arguments. A URI the operator *hands* the tool is still never fetched.

## What survives ADR-0009

- **Exactly one credential: the signing key.** The endpoint is unauthenticated, so this is
  unchanged and `spec/03 §6` still holds in full.
- **No HTTP client in the signing path.** `create-dispute` and `submit-evidence` remain pure RPC.
- **The tool still never dereferences a URI it was given.** `--file-uri`, `policyURI` and every URI
  in on-chain data are recorded and never fetched.
- **No partial-failure state.** The old ADR feared "pinned but not submitted, or submitted pointing
  at content that never pinned". Ordering removes the second: `upload-file` completes, and its
  output is what `submit-evidence` is then given. The first is not a failure — an unreferenced pin
  costs nothing and harms nobody.
- **No subgraph, no indexer in the write plane.** Unchanged.

## What is overturned

- `spec/00`'s non-goal 4, "IPFS pinning", is deleted.
- The scope table's "IPFS: referenced, never pinned. **No HTTP client**" becomes "referenced;
  uploaded only by `upload-file`".
- `README.md`'s "It does not: pin to IPFS, or run any HTTP client at all".
- `CLAUDE.md`'s "RPC only — no subgraph, no pinning, no HTTP client".

## Consequences

A service dependency now exists, on exactly one command. An outage of it cannot wedge a write,
because no write command talks to it; it can only stop a *new* attachment being published, and an
attachment already pinned is unaffected. The failure is loud, local and named
(`UPLOAD_FAILED`), and the operator keeps the option of pinning elsewhere and passing `--file-uri`
by hand — the ADR-0009 path still works and is still supported.

The cost is that this repo now has a code path whose correctness depends on somebody else's
deployment. `spec/06 §5` records how to re-measure it, and every claim above is marked
**[service]** so a reader can tell it apart from a claim about a contract.
