# ADR-0017: Text this repo did not write is bounded before it reaches a message

**Status:** accepted, 2026-09-10
**Supersedes:** nothing. **Amends:** [ADR-0013](./0013-the-rpc-cause-travels-in-the-hint.md), which
bounded the first of these fragments and chose 160 characters. That number is now shared rather than
repeated, and [01 §5](../spec/01-onchain-reference.md)'s "surfaced verbatim", which was
discharged through the `message` and is now discharged through a field.

## Context

`decodeRevert` builds the sentence a caller reads for `SIMULATION_REVERTED` and `BROADCAST_FAILED`.
Two of its branches interpolated bytes that arrived from the wire straight into that sentence: the
`Error(string)` reason, and the raw data of a revert nothing in our ABIs names. Neither had a length
this repo controls, and nothing downstream supplied one — `finish` appends the hint and a full stop,
and incur's `truncate` is gated behind a token-limit flag this CLI never passes.

Measured on 2026-09-10 through the **built binary**, `create-dispute` on `arbitrum-one` with the
revert injected at the simulate `eth_call`: an 8 KiB `Error(string)` produced **8250 characters** of
`message` and 8303 bytes of stdout. At the module, 4 KiB of unmapped revert data produced 8418
characters, because hex doubles it. The controls — a mapped Kleros error, an empty revert, an address
holding no code, an RPC answering HTTP 500 — ran 38 to 226 characters. The full measurement is
`.scratch/revert-message-bounds/spec.md`.

Content passed through as well as size. An injected payload carrying newlines, a `"` and an ANSI
`ESC [ 2 J` reached `message` byte-for-byte: rendered to a terminal it clears the screen, and inside
the message it forged a second JSON envelope reading as a successful result. `format: "json"` escapes
both on the way out, so the envelope stays parseable — but **the primary consumer is an agent reading
the parsed string**, which receives them intact, and `formatHumanError` writes them raw.

## The part worth writing down: why this was not already a bug report

**No counterparty-controlled contract can reach these branches on either served deployment.** This
was checked rather than assumed, and the check is the reason the fix is a bound and not a quarantine:

- Both `decodeRevert` call sites take their target from `contracts.disputeResolver` and
  `contracts.evidenceModule`, resolved from the pinned deployments — never from an argument.
- `EvidenceModule.submitEvidence` makes no external call at all. `DisputeResolver._createDispute`
  calls exactly `arbitrator` and `templateRegistry`, both asserted equal to this tool's pinned
  addresses on every invocation by `checkDeployment`; `KlerosCore._createDispute` calls only
  `sortitionModule` and `disputeKits[id]`, a governor-registered registry.
- The protocol's one arbitrable callback, `DisputeResolver.rule`, is guarded by `ArbitratorOnly` and
  sits on an execution path this tool never invokes.
- No option names an address: `--dispute` is numeric, `--kit` is a bounds-checked index, and the
  third-party `arbitrable` read out of `disputes()` is string-compared, never called.

**So the guard today is the call stack, not the code.** That is a property of which contracts happen
to be in the path, and it is one governor action or one new arbitrable away from being false — while
the branch that would then carry the payload is the same branch that already renders 8 KiB. The one
live vector is `--rpc-url`: the endpoint supplies the bytes, and `assertChain` constrains the chain
ID and not the response body. That is operator-chosen, so it is robustness rather than a trust
boundary — which is why this is an ADR and not an advisory.

## Decision

**Every fragment of an error message that this repo did not write passes through `boundForeign`.**
One helper, `core/foreign-text.ts`, holding one constant:

1. **Capped at 160 characters, and the cut is marked** with `…`. A caller that cannot tell a bounded
   message from a short one reads the cut as the whole of what the chain said. The number is
   `ADR-0013`'s, and `client.ts`'s cause summary now calls the same helper rather than keeping a
   second copy of it — a third foreign fragment cannot be added without meeting the rule.
