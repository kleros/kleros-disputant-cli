# 02: The release commit

**What to build:** Phase B. The single commit that publishes `0.1.0`, containing every change whose
truth turns over at that moment and nothing else — so the diff can be read as "these are the claims
publication changes".

**Blocked by:** 01, and the first Arbitrum One broadcast. The Roadmap orders the Beta write ahead of
the release, and this ticket does not reorder it.

**Status:** blocked

- [ ] The first Arbitrum One write has happened, and the tallies in `README.md` and `CLAUDE.md` are
      rewritten from **the signing key's nonce on each deployment**, never from session narrative.
      The testnet count is 3 today; the Arbitrum One count is 0 by this tool against a key whose nonce
      there is 12 for unrelated reasons, so the denominator has to be stated or the number misleads.
- [ ] `version` is `0.1.0`.
- [ ] `README.md` documents installing from npm — `npm i -g @kleros/kleros-disputant-cli`, and the
      binary is `kleros-disputant`. The source path stays for contributors, but it stops being the
      only path, and the SSH `git clone` is not what a stranger arriving from the registry is asked
      to run first.
- [ ] The library import example (`import { … } from "@kleros/kleros-disputant-cli"`) becomes
      reachable: it is correct at `0.1.0` and today has no documented way to obtain the package.
- [ ] Every "nothing is published to npm" claim is gone — `README.md` ×2 and `CHANGELOG.md`.
      `CLAUDE.md`'s status line goes with them.
- [ ] The `status-pre--release` badge and the "Pre-release." opener say what is actually true: a
      published `0.1.0` on the `latest` tag is pre-1.0, not a prerelease in npm's sense. The safety
      warning at the foot of the README — that this holds a key and spends real ETH — **stays**, and
      is not what this criterion is about.
- [ ] `CHANGELOG.md` gains a real `0.1.0` entry, and the rationale for staying unpublished is
      retired in it explicitly, naming what changed: `docs/spec/` is normative and the payload
      builders are pinned by vectors, so the surface that publication freezes is now specified.
- [ ] The Roadmap's `- [ ] First broadcast against Arbitrum One, then the first npm release` is
      checked, and the Roadmap still names nothing the Status table lists.
- [ ] `pnpm publish --dry-run` is clean and the tarball is inspected before the real one. The suite
      cannot broadcast from `prepublishOnly` — `npm_lifecycle_event` is `test` there, not
      `test:acceptance` — and that stays true after any script change in this ticket.
