# 01: Bound and sanitise the foreign fragments of a revert message

**What to build:** The two branches of `decodeRevert` that interpolate bytes from the wire into an
operator-facing message bound what they interpolate and strip what a terminal or an agent would
misread, the way `ADR-0013` already bounds the RPC cause. The tool's own guidance sentences are
untouched; only the fragment that came off the wire is bounded.

This is an output-size and robustness defect, not a trust boundary. Nothing a counterparty controls
can reach these branches today — `spec.md` records the reachability measurement — but the only thing
holding that is which contracts happen to be in the call stack, and an 8 KiB revert string already
produces an 8250-character `message` through the built binary on a deployment this tool serves.

**Blocked by:** None (can start immediately).

**Status:** done, 2026-09-10 — `ADR-0017`, `spec/01 §5`, `spec/03 §5.1`, `core/foreign-text.ts`

- [x] The `Error(string)` branch bounds the decoded reason before it becomes guidance. A reason that
      matches `GUIDANCE_BY_REASON` still resolves to the tool's own sentence at full length — that
      table is ours, not the wire's — and only the unmatched pass-through is bounded.
- [x] The unmapped-selector branch bounds the raw hex it interpolates **while keeping the 4-byte
      selector intact and unbounded**. The selector is the part a reader looks up; the trailing data
      is what runs to kilobytes.
- [x] The bound is 160 characters, the same number `ADR-0013` chose for the RPC cause, and it is
      applied at one named helper rather than at each call site, so a third foreign fragment cannot
      be added without meeting it. Truncation is visible in the output — a caller must be able to
      tell a bounded message from a short one.
- [x] Control characters are removed from the bounded fragment: C0 (newline, carriage return and the
      ESC that starts an ANSI sequence included) and C1. The measured payload cleared the terminal
      and forged a second JSON envelope inside `message`; `format: "json"` escaped it on the way out,
      but the agent reading the parsed string still received it and human mode wrote it raw.
- [x] `DecodedRevert.data` keeps the revert data **verbatim and unbounded**. `spec/01 §5` requires
      unmapped data be surfaced rather than swallowed, and the field is where that survives; no
      output mode renders it, so it costs a caller nothing.
- [x] The tension that creates is resolved explicitly, not silently: `spec/01 §5` currently discharges
      "surfaced rather than swallowed" through the guidance string, and bounding that string narrows
      what an operator sees. The section is amended to say the **selector** is what is surfaced in
      the message and the full data lives in a field the CLI does not render.
- [x] `error.shortMessage || error.message` narrows to `shortMessage` alone with a fixed fallback when
      it is empty. The right-hand side was measured at 2283 characters carrying the credential
      embedded in the RPC URL, and nothing establishes that it is unreachable — the ticket does not
      need it to be reachable to delete it.
- [x] Tests pin each bound against a payload that exceeds it: an oversized `Error(string)`, an
      oversized unmapped blob, and a reason carrying a newline and an ESC. At least one asserts on
      the message that leaves the **command layer**, not only on `decodeRevert`'s return, because
      `finish` is what appends the hint and the deployment suffix.
- [x] A test pins that a mapped Kleros error and a matched `GUIDANCE_BY_REASON` row are **not**
      truncated. The measured control cases run 66 to 226 characters and a cap applied at the wrong
      level would silently clip the tool's own guidance.
- [x] `spec/03 §5.1` rule 4 gains revert data. It reads "Output is kept small. The template body and
      the evidence text **MUST NOT** be echoed back in full" — an enumeration that names the two
      operator-supplied blobs and misses the one that arrives from the chain. Adding it with the
      number makes the rule checkable rather than a disposition.
- [x] A new ADR records the decision and, importantly, the reachability finding behind it: that no
      counterparty-controlled contract can reach these branches on either served deployment today,
      what was checked to establish that, and that the bound exists because the guard is the call
      stack rather than the code. Without it the measurement in `spec.md` is re-run by the next
      reader who notices the branch.
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` stay clean, and `pnpm test:fork` is
      unaffected — the fork suite asserts on `SIMULATION_REVERTED` messages in three places
      (`src/__tests__/fork.test.ts:515`, `:537`, `:551`) and those are real reverts from real
      contracts, so they must stay under the bound and unchanged.
