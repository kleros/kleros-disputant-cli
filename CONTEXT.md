# Kleros disputant CLI

The language of creating a Kleros v2 dispute and submitting evidence on the Kleros v2 deployments
this tool serves — v2 Beta on Arbitrum One, and the v2 testnet on Arbitrum Sepolia. This tool
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
here. The exceptions are pre-flight, not discovery: a read that could change the decision to sign,
and the single read that decides *what* is signed — resolving the core dispute ID to the local one,
because the alternative is a write that cannot be read back (`ADR-0014`).
_Avoid_: monitoring, polling, research

### The claim

**Dispute template**:
The JSON document describing what jurors are being asked, in the schema `DisputeDetailsSchema`
governs: `title`, `description`, `question`, `answers`, `policyURI`, `arbitratorChainID`,
`arbitratorAddress` and `version` required. The two arbitrator fields are required in the *emitted*
document but not of an *author*: omitted, they are derived from the selected deployment; stated
wrongly, the template is refused and no dispute is created. On the `createDisputeForTemplate` path it travels
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
_Avoid_: title (as the field name), exhibit, attachment (the evidence is the *document*; the
attachment is only what `fileURI` points at — see **Attachment**), submission

**Attachment**:
The one file an evidence document may point at, through its `fileURI`. It is *not* the evidence —
the evidence is the JSON document, and calling that an attachment is the confusion this entry
exists to prevent. Produced by `upload-file`, which is the only command in this tool that speaks
HTTP; supplying an already-pinned URI by hand remains supported.
_Avoid_: exhibit, document (that is the evidence), file (unqualified — a key file and a template
file are also files)

**Pinning**:
Uploading bytes to a service that keeps them retrievable by CID. In scope since 2026-09-09, in
exactly one place: `upload-file`, which never signs, never reads the chain and never loads a key.
No command that signs pins anything, and the tool still never *dereferences* a URI it was handed.
`ADR-0012` reversed `ADR-0009` on this and explains what survived.
_Avoid_: uploading to IPFS (imprecise — the CLI posts to one endpoint, which pins), storing,
hosting, saving

**fileURI**:
The `/ipfs/<cid>` multiaddr naming an attachment, and what `upload-file` prints. Content-addressed
and nothing more: identical bytes produce an identical CID under any filename, so re-uploading is
idempotent and free. Unlike `policyURI` it is not held to the schema's multiaddr refinement — it
is an operator input the contract never reads.
_Avoid_: link, URL (a plain `https://` URL is the thing `policyURI` refuses), hash, IPFS address

**Policy**:
The court's or the arbitrable's rules document, referenced by the template's `policyURI` as a
multiaddr (`/ipfs/…`) — a plain `https://` URL fails the schema's refinement. Required by the
schema, **not** enforced by the contract: a dispute without one is created successfully and jurors
are still drawn, it merely renders degraded in Court.
_Avoid_: terms, rules, guidelines

**Arbitration cost**:
What `KlerosCore.arbitrationCost(extraData)` quotes and what `createDisputeForTemplate` must be
sent as `msg.value`. Forwarded wholesale to the arbitrator, which derives the juror count from the
amount. **Overpaying buys extra jurors and is never refunded** — verified on a fork, where twice
the quote drew six jurors instead of three and returned nothing. Send exactly the quote.
_Avoid_: jurors' fee, arbitration fee, gas (it is neither gas nor a fee this tool sets)

**Arbitrator extra data**:
The `_arbitratorExtraData` blob: court ID, juror count and dispute kit ID as three `uint256`
words. Chooses where the dispute lands. **96 bytes for Classic and Shutter only** — Gated and
GatedShutter concatenate a further 64 bytes of kit data, so "always 96" is a property of the kits
this tool starts with, not of the format. Malformed or out-of-range values **do not revert** — the
decoder substitutes defaults — so it is validated locally before it is sent, never by simulation.
_Avoid_: extraData (unqualified — the ambiguity is the trap; dispute kits take their own kit data)

### The chain

**Deployment**:
One address set of the Kleros v2 contracts — its own arbitrator, dispute resolver, template
registry and dispute kits, with its own ABIs, which are **not** interchangeable between deployments.
A chain may host several: chain 421614 carries the v2 testnet, the v2 devnet and the university
deployment, so **a chain ID does not name a deployment**. Named by a slug at every machine boundary
(`arbitrum-one`, `arbitrum-sepolia-testnet`) and by its prose name in documentation ("v2 Beta",
"v2 testnet"). `--chain` (alias `-c`) keeps the sibling CLI's flag name and selects one of these,
defaulting to `arbitrum-one`. Two are served; a slug that is not one of them is refused before
anything is contacted.
_Avoid_: network, environment, instance; *chain* as a synonym for it (a chain hosts deployments —
the flag is named for the one and selects the other); *mainnet* (the contracts package's own key for
Arbitrum One, confined to the deployment module — to an agent that also reads `@kleros/agentkit`,
mainnet is Ethereum)

