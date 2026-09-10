# Changelog

Notable changes to `kleros-disputant-cli`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-10

The first release. Everything below already existed in the repository; what changes at `0.1.0` is
that a stranger can obtain it.

### Added

- `npm i -g @kleros/kleros-disputant-cli` installs the `kleros-disputant` binary, and the
  framework-free core is importable from the same package. Until now the only documented way in was
  an SSH `git clone`, which fails for exactly the reader who arrives from the registry.

### Changed

- **The rationale for staying unpublished is retired.** This file used to argue that being
  unreleased was *deliberate*: a published version would make any change to how evidence payloads
  or dispute templates are constructed breaking for installs beyond one machine. That was a real
  decision, so it is retired in words rather than deleted. What changed under it is that
  `docs/spec/` is now normative and the payload builders are bound to production by test vectors —
  the surface publication freezes is specified rather than implicit, and a `0.x` line says the rest
  may still move.
- **The release now precedes the first Arbitrum One write**, reversing the ordering the README's
  Roadmap asserted. The write costs real ETH and draws real jurors onto whatever case is filed, so
  it is worth making once, with the package a stranger installs, rather than from a working tree —
  `docs/adr/0018-the-release-precedes-the-first-arbitrum-one-write.md`.

### Not in this release

- **No transaction has ever been broadcast to Arbitrum One by this tool.** Its live broadcasts are
  three, all on the v2 testnet, and that three is the signing key's nonce on Arbitrum Sepolia rather
  than a tally kept by hand. The Arbitrum One 0 is the other kind of number — a count, not a nonce:
  the same key's nonce there is 12, none of them this tool's, so the 0 travels with that denominator
  or it misleads. Releasing changes neither.
