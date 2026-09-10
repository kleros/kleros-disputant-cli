# 07: The template names the deployment's own arbitrator

**What to build:** A dispute template cannot register a chain ID or an arbitrator address that
disagrees with the deployment the dispute is created on. An author who omits them gets the right
ones; an author who states them wrongly is refused before any money is spent. Neither field has to
be typed by hand any more.

**This is not testnet scope**, and it is not a defect this feature introduced. It is reachable on
`arbitrum-one` today: `spec/05 §6` records that **the published Kleros documentation's template
examples name an `arbitratorAddress` that is not the deployed `KlerosCore`**, and `ADR-0010 §28`
records the same, as one of the motivating examples for having a strict authoring schema at all. The
strict schema does not currently catch it — `arbitratorAddress` is checked for being *an* address and
never for being *the* arbitrator. It sits in this directory for the reason ticket 02 did: the work
that exposed it is here.

**Blocked by:** nothing. Ticket 03 moved `resolveDeployment` to the top of `runCreateDispute`, so
the deployment is already in scope in the local-first block where `buildTemplate` runs — both checks
stay offline and cost no round trip.

**Do this before the first Arbitrum One broadcast**, per the spec's own rule that the first real
transaction should be a confirmation and not an experiment. Ticket 04 does not block it, but 04 is
what turns copying a template between deployments into a routine action, so the two are worth
sequencing together.

**Status:** done, 2026-09-10 — `spec/02 §3.1`, `§3.2`, `spec/05 §1.4`, `§6`, `ADR-0010`, `CONTEXT.md`, `README.md`, `SKILL.md`

- [x] `arbitratorChainID` is compared against the selected deployment's chain ID, and
      `arbitratorAddress` against that deployment's `KlerosCore`, **checksum-insensitively** — the
      canonical schema accepts a non-checksummed address and `template.test.ts` pins that one
      survives verbatim.
- [x] A mismatch is a **refusal**, `TEMPLATE_INVALID`, raised before the quote and before anything
      is simulated. Not a warning: the fee is paid on creation, the registration is permanent, and
      the same reasoning already governs `policyURI`, which is refused on the stated grounds that
      the failure is invisible until after the money is spent.
- [x] Both fields become **optional in the authoring schema and are derived when absent**, from the
      resolved deployment. Requiring an author to write `0x991d…` into a file is the trap
      `docs/knowledge/never-expand-an-elided-address.md` names, against a repo rule that addresses
      are imported and never hand-copied (`ADR-0006`). The precedent is `_numberOfRulingOptions`,
      derived from the template's own `answers` so the two cannot disagree (`spec/02 §1.1`).
- [x] A value that is **present and wrong is never rewritten**. Two reasons, and both matter:
      silently substituting a correct value for an operator's explicit statement is the behaviour
      `extraData` pre-flight exists to prevent, and `spec/02 §3.5` pins keccak vectors over the
      exact serialised bytes, so rewriting a present field would move them.
- [x] `spec/02 §3.2` records that both fields are derivable and that a mismatch is refused;
      `spec/05 §1.4` gains the two missing cases — today it checks that `arbitratorChainID` is a
      *string* and never that either value is *right*; `spec/05 §6`'s "use the package address"
      entry points at the check that now enforces it.
- [x] `ADR-0010` gains a line: the strict schema's motivating example is now actually caught.
- [x] The refusal message states what the template said and what the deployment is, so a caller can
      correct the file without reading the source. It **must not** print an address the caller is
      then expected to copy back in — the fix is to delete the field, not to retype it.

## Comments

**2026-09-09** — Specified after ticket 03, which is what made both checks cheap. Two things the
implementing agent should not re-derive.

