# Evidence is opaque, operator-supplied bytes

`kleros-juror-cli`'s strongest invariant is structural rather than procedural:

> **Evidence never enters this process.** Everything an agent reads from a dispute is authored by
> parties with an interest in the outcome. The separation is structural, not procedural:
> attacker-authored text has no path to the signing key because this tool never reads any.

That formulation cannot survive the role change. For a party to a dispute, **submitting evidence is
the product**, so content necessarily passes through the process. The invariant does not vanish; it
restates, narrower, and the restatement has to be written down rather than assumed — which is what
this record is for.

## The restatement

> The CLI writes **operator-supplied** content and never reads, fetches, or interprets counterparty
> content. It does not dereference a URI found in on-chain data. Evidence is opaque bytes on the
> way to a transaction: never parsed, never interpolated into anything executable, never allowed to
> influence which call is made or with what arguments.

The property that makes this hold is **self-authorship**. The juror invariant relies on the text
being absent; this one relies on the text being the operator's own. Adversary-authored bytes still
have no path to the signing key, because none are ever read.

## What "never parsed" allows and forbids

It does not forbid every touch. Three operations are legitimate:

- **Serialising** the operator's `name` / `description` / `fileURI` into the evidence JSON.
- **Validating** it against the strict authoring schema (ADR-0010) — a check on the operator's own
  input, whose only outcome is accept or refuse.
- **Measuring** it: byte length, so calldata size can be reported.

What is forbidden is anything where the *content* selects behaviour:

- Reading an existing evidence event, a dispute template, or a policy document from chain or IPFS
  and doing anything with the result beyond passing it through unread.
- Dereferencing a URI that came from on-chain data. `policyURI`, `--template-uri` and `--file-uri`
  are inputs the operator supplies; the tool records them and never fetches them. It cannot tell a
  benign CID from a hostile one and must not try.
- Deriving *any* argument — the court, the juror count, the dispute kit, the ruling-option count,
  the target contract — from text rather than from a flag. Every one of those is a separate
  argument precisely so that no string can reach it.
- Templating operator text into a shell command, a filesystem path, or a further prompt.

## The feature that would end it

"Read the other side's evidence and respond to it." It is the obvious next request, it is
genuinely useful, and it destroys the property outright — at that point adversary-authored text is
in the process, and everything downstream of it, including the decision to sign, is influenced by
someone with an interest in the outcome.

**Refuse it here.** It belongs upstream on the read plane, where `@kleros/agentkit` already has
`kleros evidence list` and `kleros dispute brief`, and where nothing holds a signing key. The
architectural separation between the read plane and the write plane is what makes that refusal
cheap rather than costly: the capability exists, it just does not exist *here*.

## Consequences

This is why the CLI takes `--template-uri` and `--file-uri` rather than pinning content itself
(ADR-0009): a pinning step would put an HTTP client and a credential in the same process as the
signing key, for content the tool has no need to look at. It is also why ADR-0004's residual —
"evidence that argues the wrong thing" — is explicitly out of scope: catching it requires reading
material this tool must not read.

The one thing this decision does *not* buy is protection from a compromised operator. If the agent
upstream is manipulated into authoring hostile text, this tool faithfully publishes it. That is
correct — it is a transcription tool — but it means the trust boundary sits at the agent, and the
agent's own prompt-injection posture is not this repo's to solve.
