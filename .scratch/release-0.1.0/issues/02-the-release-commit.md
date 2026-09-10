# 02: The release commit

**What to build:** Phase B. The single commit that publishes `0.1.0`, containing every change whose
truth turns over at that moment and nothing else — so the diff can be read as "these are the claims
publication changes".

**Blocked by:** 01. The dependency on the first Arbitrum One broadcast was **removed by the
maintainer on 2026-09-10**: the release now comes first and that write is made with the released
package. See `ADR-0018`.

**Status:** done, 2026-09-10 — `package.json`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `ADR-0018`

- [~] ~~The first Arbitrum One write has happened~~ — **overturned, not skipped.** The maintainer's
      call: the testnet lifecycle already exercised this exact shape, and a Beta write spends real
      ETH and draws real jurors, so it is worth making once, against the published package. The
      tallies are still re-read from the chain at HEAD rather than carried from a note — and the
      two are **not the same kind of number**, which the first cut of this commit got wrong in four
      places. Arbitrum Sepolia **3** is a nonce, all three this tool's. Arbitrum One **0** is a
      count, because that key's nonce there is **12** and none of them are ours; it carries the 12
      with it in `README.md`, `CLAUDE.md`, `CHANGELOG.md` and `ADR-0018`. Releasing changes neither.
      `ADR-0018` records the reordering and what it costs.
- [x] `version` is `0.1.0`.
- [x] `README.md` documents installing from npm — `npm i -g @kleros/kleros-disputant-cli`, and the
      binary is `kleros-disputant`. The source path stays for contributors, but it stops being the
      only path, and the SSH `git clone` is not what a stranger arriving from the registry is asked
      to run first.
- [x] The library import example (`import { … } from "@kleros/kleros-disputant-cli"`) becomes
      reachable: it is correct at `0.1.0` and today has no documented way to obtain the package.
- [x] Every "nothing is published to npm" claim is gone — `README.md` ×2 and `CHANGELOG.md`.
      `CLAUDE.md`'s status line goes with them.
- [x] The `status-pre--release` badge and the "Pre-release." opener say what is actually true: a
      published `0.1.0` on the `latest` tag is pre-1.0, not a prerelease in npm's sense. The safety
      warning at the foot of the README — that this holds a key and spends real ETH — **stays**, and
      is not what this criterion is about.
- [x] `CHANGELOG.md` gains a real `0.1.0` entry, and the rationale for staying unpublished is
      retired in it explicitly, naming what changed: `docs/spec/` is normative and the payload
      builders are pinned by vectors, so the surface that publication freezes is now specified.
- [~] The Roadmap item is **rewritten and stays open**, not checked — the reordering is what
      changed, and the Beta write itself has not happened. It now reads as the write alone, made
      with the released package, and points at `ADR-0018` for why it follows the release. The
      Roadmap still names nothing the Status table lists.
- [x] `pnpm publish --dry-run` is clean and the tarball is inspected before the real one. The suite
      cannot broadcast from `prepublishOnly` — `npm_lifecycle_event` is `test` there, not
      `test:acceptance` — and that stays true after any script change in this ticket.
