# 06. Attachment upload

The only plane in this specification that is not the chain. One command, `upload-file`, turns a
local file into the `fileURI` that [02 §4.1](./02-payload-construction.md) takes as an input.

[ADR-0012](../adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md) is why this exists
and why it is a separate command; [ADR-0009](../adr/0009-the-cli-references-ipfs-and-never-pins.md)
is why the rest of the tool still touches IPFS nowhere else.

Every claim here marked **[service]** was measured against the live function on **2026-09-09**.
Re-measure with [§5](#5-re-measuring-the-service). A service is not a contract: these facts can
change without a deployment this repo can fingerprint, which is why they are marked apart from
every **[live]** and **[fork]** claim in this document set.

## 1. Shape

`upload-file` **MUST NOT** sign, read the chain, or load a signing key. It **MUST NOT** call
`prepare()`, assert `eth_chainId`, or resolve the deployment: there is no chain interaction here,
so the 42161 assertion of [03 §7](./03-cli-surface.md) has nothing to scope.

It **MUST** upload exactly one file per invocation, and **MUST NOT** be reachable from
`create-dispute` or `submit-evidence`. Those two commands **MUST NOT** open a socket to anything
but the RPC.

Uploading **MUST** require `--publish`. Without it the command performs every local check in
[§3](#3-local-validation), reports what it found, and stops. This mirrors
plan → simulate → stop ([ADR-0004](../adr/0004-broadcast-is-opt-in-no-human-gate.md)) for an
action irreversible in the same way and for the same reason: published content addressed by CID
cannot be withdrawn.

## 2. The request

```
POST {endpoint}?operation=evidence&pinToGraph=false
Content-Type: multipart/form-data; boundary=…

  file=<the bytes>; filename="<basename>"
```

Default endpoint:
`https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs`. Overridable with
`--upload-url`. There **MUST NOT** be an environment variable for it
([03 §3](./03-cli-surface.md)).

### 2.1 Query parameters

| Parameter | Value | Rule |
| --- | --- | --- |
| `operation` | `evidence` | **MUST** be present and non-empty |
| `pinToGraph` | `false` | Sent explicitly |

**[service]** `operation` is checked for presence only. The handler passes it to `pinFiles`, which
never reads it: `operation=banana` returns `200`. Absent or empty returns
`400 {"message":"Invalid query parameters"}`. The CLI **MUST** send it anyway — the check is on
presence, and omitting it fails every upload.

**[service]** `pinToGraph=true` also publishes to a Graph node and reports any CID disagreement in
`inconsistentCids`. The CLI **MUST** send `false`: the Graph copy is an indexing convenience this
tool has no use for, a second service in the path, and a second way to half-succeed.

### 2.2 The form

Exactly **one** file part, field name `file`.

**[service]** Parts are keyed by field name in the handler and the last write wins, so two parts
named `file` pin **one** CID and the earlier file is silently dropped. Distinct field names pin
one CID each, in insertion order. Neither shape is useful here and both are ways to lose a file, so
the CLI **MUST** send a single part.

**[service]** The CID is the content's alone: the same bytes under `alpha.txt` and `beta.pdf`
return the same CIDv0, with no directory wrap. So `fileURI` addresses the file directly, a filename
never has to be appended to it, and re-uploading identical bytes is free and idempotent.

## 3. Local validation

All of it **MUST** run before any request, and each failure **MUST** name its own code.

| Check | Code | Why it is local |
| --- | --- | --- |
| The path is readable | `FILE_UNREADABLE` | No round trip for a typo |
| The file is non-empty | `FILE_EMPTY` | **[service]** An empty part returns `200` with `cids: []`. A success status and no CID |
| The encoded request fits | `FILE_TOO_LARGE` | **[service]** Over the limit the edge returns `413` with an **empty `text/plain` body**, which explains nothing to anybody |

### 3.1 The size limit is on the encoded request, not on the file

**[service]** The platform budget is **6 MiB on the base64-encoded function event**, and the
encoded body is only the dominant term in it — request headers and the query string are inside the
same budget. Measured by bisection: a multipart body encoding to `6,284,972` bytes was accepted and
one encoding to `6,285,020` was rejected, leaving about `6.4 KB` of the 6 MiB spent on everything
else. That residue is not constant, so **no fixed maximum file size is correct**.

The CLI **MUST** therefore:

1. serialise the exact multipart body it intends to send, and measure it;
2. compute its base64 length, `ceil(len / 3) * 4`;
3. refuse if that exceeds **`6 MiB − 64 KiB` = `6,225,920` bytes**.

The 64 KiB is deliberate headroom over the ~6.4 KB observed, because the residue grows with header
size and the filename travels in the body. It puts the practical ceiling near **4.66 MB** of file,
against a measured true boundary of about **4.71 MB** — a refusal band of roughly 50 KB in which
the CLI declines a file the service would have taken. That trade is correct: the false refusal is
explicit, names the size and the limit, and is recoverable, while the `413` it avoids is an empty
body from an edge the operator never addressed.

Measuring the real body rather than assuming an overhead is what makes this adapt to a long
filename instead of guessing at it.

## 4. The response

**[service]** Success is `200` with:

```json
{ "message": "File has been stored successfully", "cids": ["/ipfs/Qm…"], "inconsistentCids": [] }
```

`cids` entries are **already `/ipfs/`-prefixed**. The CLI **MUST** accept both forms and normalise
to `/ipfs/<cid>` — the multiaddr form [02 §3.4](./02-payload-construction.md) requires of
`policyURI`, and the form the Kleros Court web client resolves.

### 4.1 A `2xx` is not a success

**[service]** An empty file, or a request with no file part at all, returns **`200` with
`cids: []`**. The CLI **MUST** treat any `2xx` that yields no CID as `UPLOAD_FAILED`. [§3](#3-local-validation)
refuses the empty file first, so this is the backstop for a shape nobody predicted, not the
primary defence.

The CLI **MUST NOT** parse a non-`2xx` body as JSON: `413` arrives as `text/plain` and empty.

### 4.2 Verification is on by default

The CLI **MUST**, unless `--no-verify` is passed, fetch the returned CID from an IPFS gateway and
compare the bytes to what it uploaded.

- Bytes differ, or the length differs → **`UPLOAD_MISMATCH`**, a hard failure. The CID does not
  address the file.
- The gateway does not answer, or answers non-`2xx` after its retries → a **warning**, never a
  failure. The pin most likely succeeded and refusing would be a lie about what happened.

This exists because of a specific defect in the deployed handler, recorded in full in
[ADR-0012](../adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md): the file is
reassigned on **every** `data` event, so a body delivered in more than one chunk would pin its last
chunk alone, under a CID that is entirely valid for the truncated bytes. Nothing else catches that.
It does not fire today — 23 B through 4 MiB round-tripped byte for byte **[service]** — because the
handler feeds busboy the whole body in one `write()`. "Does not fire today" is not a property this
CLI should depend on silently.

Reading those bytes back is **not** a breach of [ADR-0007](../adr/0007-evidence-is-opaque-operator-supplied-bytes.md).
The tool already holds them, compares them, and discards the response. Nothing read can reach a
payload or change which call is made. A URI the *operator* supplies is still never dereferenced.

## 5. Re-measuring the service

Everything marked **[service]** in this document came from these. They send real files to a real
pinning service; the bytes below are inert test content.

```bash
E=https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs

# success, and the /ipfs/ prefix the response already carries
printf 'probe\n' > /tmp/p.txt
curl -sS -X POST "$E?operation=evidence&pinToGraph=false" -F "file=@/tmp/p.txt"
# -> {"message":"File has been stored successfully","cids":["/ipfs/Qm…"],"inconsistentCids":[]}

# operation is checked for presence, never for value
curl -sS -X POST "$E?pinToGraph=false"                 -F "file=@/tmp/p.txt"   # 400
curl -sS -X POST "$E?operation=&pinToGraph=false"      -F "file=@/tmp/p.txt"   # 400
curl -sS -X POST "$E?operation=banana&pinToGraph=false" -F "file=@/tmp/p.txt"  # 200

# a 200 with no CID
: > /tmp/empty.txt
curl -sS -X POST "$E?operation=evidence" -F "file=@/tmp/empty.txt"   # {"cids":[]}
curl -sS -X POST "$E?operation=evidence" -F "notafile=hello"         # {"cids":[]}

# two parts under one field name pin one CID
curl -sS -X POST "$E?operation=evidence" -F "file=@/tmp/a.txt" -F "file=@/tmp/b.txt"

# the ceiling, and what it says when you cross it
head -c 4700000 /dev/zero > /tmp/big.bin
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$E?operation=evidence" -F "file=@/tmp/big.bin"  # 200
head -c 4800000 /dev/zero > /tmp/toobig.bin
curl -sS -w '\n%{http_code} %{content_type}\n' -X POST "$E?operation=evidence" -F "file=@/tmp/toobig.bin"  # empty body, 413

# wrong method
curl -sS -o /dev/null -w '%{http_code}\n' "$E?operation=evidence"   # 405

# round trip
curl -sS "https://cdn.kleros.link/ipfs/<cid>" | cmp - /tmp/p.txt
```

The exact boundary in [§3.1](#31-the-size-limit-is-on-the-encoded-request-not-on-the-file) was
found by bisection on the encoded body length, not by these one-shot commands.

## 6. Error codes

Added to [03 §5.5](./03-cli-surface.md)'s list, and **MUST NOT** be renamed.

| Code | Exit | Raised when |
| --- | --- | --- |
| `FILE_UNREADABLE` | 1 | `--file` does not exist, is not a regular file, or cannot be read |
| `FILE_EMPTY` | 1 | The file is zero bytes. The service would answer `200` and pin nothing |
| `FILE_TOO_LARGE` | 1 | The encoded request would exceed the budget in [§3.1](#31-the-size-limit-is-on-the-encoded-request-not-on-the-file) |
| `UPLOAD_FAILED` | 2 | Non-`2xx`, a transport error, or a `2xx` carrying no CID |
| `UPLOAD_MISMATCH` | 2 | The gateway returned different bytes for the CID than were uploaded |

Exit `2` is *"chain, RPC or upload-service failure"* — nothing was judged, so nothing can be
concluded. Neither of these two can mean money was spent: this command never signs.

## 7. Output

### 7.1 Checked, not published

```json
{
  "ok": true,
  "command": "upload-file",
  "status": "checked",
  "published": false,
  "file": { "path": "./evidence.pdf", "bytes": "184320", "sha256": "9f2c…" },
  "fileTypeExtension": "pdf",
  "endpoint": "https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs",
  "warnings": [],
  "message": "CHECKED ONLY — nothing was uploaded and no CID exists yet. evidence.pdf is 184320 bytes and within the limit. Re-run with --publish to upload it, which publishes the file permanently and cannot be undone."
}
```

### 7.2 Published

```json
{
  "ok": true,
  "command": "upload-file",
  "status": "published",
  "published": true,
  "fileURI": "/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
  "cid": "QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
  "fileTypeExtension": "pdf",
  "file": { "path": "./evidence.pdf", "bytes": "184320", "sha256": "9f2c…" },
  "verified": true,
  "warnings": [],
  "message": "Uploaded evidence.pdf and verified the CID addresses those exact bytes. Pass --file-uri /ipfs/QmWQV5… --file-type-extension pdf to submit-evidence. The file is public and permanent; nothing has been submitted to any dispute."
}
```

`fileTypeExtension` is **derived from the path** and echoed so it can be passed straight on. It is
a subgraph-only field ([Appendix A §3.7](./appendix-a-unresolved.md)) and the CLI never uses it for
anything else. When the path has no extension the field is omitted rather than guessed.

`verified` is `false` with a warning when the gateway could not confirm, and the command fails
outright rather than reporting `false` when it *dis*confirmed ([§4.2](#42-verification-is-on-by-default)).

**The message MUST say that nothing has been submitted.** An agent that has just received a CID is
one step from believing the evidence is filed; the two commands are separate and the output has to
say so.

### 7.3 The next command

`upload-file` **SHOULD** emit a CTA naming `submit-evidence` with the `--file-uri` and
`--file-type-extension` it just produced. This is the one seam between the two commands, and the
CTA is what keeps the split from costing the agent a step
([03 §5.4](./03-cli-surface.md) governs the form).
