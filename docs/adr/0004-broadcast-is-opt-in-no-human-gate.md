# Broadcast is opt-in, and there is no human confirmation gate

The obvious safety design for a tool that spends money is an interactive confirmation before every
write, skipped when stdin is not a TTY. The primary consumer is an autonomous agent, so that gate
never fires — and the paths it runs under supply nothing in its place. OpenClaw's `command`-payload
cron "executes inside the Gateway process as admin-authored automation" and is explicitly not
governed by the agent's exec-approval policy; on the interactive exec path, a single `allow-always`
writes a persistent allowlist entry keyed on the resolved binary path and permanently disarms the
prompt.

The gate therefore lives inside the tool:

1. **Pre-flight reads** reject every chain-detectable error locally: the arbitration cost against
   the signer's balance (**including the value being sent**, not gas alone); the court ID against
   `courts.length` and its `disabled` flag; `isSupported(courtID, disputeKitID)`; the existence of
   the core dispute an evidence submission names; and the period and deadline for advisory
   purposes.
2. **`simulateContract`** catches the rest before a fee is paid.
3. **Sending requires an explicit `--broadcast`.** The default is plan, simulate, stop.

## Layer 2 is thinner here than it looks

For `kleros-juror-cli`, `simulateContract` was a genuine second net: a wrong period, an unowned
vote or a duplicate commitment all revert. Here, the most expensive class of mistake **does not
revert**. A wrong court ID, a zero juror count or a malformed `extraData` blob simulates perfectly
and then creates a paid dispute in the General Court under Classic. The `extraData` decoder
substitutes defaults rather than failing.

So for `create-dispute`, layer 1 is not belt-and-braces — it is the only thing between a typo and
an irreversible paid mistake, and layer 3 is the only thing between a simulation and a spend. That
is why the effective court, juror count and dispute kit are echoed in the envelope rather than the
requested ones, and why a difference between them is an error rather than a warning.

## What this deliberately does not catch

A well-formed dispute over a meritless claim, or evidence that argues the wrong thing. Nothing on
chain contradicts either — `DisputeResolver` is permissionless and `submitEvidence` has no access
control at all — and that is precisely what a human was eyeballing at the TTY prompt. Asserting
that a claim is worth bringing means reading the arbitrable's history and the counterparty's
material, which is both upstream work and a direct violation of ADR-0007. See ADR-0001 on the
filing / case-construction line.

## Consequences

A caller that forgets `--broadcast` gets a successful simulation and no dispute. That must be
unmistakable in the output rather than reading as success: the result carries `"broadcast": false`
and states in words that nothing was sent. This matters more than usual because the consuming agent
sees merged stdout/stderr text and an effectively binary exit code, so failure semantics have to
live in the payload.

The mirror-image case matters more still. When a broadcast succeeds but the receipt never arrives,
the result is `status: "unknown"` — a **success**, not an error. The tool stopped watching; the
transaction may still land. Presenting it as a failure invites a retry, and a blind re-send of
`createDispute` pays the arbitration cost a second time and creates a second dispute over the same
claim. The `unknown` message must say that in words, and must carry the transaction hash so the
caller can resolve it by reading rather than by re-sending.
