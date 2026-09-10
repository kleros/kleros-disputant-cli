# 05: Live testnet acceptance test

**What to build:** A full lifecycle — quote, plan, create, submit evidence, report status — run
against the **live** v2 testnet through the built binary, in separate processes. This is the
rehearsal the tool has never had: the first time the envelope, the signing path, the endpoint and the
receipt are exercised together against real infrastructure. It runs before the first Arbitrum One
broadcast, so that broadcast is a confirmation rather than an experiment.

**Blocked by:** 02, 04.

**Status:** done — the full lifecycle ran against the **live** v2 testnet on 2026-09-10 and
created core dispute 128 there.

- [x] The command that currently points at a file which does not exist runs a suite that does.
- [x] The lifecycle runs through the built binary in separate processes, against the live v2 testnet.
- [x] Assertions are **relational**, not pinned, because a live deployment has no fixed block and no
      fixed cost: the cost reported in the envelope equals the cost quoted immediately before it; the
      reported core dispute ID resolves on chain; the emitted evidence log carries the exact bytes
      submitted; the local dispute ID the tool resolved matches the mapping read back from the chain
      — read from the emitted `Evidence` log, **not** from the envelope, which deliberately never
      carries it (`ADR-0014`, `spec/05 §1.6a`);
      and the dispute reports the expected period.
- [x] The two existing assertions are kept verbatim: that no secret reached either output stream, and
      that nothing was written to disk. They are why it runs in separate processes.
- [x] It skips **loudly** when no funded testnet key is present, in the manner this repo already uses
      for a suite whose prerequisite is absent.
- [x] It is a release gate, not a CI job. Nothing in continuous integration depends on a funded key or
      on testnet availability.
- [x] Each run broadcasts permanently and creates real testnet disputes. This is stated where someone
      deciding whether to run it will read it.
- [x] The existing fork suite is untouched beyond ticket 02's one assertion change (`spec/05 §2.7`). Two of its tests seed state Arbitrum One cannot provide,
      and though the testnet now supplies one of them natively, they remain the only deterministic
      proof and testnet state can change underneath us.

---

## Progress — the suite is written, the live run is not

**Done.** `src/__tests__/acceptance.testnet.test.ts`, wired to `pnpm test:acceptance`, which now
builds first and sets the opt-in. Five lifecycle tests in order — quote, simulate, create, submit
evidence, status — each one command, one process, the built `dist/cli.js`, plus a sixth that
restates the two standing assertions across every invocation.

**Verified against a fork of the v2 testnet**, `anvil --fork-url <arbitrum sepolia> --port 8547`
with the signing account funded by `anvil_setBalance` and the endpoint supplied through
`KLEROS_RPC_URL_ARBITRUM_SEPOLIA_TESTNET`. 6/6 green. That fork carries the real deployment, the
real contracts and the real identifier separation — core 127 resolves to local 77 there — so
everything except a real mempool, real gas and a real receipt is exercised.

**Both standing assertions were falsified before being trusted.** Widening the leak detector's
needles to a string the envelope certainly contains failed all six tests; writing one file into the
redirected `HOME` failed them too. The first falsification found a real defect: an `expect` that
throws inside the `execFile` callback is outside the promise executor, so nothing rejected and a
leak reported itself as a 180-second timeout rather than as the assertion that fired. The callback
now settles on every path, and `spec/05 §3` records the rule.

**The two identifiers are asserted to differ**, not merely to match the mapping. On this deployment
a second arbitrable has already filed, so the assertion has teeth that no Arbitrum One fork can give
it without seeding (`spec/05 §3.4`, `ADR-0014`).

**The live run happened.** The maintainer funded `0x4f1Ea8528a4c1C305F0c088322867ADd54e8642f`
with 0.03 ETH on Arbitrum Sepolia and `pnpm test:acceptance` went green, 6/6, against the live
deployment — **the first transaction this tool has ever broadcast to a live chain**. It created
**core dispute 128** in court 1, in the evidence period, and filed E1's 106 bytes against it under
**local dispute 78**. Two transactions, nonce 0 → 2, **0.000212205 ETH** all in: a 0.00003 ETH
arbitration fee and the rest gas. The 12M-unit gas reserve the funding check holds back is about
sixteen times what the pair actually cost, which is the intended direction for a number that only
decides whether to skip.

**Five findings from `/code-review high` were fixed before the live run**, all in the suite itself.
The one that mattered: the opt-in had been `KLEROS_ACCEPTANCE=1`, an **inheritable** variable, so
exporting it once — the obvious thing to do while iterating — would have armed every later
`pnpm test` in that shell, and `prepublishOnly` runs `pnpm test`. A variable that decides whether
money is spent is the invisible input ADR-0016 refuses for `--chain`; the opt-in is now
`npm_lifecycle_event === "test:acceptance"`, which is per process and cannot be exported. The other
four: `resolveCourt`'s bare `catch` reported a rate-limited endpoint as "no enabled court on this
deployment" and now rethrows anything that is not a revert; the gas reserve was thin enough that a
create could be paid for and the evidence submission then fail, leaving an orphan dispute; the two
post-broadcast reads are retried, because the endpoint behind them is a load balancer and this repo
has already recorded it dropping data; and the exit status is now derived correctly — `execFile`
puts a string there on a spawn failure and nothing at all on a timeout — and **asserted**, which
`spec/03 §5` wanted and nothing else in the repo can check.