2. **Control and format characters become spaces, then runs collapse.** C0 with DEL, C1, and the
   Unicode `Cf` class — U+202E RIGHT-TO-LEFT OVERRIDE reverses the rendered tail of a line including
   this repo's own `Nothing was sent.`, and U+200B is invisible; they steer a terminal exactly as the
   ANSI escape does, in a different Unicode class. Each becomes a space rather than being deleted, so
   two words separated only by a newline do not fuse. A `message` is one line of prose; nothing in it
   needs to move a cursor. The cut also never halves a surrogate pair, which would render as U+FFFD.
3. **The cap is on the fragment, not on the message.** This repo's own guidance — `GUIDANCE_BY_ERROR`
   for an underpayment runs to 237 characters — is not truncated, and a test pins that, because a cap
   applied one level up would have clipped our own sentences instead of the wire's.
4. **The selector is never bounded.** For unmapped data the message keeps the whole 4-byte selector,
   then a bounded prefix of the blob and its total size in bytes. The selector is the part a reader
   looks up; the trailing data is what runs to kilobytes.
5. **The guidance tables are `Map`s, and that is load-bearing rather than stylistic.** The reason is
   a key that came off the wire: against an object literal, a contract reverting with
   `require(false, "constructor")` reaches `Object.prototype` and returns a *function*, which `??`
   does not treat as absent — so the bound is skipped and `guidance`, typed `string`, holds
   `function Object() { [native code] }`. The defect predates this decision (`?? reason` had it too)
   but it falsifies this one's central claim, so it is fixed here and pinned by a test row per
   prototype member.
6. **`reason` and `data` on the result stay verbatim and unbounded.** `spec/01 §5` requires unmapped
   data be surfaced rather than swallowed, and that is now discharged where it always effectively
   was: no output mode renders `details` (`ADR-0013`), so the full data costs a CLI caller nothing
   and remains for a consumer importing the core from `dist/index.js`.

**And `error.shortMessage || error.message` narrows to `shortMessage` alone**, with a fixed sentence
when it is empty. viem's full `message` is its short message plus the request dump — the address, the
function, the arguments, the docs URL and, on a transport failure, **the endpoint URL, whose path on
a paid endpoint is the credential**. Measured at 2283 characters carrying an API key. Nothing
established that a viem error can ship an empty `shortMessage` and reach the right-hand side, and
nothing needed to: the branch was deleted rather than reasoned about. `client.ts` redacts URLs out of
the RPC cause for the same reason; this path now declines to collect one.

## What this costs

**An operator loses the tail of a long revert reason.** No Kleros contract in the reachable path
emits one — the longest observed is 36 characters — so today the cost is zero and the bound exists
for the day that stops being true. A caller that needs the whole thing has `data` on the result, and
the CLI is not that caller.

**A `message` no longer reproduces the chain's bytes exactly.** That is the point. `spec/01 §5`'s
verbatim requirement moved from the sentence to the field, and the sentence keeps what a reader acts
on: the selector, the size, and the first 160 characters.

**A bounded, control-stripped fragment is still the wire's words.** Re-measured through the rebuilt
binary, the 8 KiB payload renders as 218 characters and the injection payload keeps no ESC and no
newline — but its *prose* survives, and it still reads as an instruction to re-run with
`--broadcast`. That is not what this decision fixes and cannot be: censoring a revert reason for
persuasiveness would mean parsing it, and `ADR-0007`'s rule is that content from outside is never
interpreted. What protects the caller is that the sentence arrives inside a `message` on a failure
envelope with a stable `code`, and that **nothing in this tool acts on a message** — the agent
reading it decides, and the tool broadcasts only on an explicit `--broadcast` (`ADR-0004`). The
bound keeps a payload from crowding out the fields that carry the actual decision; it does not make
the payload trustworthy, and no message ever should be treated as though it were.

**Two files share a constant that neither owns.** `foreign-text.ts` is imported by `reverts.ts` and
`client.ts` and imports nothing itself, so there is no cycle to manage — but a future third caller is
the whole reason it exists, and putting the number back inline would silently undo this decision.
