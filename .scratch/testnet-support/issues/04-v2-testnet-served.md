# 04: v2 testnet served

**What to build:** `--chain arbitrum-sepolia-testnet` works. A caller can quote an arbitration cost,
plan a dispute and simulate it against the v2 testnet, with the same mechanics as v2 Beta and no path
that exists on one deployment only.

**Blocked by:** 03.

**Status:** done

- [x] `arbitrum-sepolia-testnet` joins the table and resolves end to end for reads and simulation.
- [x] ABIs are bound per deployment. They are not interchangeable: the dispute resolver and evidence
      module ABIs are byte-identical across the two, but the arbitrator's differ — 123 entries against
      115 — with the whitelist and juror-NFT functions and four errors present only on Beta.
- [x] Each deployment carries its own default endpoint, and both RPC override variables are honoured.
      Their names are derived by the same formula the sibling CLI uses, so one exported variable
      serves both tools.
- [x] The fingerprint test covers both deployments and records the ABI difference, so an upstream
      regeneration breaks the build rather than a transaction. **Accepted cost:** a testnet
      redeployment will fail this test. That is intended — a redeployment silently changes where
      transactions are sent — and is the only ongoing maintenance this feature adds.
- [x] The in-process JSON-RPC double takes a deployment and answers as either one, from the real ABIs.
      The seam stays the endpoint option: nothing injected, no module mocked.
- [x] A **differential test** runs the same inputs against both deployments and asserts the envelopes
      are structurally identical apart from the deployment fields and the addresses. This is what
      catches a future branch on the deployment — a ceiling skipped on the testnet, a gate added
      there — and turns "identical mechanics" into a pinned property.
- [x] The startup-ordering test runs at the testnet chain ID, proving the expected value is read from
      the selected deployment rather than a constant, and that no contract call precedes the assertion.
- [x] The suite is **not** run as a matrix. The second deployment appears only in the differential
      test, the startup-ordering test and the unsupported-slug refusals; mechanics are identical by
      design, so running every test twice would execute the same lines against different constants.
- [x] Court validation is confirmed to need no per-deployment table: court existence is already probed
      live, so the testnet's court set is discovered rather than written down.

## Comments

**2026-09-09** — Shipped. Every box above is closed; four things the next ticket should not
re-derive, and one correction to this ticket's own text.

**The ABI counts in this ticket were stale, and the delta was not.** It says "123 entries against
115"; the installed `@kleros/kleros-v2-contracts@2.0.0-rc.2` gives **126 against 118**. The
difference is 8 either way, and the entries are exactly the ones named: nine Beta-only
(`arbitrableWhitelist`, `changeArbitrableWhitelist`, `jurorNft`, `changeJurorNft`, four errors, and
a twelve-argument `initialize`) against one testnet-only (the same `initialize` with eleven). The
package added three entries to each side after the spec was written. `spec/01 §1.0b` records the
measured numbers; the test derives the entry sets rather than asserting a count, so this cannot go
stale the same way twice.

**A thing the ticket did not ask about: the testnet has no `DisputeResolverRuler`.** The contracts
package has none for that deployment — no `disputeResolverRulerConfig`, no `klerosCoreRuler*` either
— so `contractsFor` carries it as `undefined` rather than substituting v2 Beta's, which would name a
contract that does not exist on the selected deployment. **The refuse-by-name control is therefore
vacuous on the testnet, not enforced**, and the fingerprint asserts it only where there is a ruler
so it returns by itself if one is ever shipped. Recorded in `spec/01 §1.0a`, not buried in a
comment, because "the pinned address is the control" is a sentence `spec/01 §1` makes flatly and it
is now true of one deployment out of two.

**`reverts.ts` needed no work, and the reason is a measurement rather than a hope.** Ticket 03 built
`SERVED_ABIS` from `DEPLOYMENT_SLUGS`, so registering the deployment extended the selector table by
itself — but that only helps if the union is complete. It is: the testnet's `KlerosCore` declares
**no error v2 Beta does not**; the four-error difference runs the other way. So every selector the
testnet can put on the wire was already in the table before it was served.

