# 01: Make the package publishable, and the claims true at HEAD

**What to build:** Phase A. Everything that makes `pnpm publish` mechanically possible and every
reader-facing claim that is already stale or misleading — with no sentence added that only becomes
true once the package is on npm. After this ticket the repo is publishable and honest; it is not
published.

**Blocked by:** None.

**Status:** done, 2026-09-10 — `publishConfig`, `tsup.config.ts`, `README.md`, `SKILL.md`, `CHANGELOG.md`

- [x] `publishConfig: { access: "public" }` is set. `@kleros/…` is scoped, and a scoped package
      defaults to restricted: without this the first `pnpm publish` fails outright rather than
      publishing something wrong. This carries no claim about having been released, which is why it
      belongs in Phase A.
- [x] The source maps are decided rather than left to the bundler default, and the decision is
      recorded where the bundler is configured. `dist/chunk-*.js.map` is 1.9 MB of a 3.4 MB unpacked
      package — but 268.6 kB packed is small, and this tool spends real money on an irreversible
      action, so a legible stack trace from a stranger's bug report is worth more than the bytes.
      **Keep them**; the point of the criterion is that the next reader finds a decision, not a
      default.
- [x] The census claims are bounded by when they were measured. `SKILL.md`'s "every dispute on this
      deployment routes through the same arbitrable" and "Every court supports kit 1 … where that was
      measured" are claims over a live deployment, asserted with "today", shipped to strangers in the
      tarball. They stay — they are load-bearing — but each names the date it was measured, so a
      reader can see its age.
- [x] The run artifacts read as artifacts. "core dispute 128 … local dispute 78" is the record of one
      run of a suite that creates a **new** dispute every time; it is evidence the lifecycle ran, not
      a fact about the testnet. Say which.
- [x] `--dispute 215` is labelled an example wherever it appears (`README.md` ×3, `SKILL.md` ×2).
      Nothing currently marks it, and a stranger may read it as a live Arbitrum One dispute and go
      looking.
- [x] `SKILL.md`'s `version: 1.1.0` frontmatter is explained or aligned. On the npm page for
      `0.1.0`, a bundled file declaring `1.1.0` has no visible relationship to the package version.
      One sentence naming it as the skill's own line is enough; renumbering it is not required.
- [x] The Status prose stops duplicating the Roadmap. `CLAUDE.md`'s rule is that the README's Roadmap
      names nothing its Status table lists — the **table** honours it, but the Status *prose* asserts
      the acceptance test and the "no Arbitrum One broadcast / nothing on npm" pair that the Roadmap
      also carries, so publishing falsifies two copies of each. One home per fact; the other points
      at it.
- [x] `CHANGELOG.md`'s `[Unreleased]` section stops arguing that being unpublished is deliberate and
      instead records what is pending, with the retirement of that rationale noted rather than
      deleted. The full entry is Phase B's; this is the removal of a claim that is no longer the
      project's position.
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm build` stay clean, and `npm pack
      --dry-run` still lists `LICENSE`, `README.md`, `SKILL.md` and `dist/`.
- [x] **No sentence is added that is false until publication.** No `npm i -g` instruction, no version
      bump, no flipping of "nothing is published to npm". Those are ticket 02, and they are false
      today.
