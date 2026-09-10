# The first npm release

## What this is

`@kleros/kleros-disputant-cli` has never been published. This effort makes the package publishable
and makes every reader-facing claim survive the act of publishing.

**The ordering is the repo's own**, from `README.md`'s Roadmap: *"First broadcast against Arbitrum
One, then the first npm release."* Nothing here changes that. The work splits along it:

- **Phase A — publishable, and true today.** Packaging that carries no claim about being released,
  plus the claims that are already stale or misleading at HEAD. Needs no funding and no broadcast.
- **Phase B — the release commit.** Everything whose truth changes at the moment of publication:
  the version, the CHANGELOG entry, and every sentence that says nothing is on npm. It lands after
  the first Arbitrum One write, with the tallies rewritten to what is then true.

Doing Phase A early is what keeps Phase B a small, checkable diff instead of a rewrite performed
under release pressure.

## What makes this more than a version bump

**`README.md` and `skills/kleros-disputant/SKILL.md` ship inside the tarball** — `package.json`'s
`files` array carries them. The README *is* the npm registry page. So a sentence like
`Nothing is published to npm yet` is not a stale note in a repo; it is the first line a stranger
reads on the package's own listing, refuting itself.

The same applies to the install instructions. The only documented path is
`git clone git@github.com:…` over SSH, which fails for precisely the reader who arrived from npm
without a GitHub key, and `pnpm dev …` appears as a usage form that requires a working tree.
`SKILL.md` defers installation to the README, so a stranger who installed the skill is routed to a
clone. The `bin` is correct and `npm i -g` would work — no document says so.

## Measured, 2026-09-10

| Fact | Value |
| --- | --- |
| `package.json` version | `0.0.0` |
| `publishConfig` | **absent** — a scoped package does not publish without `access: "public"` |
| Tarball | 12 files, 268.6 kB packed, 3.4 MB unpacked; `dist/chunk-*.js.map` alone is 1.9 MB |
| `LICENSE`, `CHANGELOG.md` | both present; only `LICENSE` is in `files` |
| Open tickets elsewhere | none — every ticket in `.scratch/` is done |
| Broadcasts, v2 testnet | **3** (signing key's nonce on Arbitrum Sepolia) |
| Broadcasts, Arbitrum One | **0 by this tool** (key's nonce there is 12, none of them ours) |
| `create-dispute`, court 1 × 3 jurors, Arbitrum One | **0.015 ETH**, quoted live |
| Key balance, Arbitrum One | 0.00168 ETH — **not funded** for a Beta dispute |

**Publishing cannot arm the broadcast suite**, and that was checked rather than assumed:
`prepublishOnly` runs `pnpm test`, which sets `npm_lifecycle_event=test`, while the acceptance
suite opts in only on `test:acceptance`.

## The rationale being retired

`CHANGELOG.md` currently argues the package is unpublished *on purpose*:

> Nothing published yet. The package is unreleased on npm on purpose: a published version makes any
> change to how evidence payloads or dispute templates are constructed breaking for installs beyond
> one machine.

That predates `docs/spec/` being normative and the payload builders being pinned by vectors. It is a
written decision, so Phase B retires it deliberately rather than letting a version bump overtake it
in silence.
