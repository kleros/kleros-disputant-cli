# Kleros disputant CLI

The language of creating a Kleros v2 dispute and submitting evidence on Arbitrum One. This tool
turns a case that has already been built into a transaction; it does not build the case.

The word *disputant* names this tool's user, not a protocol role. **Kleros v2 has no claimant,
plaintiff or defendant** — a dispute is created by whoever pays for it, and the arbitrable decides
what its parties are called. Where a party must be named, say *the party creating the dispute*, or
use the arbitrable's own pair (requester / challenger in Curate, buyer / seller in Escrow).

## Language

### The scope boundary

**Filing**:
Turning an already-built case into an on-chain `createDisputeForTemplate` or `submitEvidence`. The
whole of this tool's job.
_Avoid_: suing, litigating, prosecuting (all import an adversarial-procedure model Kleros lacks)

**Case construction**:
Deciding whether a claim is worth bringing, drafting the evidence text, choosing the court and
writing the ruling options. Happens upstream, outside this repo, and its output reaches this tool
only as `--court`, `--evidence`, `--template` and the ruling-option arguments.
_Avoid_: analysis, judging, reasoning, case preparation

**Discovery**:
Finding which disputes an address is a party to, what state they are in, which arbitrable is
involved, and what the other side has already filed. Supplied upstream by `@kleros/agentkit`
(`kleros dispute brief`, `dispute get`, `arbitrable classify`, `evidence list`); never performed
here. The one exception is a read that could change the decision to sign, which is pre-flight, not
discovery.
_Avoid_: monitoring, polling, research

### The claim

**Dispute template**:
The JSON document describing what jurors are being asked, in the schema `DisputeDetailsSchema`
governs: `title`, `description`, `question`, `answers`, `policyURI`, `arbitratorChainID`,
`arbitratorAddress` and `version` required. On the `createDisputeForTemplate` path it travels
**inline in calldata**, not as a URI.
_Avoid_: MetaEvidence (the v1 term for this; v2 renamed it), meta evidence, dispute metadata

**Template ID**:
The index `DisputeTemplateRegistry` assigns a template when it is registered. Not a dispute ID and
not in step with one: 227 templates exist against 216 disputes. Reported in the
`DisputeTemplate` and `DisputeRequest` events. This tool never supplies one — it emits a template
body and the registry allocates the ID.
_Avoid_: template hash, template CID (the inline path has neither)

**Data mappings**:
The optional script that resolves a template's placeholders against live arbitrable state at
*display* time. Sent as `""` for a static template, which is every template this tool emits.
_Avoid_: template variables, interpolation

**Ruling option**:
One of the answers offered to jurors, counted by `_numberOfRulingOptions` and listed in the
template's `answers` array with IDs from `0x1` up. **`0x0` is always reserved for "Refuse to
Arbitrate" and is never in the array you submit**, so the count and the array length agree. A juror
calls the same thing a *choice*; on the disputant side it is what you author rather than what you
pick.
_Avoid_: verdict, outcome, option (unqualified)

**Ruling**:
The arbitrator's *output*: the winning ruling option `KlerosCore` reports through `currentRuling`,
the `Ruling` event, and `IArbitrableV2.rule`. It is what a disputant eventually receives, and this
tool never produces one — filing is the start of the pipeline, not the end of it.
_Avoid_: verdict, judgment, decision, sentence

**Evidence**:
A JSON document `{ name, description, fileURI?, fileTypeExtension? }` passed **inline** to
`EvidenceModule.submitEvidence`, emitted in an event and never stored on chain. The field is
`name`; the published docs page saying `title` is wrong and a `title`-keyed document indexes with a
null name. A bare `/ipfs/…` string in place of the JSON parse-fails in the subgraph.
_Avoid_: title (as the field name), exhibit, attachment (that is `fileURI`), submission

**Policy**:
The court's or the arbitrable's rules document, referenced by the template's `policyURI` as a
multiaddr (`/ipfs/…`) — a plain `https://` URL fails the schema's refinement. Required by the
schema, **not** enforced by the contract: a dispute without one is created successfully and jurors
are still drawn, it merely renders degraded in Court.
_Avoid_: terms, rules, guidelines

**Arbitration cost**:
What `KlerosCore.arbitrationCost(extraData)` quotes and what `createDisputeForTemplate` must be
sent as `msg.value`. Forwarded wholesale to the arbitrator, which derives the juror count from the
amount. That overpaying therefore buys extra jurors rather than returning change is **inferred
from `master` source and not verified against the deployed code** — so send exactly the quote,
and do not rely on a refund either way.
_Avoid_: jurors' fee, arbitration fee, gas (it is neither gas nor a fee this tool sets)

**Arbitrator extra data**:
The `_arbitratorExtraData` blob: court ID, juror count and dispute kit ID as three `uint256`
words. Chooses where the dispute lands. **96 bytes for Classic and Shutter only** — Gated and
GatedShutter concatenate a further 64 bytes of kit data, so "always 96" is a property of the kits
this tool starts with, not of the format. Malformed or out-of-range values **do not revert** — the
decoder substitutes defaults — so it is validated locally before it is sent, never by simulation.
_Avoid_: extraData (unqualified — the ambiguity is the trap; dispute kits take their own kit data)