**`EXPECTED_VERSIONS` stayed deployment-independent, as the spec said it would**, and a test now
says so rather than a comment: the testnet startup test asserts a version mismatch warns from the
same table the default uses.

**Three user-facing strings were single-deployment claims and are fixed here**, because the ticket's
"no path that exists on one deployment only" reaches prose the moment a second deployment is served:
`--kit`'s description and the `DISPUTE_KIT_NOT_SUPPORTED` message both attributed "every court
supports Classic" to the tool rather than to where it was measured, and `--dispute`'s description
said "Every dispute on arbitrum-one is reachable today, however it was filed" — which on the testnet
is false and would have told an agent that `DISPUTE_NOT_ADDRESSABLE` is unreachable code. It is
reachable there, with 26 foreign arbitrables.

**The differential test was falsified before being trusted.** A deliberate branch on the deployment
— a warning emitted only on the testnet — was added to `read.ts`, the comparison caught it, and the
branch was removed. `spec/05 §1.6b` now requires that step of any future differential test: one that
cannot fail is worse than none.

**Ticket 07 is still the thing to do before the first Arbitrum One broadcast.** This ticket is what
makes copying a template between deployments a routine action, which is the case 07 refuses.

**A review after the fact found six defects in this work; all are fixed here.** Recorded because
four of them are traps a later ticket would otherwise re-lay.

**Two tests broke the suite for anyone who followed `ADR-0016`.** `shared.test.ts`'s "defaults the
endpoint rather than reading one from the environment" set `ARBITRUM_RPC` — the *juror* CLI's
variable, which this tool has never read — and so asserted nothing either way; once the variable was
honoured, exporting `KLEROS_RPC_URL_ARBITRUM_ONE` made both that test and `parseRpcUrls`'s fallback
test fail. **A test that reads the ambient environment fails on the operator's machine and nowhere
else.** Both now clear every deployment's variable explicitly and set what they mean to test; the
suite passes with both variables exported.

**`shape()` in the differential test was over-broad in both directions**, and the fix is the
interesting part. Erasing only *the deployment under test's* identity is wrong, because
`arbitrum-one` appears in **deployment-independent** prose — `preflight.ts`'s
`DISPUTE_KIT_NOT_SUPPORTED` names it as where "every court supports Classic" was measured, and says
so on both deployments — which the Beta side would rewrite and the testnet side would not, reporting
a difference that is not there. And `42161` is a proper prefix of `421614`, so a plain `replaceAll`
turned a deployment-independent `421611` into `<chainId>1` on one side only. It now substitutes
**every served deployment's identity on both sides**, with chain IDs matched longest-first on digit
boundaries. **One blind spot remains and is documented rather than hidden:** a field whose value *is*
a chain ID and differs per deployment collapses to the same placeholder. The per-test identity
assertions cover it, and they run before the comparison.

**The differential test compared envelopes only**, so a branch changing *which* contract is called
was caught only indirectly. It now compares `node.contractCalls` as well.

**One assertion was vacuous.** "resolves each address on its own deployment's chain" asserted only
that the testnet's `DisputeResolver` differs from Beta's — true of *every* row of a chain-keyed
config, so resolving at Gnosis Chiado (`10200`, which that config also holds) passed it. It now
names the Chiado address. Worth knowing: the package's `getAddress` **throws** for a chain key it
does not have, so a wrong chain ID is only silent where the key exists — `disputeResolver` and
`disputeTemplateRegistry` on the testnet.

**Two citations pointed at the section that now says the opposite.** `spec/03 §3.1` used to be the
authority for "no environment variable"; it is now the section that establishes one.
`--upload-url`'s row and `ADR-0010`… `ADR-0012`'s line both cited it. The claims stay true and the
reason is better: the override variables are named **per deployment**, and `upload-file` has no
deployment to derive a name from.

**`README.md`'s factual claims were corrected here; ticket 06 still owns the framing.** "One
deployment served" and the Arbitrum-One-only prerequisites and badge were flatly false the moment
this shipped, and the repo's own rule makes a change to the option surface a change to the README.
The tagline gained the second deployment. What ticket 06 still owns: `skills/kleros-disputant/`,
`spec/README.md`'s Network row, and the deeper structure.
