# ADR-0018: The release precedes the first Arbitrum One write

**Status:** accepted, 2026-09-10
**Supersedes:** nothing. **Amends:** no ADR — it reverses an ordering that existed only as a
Roadmap line in [`README.md`](../../README.md) and as the axis the release effort was split along
in `.scratch/release-0.1.0/spec.md`. It is written down here rather than quietly edited out,
because a reader who remembers the old ordering is owed the reason it changed.

## Context

The repo's own Roadmap ordered the two remaining milestones: *"Fund the signing key on Arbitrum One
and make the first Beta write, then publish `0.1.0`."* The release effort took that ordering as
given and split along it — phase A everything publishable that needs no broadcast, phase B the
release commit — and ticket 02 was `blocked` on the write.

Measured on 2026-09-10, from the chain rather than from any note:

| Fact | Value |
| --- | --- |
| `create-dispute`, court 1 × 3 jurors, Arbitrum One | 0.015 ETH, quoted live |
| Signing key balance, Arbitrum One | 0.001683297127577 ETH |
| Signing key nonce, Arbitrum One | 12 — **none of them this tool's** |
| Signing key nonce, Arbitrum Sepolia | 3 — **all three this tool's** |

So the ordering was never blocked on engineering. It was blocked on funding an account and on
deciding to spend, which is a different kind of decision and belongs to a different person.

## Decision

**Publish `0.1.0` first, and make the first Arbitrum One write with the released package** —
installed from the registry, not run out of a working tree.

The reasoning is the maintainer's, and it is about what that write is *for*:

1. **Its shape is already exercised.** The full lifecycle — quote, simulate, create, submit
   evidence, status — has run against the live v2 testnet through the built binary, each command in
   its own process ([05 §3](../spec/05-verification.md)). Both write paths have also broadcast
   against an **Arbitrum One fork** ([05 §2](../spec/05-verification.md)). What differs between the
   two deployments is data — addresses, costs, period lengths — and a deployment is pinned rather
   than inferred ([ADR-0015](./0015-a-deployment-is-not-a-chain.md)), so the Beta write is the same
   call against a different row.
2. **It costs money and it draws real jurors.** An arbitration fee buys jurors; jurors are people,
   drawn onto whatever case was filed, who then have to coordinate around it. A shakedown dispute
   spends their attention as well as the creator's ETH, and the excess of an overpayment is never
   refunded either ([ADR-0004](./0004-broadcast-is-opt-in-no-human-gate.md)). That is not a cost
   engineering gets to accept on its own account, and it is emphatically not one to pay twice.
3. **So it should exercise the artifact a stranger actually gets.** A broadcast from a working tree
   proves the working tree. Paid for once, the run worth having is the one that also proves the
   published tarball: the `bin` shim, the bundled deployment artifacts, the `engines` floor, the
   envelope as it arrives from `npm i -g`.

The rehearsal requirement in [05 §3](../spec/05-verification.md) — that the acceptance suite runs
**before** the first Arbitrum One broadcast, so that broadcast is a confirmation rather than an
experiment — is unaffected. It has already been satisfied, and this decision does not touch it.

## What this costs

**`0.1.0` ships a write path that has never been broadcast to Arbitrum One.** That is the whole of
the cost, and it must be stated rather than absorbed: the README's Status says so in as many words,
and the Roadmap keeps the item. What *is* established on that deployment is the read layer, live;
the deployment fingerprint, on every run; and both write paths, on a fork of it. What is not
established there is anything only the live chain can settle — its real gas, its real fee at the
moment of sending, the behaviour of a court whose parameters nobody re-read that morning.

**A published version freezes a surface.** This was the old argument for staying unpublished, and it
is retired rather than forgotten: `docs/spec/` is normative and the payload builders are bound to
production by test vectors, so what publication freezes is now specified rather than implicit. A
`0.x` line also says plainly that the surface may still move.

**Two claims now have to survive publication, and they are not the same kind of number.** The v2
testnet tally is a nonce: 3, read off Arbitrum Sepolia, never a count kept by hand. The Arbitrum One
tally is **0 by this tool**, and there the nonce is 12 — so it is a count, and it is wrong to
present it as a nonce or to state it without that denominator. The table above is where the two are
reconciled; every other place the 0 appears carries the 12 with it. Releasing changes neither
number, and no sentence in the release says the first Beta write has happened, because it has not.
