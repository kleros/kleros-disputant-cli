# Evidence-period pressure warns, and never refuses

`kleros-juror-cli` refuses to act outside the correct period, and is right to: `castCommit` and
`castVote` revert outside theirs, so the refusal is a local restatement of a contract rule and
produces a named error instead of a decoded revert.

`EvidenceModule.submitEvidence` has **no access control, no payment and no period gate**. Nothing
on chain stops evidence being submitted at any time, by any address, for any existing dispute. So
any period discipline here would be this CLI's own policy invented on the contract's behalf.

The decision: **read the period, warn, and never refuse.**

## Why not refuse by default

Because it would be a false guarantee, and the CLI would be the only thing asserting it. A caller
who sees `submit-evidence` refuse learns "the contract will not accept this", which is untrue — the
transaction would succeed. Meanwhile evidence submitted late is not worthless: it is on chain, it
is indexed, it is visible to an appeal round that re-draws the panel, and whether it is worth
submitting is a case-construction judgement that lives upstream (ADR-0001).

This is the same mistake as a client-side check on *who* may submit. The absence of access control
is a real property of the contract; a party check presented as a guarantee would misrepresent it.
The tool reports what the chain says and lets the caller decide.

And the escape hatch a default refusal needs makes it worse rather than better. `--force` on an
autonomous agent's command line is set once and never reconsidered — it converts a refusal into a
constant, so the check protects nobody and the false guarantee remains in the documentation.

## The hard refusals

**A core dispute ID that does not exist.** That is not a policy judgement, it is a correctness
failure with a silent mode: the transaction succeeds, gas is spent, an event is emitted, and the
evidence is attached to nothing anyone will read.

**The harm is unreachability, not loss** — and this ADR originally said otherwise. It claimed the
subgraph does `Dispute.load(coreDisputeID.toString())` and drops such evidence on the floor. It
does not: `subgraph/core/src/EvidenceModule.ts` calls `ensureClassicEvidenceGroup`, which
**creates** the grouping entity when it is missing, so the evidence is indexed — under an ID no
dispute references and no case page queries. The refusal survives the correction unchanged; only
its reason moved. The error message **MUST NOT** claim the chain would reject the submission,
because that is false and an agent may act on it. `spec/02 §4.2`, `spec/appendix-a §3.3`.

The likely cause is passing an arbitrable-local dispute ID where the core ID belongs — the exact
collision `CONTEXT.md` gives three separate glossary entries to. So this refusal earns its place:
it is chain-detectable, its failure mode is silent, and the mistake it catches is one the domain
actively invites. Its message should name the confusion rather than only reporting the miss.

**A dispute another arbitrable created**, added 2026-09-09 as `DISPUTE_NOT_ADDRESSABLE`
([ADR-0014](./0014-evidence-is-filed-under-the-local-dispute-id.md)). The policy above is unchanged
in substance: its exception has always been unreachability, and this is that case reached by a
second route. Evidence is grouped by the arbitrable's own dispute ID, only that arbitrable can say
what a given dispute's is, and so a submission from here would again be filed where nothing reads
it. It is a **separate code** from the one above, because a not-found ID may be a typo worth
retrying and this one can never work.

Unlike the first, this one lives on the **write path** rather than in the read layer. `status`
shares that read and reports a foreign dispute perfectly well; only a command that signs needs a
local dispute ID, so only a command that signs refuses without one. The Consequences below still
hold — this adds no round trip, because both reads it needs were already in the first multicall —
but their inventory of the pre-flight is now: chain assertion, dispute existence, **the arbitrable
and the core-to-local resolution**, balance for gas, and an advisory period read.

## What the warning says

A `warnings[]` entry on the success payload, alongside the version-mismatch and deadline-proximity
advisories. It carries the current period and, where the dispute is past `evidence`, says so in
words — including that the submission will still succeed, so the caller does not read a warning as
a failure. Deadline arithmetic uses **chain time** (`getBlock().timestamp`), never `Date.now()`.

## Consequences

`create-dispute` has no period dimension at all — dispute creation is untimed, and the urgency
rhetoric the juror CLI carries around 30-to-45-minute vote windows does not transfer. The fail-fast
discipline stays for evidence; the urgency does not.

The pre-flight for `submit-evidence` is therefore unusually thin: chain assertion, dispute
existence, balance for gas, and a period read whose only output is advisory. Resisting the
temptation to add more is the decision.
