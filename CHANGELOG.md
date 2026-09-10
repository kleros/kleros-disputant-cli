# Changelog

Notable changes to `kleros-disputant-cli`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [Unreleased]

Not yet published to npm. What remains before `0.1.0` is tracked in
`.scratch/release-0.1.0/`: the first write to Arbitrum One, which the README's Roadmap orders ahead
of the release, and then the release commit itself.

This section used to argue that staying unpublished was *deliberate* — that a published version
would make any change to how evidence payloads or dispute templates are constructed breaking for
installs beyond one machine. **That reasoning is retired rather than deleted**, because it was a
real decision and someone may look for it: `docs/spec/` is now normative and the payload builders
are pinned by test vectors, so the surface that publication freezes is specified rather than
implicit. The release entry will say so again in its own words.
