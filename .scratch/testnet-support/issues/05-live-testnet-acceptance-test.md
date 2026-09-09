# 05: Live testnet acceptance test

**What to build:** A full lifecycle — quote, plan, create, submit evidence, report status — run
against the **live** v2 testnet through the built binary, in separate processes. This is the
rehearsal the tool has never had: the first time the envelope, the signing path, the endpoint and the
receipt are exercised together against real infrastructure. It runs before the first Arbitrum One
broadcast, so that broadcast is a confirmation rather than an experiment.

**Blocked by:** 02, 04.

**Status:** ready-for-agent

- [ ] The command that currently points at a file which does not exist runs a suite that does.
- [ ] The lifecycle runs through the built binary in separate processes, against the live v2 testnet.
- [ ] Assertions are **relational**, not pinned, because a live deployment has no fixed block and no
      fixed cost: the cost reported in the envelope equals the cost quoted immediately before it; the
      reported core dispute ID resolves on chain; the emitted evidence log carries the exact bytes
      submitted; the local dispute ID the tool resolved matches the mapping read back from the chain
      — read from the emitted `Evidence` log, **not** from the envelope, which deliberately never
      carries it (`ADR-0014`, `spec/05 §1.6a`);
      and the dispute reports the expected period.
- [ ] The two existing assertions are kept verbatim: that no secret reached either output stream, and
      that nothing was written to disk. They are why it runs in separate processes.
- [ ] It skips **loudly** when no funded testnet key is present, in the manner this repo already uses
      for a suite whose prerequisite is absent.
- [ ] It is a release gate, not a CI job. Nothing in continuous integration depends on a funded key or
      on testnet availability.
- [ ] Each run broadcasts permanently and creates real testnet disputes. This is stated where someone
      deciding whether to run it will read it.
- [ ] The existing fork suite is untouched beyond ticket 02's one assertion change (`spec/05 §2.7`). Two of its tests seed state Arbitrum One cannot provide,
      and though the testnet now supplies one of them natively, they remain the only deterministic
      proof and testnet state can change underneath us.
