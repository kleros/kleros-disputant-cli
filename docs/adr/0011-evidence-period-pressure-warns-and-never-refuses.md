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

## The one hard refusal

**A core dispute ID that does not exist.** That is not a policy judgement, it is a correctness
failure with a silent mode: the subgraph does `Dispute.load(coreDisputeID.toString())` and **drops
the evidence on the floor** when there is no such dispute. The transaction succeeds, gas is spent,
an event is emitted, and the evidence is invisible in Court and to every indexer.

The likely cause is passing an arbitrable-local dispute ID where the core ID belongs — the exact
collision `CONTEXT.md` gives three separate glossary entries to. So this refusal earns its place:
it is chain-detectable, its failure mode is silent, and the mistake it catches is one the domain
actively invites. Its message should name the confusion rather than only reporting the miss.

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
