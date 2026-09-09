# Evidence is filed under the local dispute ID, not the core one

Status: **accepted**, 2026-09-09. Amends [ADR-0001](./0001-standalone-repo-shaped-for-upstreaming.md)
on read scope and [ADR-0011](./0011-evidence-period-pressure-warns-and-never-refuses.md) with a
second hard refusal. Rewrites [02 §4.2](../spec/02-payload-construction.md) and settles the
**[client]** claim in [01 §7](../spec/01-onchain-reference.md).

**This is a defect on the deployment this tool already targets.** It surfaced while specifying v2
testnet support, and the temptation is to file it as testnet scope. It is not: the equality it
relied on is a property of Arbitrum One's *history*, not of its code, and it expires the first time
another arbitrable creates a dispute there.

## The problem

`submitEvidence(uint256 _externalDisputeID, string _evidence)` emits its first argument and does
nothing else with it. What that number *means* is decided entirely downstream, and downstream keys
on the **arbitrable's local dispute ID**:

- The subgraph's `handleEvidenceEvent` uses `event.params._externalDisputeID.toString()` as the
  `ClassicEvidenceGroup` id, verbatim, and `ensureClassicEvidenceGroup` **creates** that entity when
  it is missing. There is no `Dispute` lookup, no back-reference and no error path. An id nothing
  references becomes a silent orphan group.
- `Dispute.externalDisputeId` is decoded from `DisputeRequest`'s first non-indexed word, and
  `DisputeResolver` emits `localDisputeID` there.
- The Kleros Court client reads **and writes** that value: `useEvidences(dispute.externalDisputeId)`
  to list, and the same value as `args[0]` to submit.

This CLI passed the **core** dispute ID. On Arbitrum One that is invisible, because
`DisputeResolver` created every dispute in existence there and all three identifiers coincide.

## What was measured

**[live]** v2 testnet (Arbitrum Sepolia, chain 421614), block 306 980 776, direct `eth_call`:

| Measurement | Value |
| --- | --- |
| Core disputes | **127** (0..126); `disputes(127)` reverts |
| Created by `DisputeResolver` | **77**; the resolver holds local 0..76, bijectively |
| Created by another arbitrable | **50**, across 25 distinct addresses |
| First divergence | core **58** → local **33** |
| `arbitratorDisputeIDToLocalID` for a foreign dispute | **0**, for all 50 — never a nonzero |
| `arbitratorDisputeIDToLocalID(0)` | **0**, and core 0 *is* a real resolver dispute |

**[live]** The same testnet's subgraph settles what the chain alone cannot: of its **47** evidence
groups, **every id lies in the local range 4..76 and none in the core-only range 77..126.** Core
dispute 126 is local 76; group `76` holds 26 evidences and group `126` does not exist.

That is the whole argument. Evidence filed under a core ID above the local range is not filed
against the dispute — it is filed in a group the Court never queries.

## The decision

**Resolve the core dispute ID to the local one and submit the local one.** The caller still passes
the core dispute ID and is still answered in core dispute IDs; the second identifier is resolved,
used, and never surfaced. `--dispute` is unchanged.

**The arbitrable is checked before the mapping is trusted.** `arbitratorDisputeIDToLocalID` is a
public mapping getter: it returns the zero default for a key it has never seen rather than
reverting, so a foreign dispute resolves to local ID `0`. The measurement above shows why that is
not a theoretical worry — **local ID 0 is a real dispute.** Used alone, the mapping would file a
foreign dispute's evidence against the resolver's first case. So the read layer substitutes `null`
when `disputes().arbitrated` is not `DisputeResolver`, and the zero default never reaches a caller
as a dispute ID.

**Both reads are free.** The dispute record was already being fetched, and the mapping takes only
the core dispute ID, so it joins the same multicall. No extra round trip.

## The second hard refusal

`DISPUTE_NOT_ADDRESSABLE`: the dispute exists, and another arbitrable created it. This tool cannot
know a foreign contract's local index, and submitting the core ID would file the document where
nothing reads it — the same harm `DISPUTE_NOT_FOUND` describes, from a different cause. It is a
separate code on purpose: a not-found ID may be a typo worth retrying, and this one can never work.
The message names the owning arbitrable, so the caller can see the case is real and that this tool
is the limitation.

**It lives on the write path, not in the read layer**, which is where ADR-0011 put the first one.
`status` shares `readEvidenceFacts` and reports a foreign dispute's period perfectly well; refusing
there would break a read that is correct. Only a command that signs needs a local index, so only a
command that signs refuses without one. `checkEvidencePreflight` stays literally never-refusing.

## The read scope this widens

ADR-0001 limits reads here to what is needed to **refuse a bad write**. This read does more: it
decides **what bytes are signed**. That is a new category and the widening is deliberate.

The justification is narrow, and is offered as the test for any future case: the alternative was a
write that cannot be read back. A read that changes the payload is admissible only where omitting it
produces a transaction that succeeds, costs money, and is unreachable — never as a convenience, and
never to enrich output. Discovery still happens upstream.

## What this does not fix

**Evidence groups collide across arbitrables.** **[live]** The group key is a bare integer with no
arbitrable qualifier, so testnet core dispute 58 (resolver, local 33) and core dispute 98 (a foreign
arbitrable, external 33) share `ClassicEvidenceGroup` id `33`. Two unrelated disputes display the
same evidence list. That is inherent to the deployed indexer and cannot be addressed from here;
submitting the local ID is still strictly better than submitting an id that matches nothing.

## The reversal this invites

**[inferred]** Upstream `dev` — not `master`, which is what is deployed on both Arbitrum One and the
v2 testnet — deletes `ClassicEvidenceGroup`, keys evidence on the core dispute ID, and **drops**
evidence whose id matches no dispute, with a logged error. The contract-side rename of the parameter
to `_arbitratorDisputeID` is the visible half of that and is otherwise cosmetic: the body still only
emits its argument, and the selector is unchanged. The Arbitrum Sepolia **devnet** already runs the
renamed contract, which is one more reason this tool refuses that deployment by name.

So this decision is correct for what is deployed and will have to be reversed when that indexer
ships. The reversal is not a regression, and whoever makes it should re-read this file rather than
the code: [05 §1.6](../spec/05-verification.md)'s parameter-name pin is the tripwire, and it fires
on the ABI, which changes before the subgraph does.