### The chain

**Arbitrator**:
`KlerosCore`, the contract that quotes the arbitration cost, holds disputes, draws jurors and
delivers the ruling. One deployment per chain.
_Avoid_: court (a court is one of its subdivisions), Kleros (unqualified)

**Arbitrable**:
The contract that asks for a ruling and receives `rule()`. For this tool it is always
`DisputeResolver`, the generic permissionless arbitrable — because an EOA **cannot** call
`KlerosCore.createDispute` directly: the deployed core enforces `arbitrableWhitelist`
unconditionally and reverts with `ArbitrableNotWhitelisted()`. The v2 `DisputeResolver` *contract*
is unrelated to the v1 "Dispute Resolver" dapp and to `ArbitrableProxy`; always qualify which one
you mean.
_Avoid_: ArbitrableProxy, the Dispute Resolver dapp, dapp, integration

**Core dispute ID**:
The global dispute identifier in `KlerosCore.disputes[]`, reported by the `DisputeCreation` event.
**This is the ID `submitEvidence` takes as its first argument** — pass an arbitrable-local ID
instead and the evidence lands on chain, is indexed under an ID nothing references, and is
invisible in Court. It is not dropped; it is unreachable. `spec/02 §4.2`
_Avoid_: dispute ID (unqualified — the ambiguity is the trap)

**Local dispute ID**:
The arbitrable's own index for a dispute, in its internal array. `arbitratorDisputeIDToLocalID`
maps core → local. Needed only to read arbitrable-side state; it is never what `--dispute` takes.
_Avoid_: dispute ID (unqualified), internal ID, resolver ID

**Evidence group ID**:
The Kleros v1 name for the argument `submitEvidence` takes. It existed to correlate evidence
submitted **before** a dispute was created, when there is no dispute ID yet to key on. That case
proved unnecessary and the field was **removed in the devnet deployment**; beta and testnet still
inherit it, which is why the Arbitrum One ABI still names the parameter `_externalDisputeID` while
devnet names it `_arbitratorDisputeID`. It is a legacy name for a number this tool already has, not
a fourth identifier — the CLI never exposes it. `spec/01 §7.1`
_Avoid_: evidence group (as a live concept), evidenceGroupID in the CLI surface

**External dispute ID**:
The third field of `DisputeResolver`'s `DisputeRequest` event, and what the Kleros Court web
client resolves evidence by. **Whether it is the local index or the arbitrator dispute ID is not
verified** — all 216 logs have them equal, because this resolver created *every* dispute that
exists on the deployment. The coincidence is total, so no test against production can distinguish
the three IDs. Do not build on the distinction until it is confirmed against the deployed source.
`spec/01 §7`
_Avoid_: dispute ID (unqualified), foreign ID

**Court**:
One of KlerosCore's subdivisions, IDs 1–34 on Arbitrum One, each with its own fee, juror count and
period lengths. Selected through `extraData`. **Court 0 is never a valid target**: the decoder
maps it to the General Court alongside any out-of-range ID, and it reads back all-zero.
_Avoid_: subcourt (the v1 name), tribunal, chamber

**Dispute kit**:
The pluggable contract implementing a voting method, chosen through `extraData`. Classic is the
realistic target: `isSupported(1, 2)` and `isSupported(1, 3)` are both false, so the General Court
supports only Classic here, contradicting the published docs. `DisputeResolverRuler` and
`KlerosCoreRuler` are governance override tools and are refused by name.
_Avoid_: DK, voting module

**Dispute kit ID**:
The index KlerosCore registers a kit under, in `disputeKits[]` — 1 Classic, 2 Shutter, 3 Gated,
4 GatedShutter. The third word of `extraData`. It identifies the kit contract, not a dispute, and
is unrelated to any of the three dispute IDs.
_Avoid_: kit index, DK ID

**Round index**:
The zero-based index of an appeal round within a dispute. An appeal re-draws the panel and raises
the stake, so which round a dispute is in is part of what a disputant is tracking.

**Period**:
One of `evidence`, `commit`, `vote`, `appeal`, `execution`. `submitEvidence` is **not gated on the
evidence period** — there is no on-chain check at all — so a period objection from this tool is
advice, never a refusal.
_Avoid_: phase, stage

**Deadline**:
`lastPeriodChange + timesPerPeriod[period]`. An upper bound, never an entitlement — a period can
end early and `passPeriod` is permissionless. Computed from **chain time**
(`getBlock().timestamp`), never `Date.now()`.
_Avoid_: expiry, cutoff

**Juror**:
The address drawn to vote on a dispute. Context here rather than subject: this tool never acts as
one, and **the disputant must not be a juror in the same dispute**. That is not cheaply detectable
on chain, so it is an operator responsibility and not a guarantee this tool makes.
_Avoid_: voter, operator, agent

**Neo**:
The name of the Arbitrum One production deployment, as in `DisputeKitClassicNeo`. A deployment
name, not a contract.