**Arbitrator**:
`KlerosCore`, the contract that quotes the arbitration cost, holds disputes, draws jurors and
delivers the ruling. **One per deployment** — not one per chain, which is a different count.
_Avoid_: court (a court is one of its subdivisions), Kleros (unqualified)

**Arbitrable**:
The contract that asks for a ruling and receives `rule()`. For this tool it is always
`DisputeResolver`, the generic permissionless arbitrable, on **every** deployment — one write path,
one payload builder, one set of test vectors. That uniformity is what the routing decision rests on.
The arbitrable whitelist is how the constraint was *discovered*, not what holds it: on v2 Beta an
EOA cannot call `KlerosCore.createDispute` directly, because the deployed core enforces
`arbitrableWhitelist` unconditionally and reverts with `ArbitrableNotWhitelisted()` — but that is a
**property of that deployment**, not of Kleros v2. The same selector reverts bare on the v2 testnet,
where the function does not exist. `spec/01 §3.1`, `ADR-0015`
The v2 `DisputeResolver` *contract* is unrelated to the v1 "Dispute Resolver" dapp and to
`ArbitrableProxy`; always qualify which one you mean.
_Avoid_: ArbitrableProxy, the Dispute Resolver dapp, dapp, integration, owner (of these
contracts — on **both served deployments** they expose `governor()` and carry no `owner()`
selector; `ADR-0006`, `spec/01 §2`. The devnet's are the other way round, which is one more
reason it is not served — `spec/01 §7.1`. The word is still correct for a key)

**Core dispute ID**:
The global dispute identifier in `KlerosCore.disputes[]`, reported by the `DisputeCreation` event.
**This is the only dispute identifier the CLI's surface uses** — what `--dispute` takes and what
every envelope reports. It is *not* what reaches `submitEvidence`: the CLI resolves it to the local
dispute ID first, because that is what the evidence group is keyed by. Passing either number in the
wrong place puts evidence on chain under an ID nothing references, invisible in Court. It is not
dropped; it is unreachable. `spec/02 §4.2`, `ADR-0014`
_Avoid_: dispute ID (unqualified — the ambiguity is the trap)

**Local dispute ID**:
The arbitrable's own index for a dispute, in its internal array. `arbitratorDisputeIDToLocalID`
maps core → local, and returns the **zero default** for a dispute another arbitrable created — a
default, not a mapping, and indistinguishable from local dispute 0, which is a real dispute. So the
arbitrable is always checked first. **This is what `submitEvidence` receives**, and it is never what
`--dispute` takes and never appears in an envelope: the CLI resolves it, signs it, and does not
report it. `ADR-0014`
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
client resolves evidence by — for reading *and* for submitting. **It is the local dispute ID** —
verified on a fork seeded with a second arbitrable, where it read 220 against a core dispute ID of
224, and confirmed on the v2 testnet, where every evidence group's id lies in the local range and
none in the core-only range. On Arbitrum One all 216 logs have them equal, because this resolver
created *every* dispute that exists on the deployment, so no test against production can distinguish
the three IDs. The CLI never exposes this one. `spec/01 §7`, `ADR-0014`
_Avoid_: dispute ID (unqualified), foreign ID

**Court**:
One of KlerosCore's subdivisions, each with its own fee, juror count and period lengths. Selected
through `extraData`. **IDs 1–34 on v2 Beta**, counted there and nowhere else — every deployment has
its own set, which is why court existence is probed live rather than tabled. **Court 0 is never a
valid target**: the decoder maps it to the General Court alongside any out-of-range ID, and it reads
back all-zero.
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
Upstream's suffix for the Arbitrum One contract set, as in `DisputeKitClassicNeo`. A **technical
codename**: it names an artifact, not a contract and not a deployment anyone types. Its only place
is a code comment where an artifact name is the subject, and it reaches **no** CLI surface — the
slug is `arbitrum-one` and the prose name is "v2 Beta". Note that the *contracts package* does not
use the suffix: its `arbitrum` keys are the bare `KlerosCore`, `DisputeResolver`, so looking up
`KlerosCoreNeo` there finds nothing. `ADR-0015`
_Avoid_: Neo in help text, messages, envelopes, CTAs or `README.md`
