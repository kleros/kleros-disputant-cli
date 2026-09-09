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

**Status:** ready-for-agent

- [ ] `arbitratorChainID` is compared against the selected deployment's chain ID, and
      `arbitratorAddress` against that deployment's `KlerosCore`, **checksum-insensitively** — the
      canonical schema accepts a non-checksummed address and `template.test.ts` pins that one
      survives verbatim.
- [ ] A mismatch is a **refusal**, `TEMPLATE_INVALID`, raised before the quote and before anything
      is simulated. Not a warning: the fee is paid on creation, the registration is permanent, and
      the same reasoning already governs `policyURI`, which is refused on the stated grounds that
      the failure is invisible until after the money is spent.
- [ ] Both fields become **optional in the authoring schema and are derived when absent**, from the
      resolved deployment. Requiring an author to write `0x991d…` into a file is the trap
      `docs/knowledge/never-expand-an-elided-address.md` names, against a repo rule that addresses
      are imported and never hand-copied (`ADR-0006`). The precedent is `_numberOfRulingOptions`,
      derived from the template's own `answers` so the two cannot disagree (`spec/02 §1.1`).
- [ ] A value that is **present and wrong is never rewritten**. Two reasons, and both matter:
      silently substituting a correct value for an operator's explicit statement is the behaviour
      `extraData` pre-flight exists to prevent, and `spec/02 §3.5` pins keccak vectors over the
      exact serialised bytes, so rewriting a present field would move them.
- [ ] `spec/02 §3.2` records that both fields are derivable and that a mismatch is refused;
      `spec/05 §1.4` gains the two missing cases — today it checks that `arbitratorChainID` is a
      *string* and never that either value is *right*; `spec/05 §6`'s "use the package address"
      entry points at the check that now enforces it.
- [ ] `ADR-0010` gains a line: the strict schema's motivating example is now actually caught.
- [ ] The refusal message states what the template said and what the deployment is, so a caller can
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