**The fields are inert in everything readable, and the ticket is written knowing that.** Measured
against `@kleros/kleros-sdk@2.4.0` as installed under `reference/agentkit/node_modules`: both fields
are **required** and shape-validated — `arbitratorChainID: z.string()`, `arbitratorAddress` refined
through `isAddress(..., { strict: false })` — but **no code reads either value**. An exhaustive grep
of the installed package returns only declarations. `populateTemplate` renders, parses, validates,
then touches only `answers`, and it receives no deployment identity to compare against; the SDK's
chain client comes entirely from the host through `configureSDK`. AgentKit carries both fields
through verbatim into `renderedTemplateData` and selects its chain from its own resolved config, not
from the template. So a template naming chain 1 and a wrong arbitrator renders and validates
identically to a correct one.

**What that means for the harm, stated honestly: it is provenance, not misrouting.** Nothing fetches
against the wrong arbitrator. What a mismatch produces is a paid, permanent, unamendable record
carrying a false statement about which arbitrator the case belongs to. The justification for
refusing anyway is not severity — it is that **the check has no false positives**: the correct value
is uniquely determined by the deployment, so no legitimate template can be blocked by it. Combined
with deriving-when-absent, the refusal is only reachable by explicitly writing a wrong value.

**NOT ESTABLISHED: the Kleros Court web app.** Its source is in neither searched tree and no claim
is made about it. If it does resolve the arbitrator from these fields, the harm is misrouting rather
than provenance and the refusal message should say so — **ask the maintainer rather than measuring
harder**, this is exactly the class of question they are a primary source for.

**One thing that is genuinely load-bearing, and is already covered.** `arbitratorChainID`'s *type*:
a numeric `42161` fails `safeParse` and `populateTemplate` throws, which makes the template
unrenderable rather than merely wrong. The strict schema already rejects it and
`template.test.ts:94` pins it. Do not conflate that case with this one.

**2026-09-10** — Done. Both fields are optional in the authoring schema and derived from the
resolved deployment when absent; a stated value is compared — the chain ID exactly, the address
checksum-insensitively — and a mismatch is `TEMPLATE_INVALID`, offline, before the quote. The
command-level test asserts `node.methods` is empty, so the refusal lands before a single RPC method,
not merely before the write. `resolveArbitrator` in `template.ts` is the seam;
`parseTemplate`/`buildTemplate` now take the `Deployment`.

**The maintainer answered the one question this ticket said to ask.** The Kleros Court web app does
**not** resolve the arbitrator from these fields either. So the harm is provenance, exactly as
specced, and the refusal message says the address is not the deployment's arbitrator rather than
claiming the dispute would be unreadable. Recorded as **[maintainer]** in `spec/02 §3.2`, alongside
what was already measured about the SDK and AgentKit.

**Two things this ticket changed that it did not predict.**

**The differential test from ticket 04 broke, and that was the feature working.** "The two
deployments answer identically" fed T1 — which states Arbitrum One's own arbitrator — to both
deployments, so the testnet side began refusing. Fixed by giving those two tests a template that
states *neither* field, which is now the portable authoring style; the refusal that the fixture
change removes is asserted separately, in "refuses a Beta template handed to the testnet". A shared
fixture only one deployment accepts would have turned a test of agreement into a test of refusal.

**`README.md`'s example lost both fields rather than gaining a warning.** The old bullet told a
reader to resolve the address from `ADR-0006` "not by hand" while the example above it printed one
to copy. Deleting both lines is the honest version of that advice, and it demonstrates the portable
style in the one document a stranger reads.

**A test that looked right and proved nothing.** "Puts a derived field exactly where a stated one
would have gone" survived reordering `parseTemplate`'s return literal — because `serialiseTemplate`
walks its *own* field order, so the parse object's order cannot reach the bytes. Renamed to what it
actually pins (byte-identity of derived versus stated **values**) after falsifying it against a
lowercased derivation instead. Field *position* is pinned by T1's keccak, and was already.

**Not done, deliberately:** nothing here checks that the *deployment* named by `--chain` is the one
the operator meant. That is what `--chain` is for, and no template check can second-guess it.
