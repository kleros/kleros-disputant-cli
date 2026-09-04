# A strict authoring schema, not the SDK's lenient parser

The dispute-template JSON this tool emits is validated against a **strict schema written in this
repo**. `@kleros/kleros-sdk` is not a runtime dependency. Its compiled `disputeDetailsSchema` is
imported in **one devDependency test**, to assert that what this tool emits is accepted by the
canonical definition.

## Why not just use the canonical schema

Because it is pointed the wrong way. `disputeDetailsSchema` exists to parse **hostile third-party
blobs** for display: it is lenient by design, and the same posture appears in AgentKit's
`MetaEvidence` schema — `.passthrough()`, nearly everything optional, drop-on-mismatch. That is
correct for a reader, which must render whatever it is given without crashing.

An **authoring** schema is the exact inverse. Its job is to refuse *this operator's* input before a
payable, irreversible transaction is built from it. Where the parser shrugs, the author must stop:

- An unknown key is a **typo the operator wants to hear about**, not a field to pass through. A
  misspelled `descripton` silently dropped by a lenient parser becomes a dispute with no
  description that cost real money.
- A missing optional-in-the-parser field may be **required in practice**. `policyURI` is one:
  optional to the contract, required by the schema, and a template without it renders degraded in
  Court (ADR-0009).
- `answers[].id` must actually match `/^0x[0-9a-fA-F]+$/` and start at `0x1`, because **`0x0` is
  reserved for "Refuse to Arbitrate" and is never in the submitted array**. A lenient parser that
  accepts a decimal `id` produces a template whose ruling options do not line up with
  `_numberOfRulingOptions`.
- `arbitratorChainID` is the **string** `"42161"`, and `arbitratorAddress` must be the KlerosCore
  address from the package. The published documentation examples carry a stale KlerosCore address
  for chain 42161; a lenient parser accepts it.

Adopting a lenient parser as the gate would mean the tool's only validation is the one designed not
to complain.

## The dependency cost, which is secondary but real

`@kleros/kleros-sdk` drags a conflicting zod major. This repo has exactly two runtime dependencies,
and `z` comes from `incur` (zod v4 internally) so that there is one zod instance — a rule that
exists precisely because two instances produce schemas that fail each other's `instanceof` checks.
Adding a third runtime dependency to reach a schema that is the wrong shape is a bad trade twice
over.

But the ordering matters: **the SDK is rejected because its schema is lenient, not because it is
heavy.** If the dependency cost vanished tomorrow, this decision would not change.

## Why the cross-check test, then

Because "strict" must mean *stricter than canonical*, not *different from canonical*. A hand-
written schema drifts: upstream adds a required field, or tightens a refinement, and this repo
carries on emitting templates that Court quietly downgrades. The failure is invisible from inside
the repo — every test passes, every dispute is created, and only the rendering is wrong.

So one test imports the SDK's compiled schema and asserts that a template this tool considers valid
**parses cleanly under it**. The dependency stays a devDependency and never reaches `dist`.

Three mechanical facts about reaching it, verified against `@kleros/kleros-sdk@2.4.0` — the plan
document is wrong on two of them, so do not take its version:

- The schema is the **default export** of
  `@kleros/kleros-sdk/lib/src/dataMappings/utils/disputeDetailsSchema.js`, under the name
  `DisputeDetailsSchema`. There is no export called `disputeDetailsSchema`.
- It is **not re-exported from the package root**. The root barrel exposes only `QuestionType`,
  `configureSDK`, `executeAction`, `executeActions`, `getDispute`, `getPublicClient`, `isUndefined`
  and `populateTemplate`. The deep path is reachable only because the SDK declares no `exports` map
  at all — an absence, not a guarantee. If one is ever added, this test breaks and the fallback is
  the `.ts` source in the kleros-v2 monorepo.
- The SDK depends on `zod@^3.23.8`. That is the conflicting major, confirmed: the test must
  therefore build its fixture as a plain object and hand it to the SDK's own `zod` instance, never
  pass a zod-v4 schema or a parsed v4 result across the boundary.

The module also usefully confirms `policyURI` is `z.string().refine(isMultiaddr)` — which is why a
plain `https://` URL fails validation (ADR-0009) and why this repo's strict schema must reject one
rather than pass it through.

That is a one-directional check by construction, and deliberately so: it catches this repo becoming
*looser* than canonical, which is the failure that ships broken disputes. It cannot catch this repo
being *stricter* — which is the intended state, not a defect.

## Consequences

The field list is transcribed rather than imported, so it must be kept in step by hand and the
cross-check test is what makes that safe. Required: `title`, `description`, `question`, `answers`,
`policyURI`, `arbitratorChainID`, `arbitratorAddress`, `version`. Optional: `attachment`,
`frontendUrl`, `category`, `lang`, `specification`, `metadata`, `aliases`, `extraEvidences`.

`_disputeTemplateDataMappings` is always `""`. Mappings are resolved at display time for arbitrables
with dynamic state, and `graphql` mappings need a Graph API key — neither belongs in a static
template this tool emits.

The same strictness applies to the evidence document, which is small enough to state in full:
`{ name, description, fileURI?, fileTypeExtension? }`, `name` and `description` required. The field
is **`name`** — the published docs page saying `title` is wrong, and every authority that matters
(the contracts' own `evidence-format.md`, the SDK schema, the subgraph handler and the UI) uses
`name`. A `title`-keyed document indexes with a null name.
