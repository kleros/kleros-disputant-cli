# Revert message bounds

## The problem

`decodeRevert` builds the operator-facing message for `SIMULATION_REVERTED` and `BROADCAST_FAILED`.
Two of its branches interpolate bytes that came off the wire into that message **with no length
bound and no sanitisation**: the `Error(string)` branch passes the decoded reason through verbatim
(`src/core/reverts.ts:151`), and the unmapped-selector branch interpolates the raw revert data as
hex (`src/core/reverts.ts:178-185`). Nothing downstream bounds them — `finish` appends the hint and
a full stop (`src/commands/shared.ts:335-353`), and incur's `truncate` is gated behind a token-limit
flag this CLI never passes.

This contradicts `spec/03 §5`, which requires the payload stay small, and it is inconsistent with
`ADR-0013`, which capped the **RPC cause** fragment at 160 characters for exactly this reason. The
sibling foreign fragment was bounded; this one was not.

## What was measured

Measured 2026-09-10 on `a1bdebb`. Two harnesses, both throwaway: a module-level one driving
`decodeRevert` with real viem errors raised by `anvil` on `:8547` with `anvil_setCode`, and an
end-to-end one driving the **built `dist/cli.js`** through an intercepting proxy in front of
Arbitrum One that injected the revert at the simulate `eth_call` and answered `eth_getBalance` so
the affordability gate was reached. No `--broadcast`, and the Arbitrum One nonce was 12 before and
after.

End to end, through the binary, `create-dispute` on `arbitrum-one`:

| Revert data on the wire | `message` chars | stdout bytes | exit |
| --- | --- | --- | --- |
| `Error(string)`, 8 KiB | **8250** | 8303 | 3 |
| `Error(string)`, 288-char injection payload | 346 | 421 | 3 |

At the module, for branches the end-to-end harness did not need to reach:

| Revert data on the wire | `guidance` chars |
| --- | --- |
| unmapped selector + 4 KiB data | **8418** (hex doubles it) |
| mapped Kleros error, `AlreadyInitialized()` | 66 |
| revert with empty data | 76 |
| address holds no code | 91 |
| RPC answers HTTP 500 | 38 |

The envelope came back `{code, message}` at 8 KiB with no `details` key, so `ADR-0013`'s closed
envelope holds under load and only `guidance` carries size — `DecodedRevert.data` is invisible to
every output mode.

Content is passed through as well as size. An injected payload carrying newlines, `"` and an ANSI
`ESC [ 2 J` reached `message` byte-for-byte. `format: "json"` escapes them on the way out so the
envelope stays parseable, but the consuming agent reading the parsed string still receives them, and
in human/TTY mode `formatHumanError` writes them to the terminal raw.

## What was ruled out

**No credential leak.** The `BaseError` fallback (`src/core/reverts.ts:190`) uses
`error.shortMessage`, measured as `"HTTP request failed."` — no URL, no args, no account. viem's
full `error.message` for that same failure is 2283 characters and **does** contain the credential
embedded in the RPC URL. The protection is therefore the left-hand side of
`error.shortMessage || error.message`; whether any viem error ships an empty `shortMessage` and
falls through to the right-hand side was **not measured**.

**Not counterparty-reachable today.** Both `decodeRevert` call sites take their target from
`contracts.disputeResolver` / `contracts.evidenceModule` (`src/commands/write.ts:129-140`,
`:312-326`), resolved from the pinned deployments. The reachable internal call stacks are
Kleros-governed throughout — `DisputeResolver` calls `arbitrator` and `templateRegistry`, both
asserted equal to this tool's pinned addresses on every invocation by `checkDeployment`, and
`KlerosCore._createDispute` calls only `sortitionModule` and `disputeKits[id]`, a governor-registered
registry; `EvidenceModule.submitEvidence` makes no external call at all. The protocol's one
arbitrable callback, `DisputeResolver.rule`, is guarded by `ArbitratorOnly` and sits on an execution
path this tool never invokes. No option names an address: `--dispute` is numeric and `--kit` is a
bounds-checked index, and the third-party `arbitrable` address read out of `disputes()` is
string-compared, never called (`src/core/read-preflight.ts:218-221`).

**The guard is reachability, not the code.** The one live vector is `--rpc-url`: the endpoint
supplies the revert bytes and `assertChain` constrains the chain ID, not the response body, which is
how the end-to-end measurement was driven. That is operator-chosen, so this is a robustness and
output-size defect rather than a trust boundary — and it is one deployment change away from being
neither.
