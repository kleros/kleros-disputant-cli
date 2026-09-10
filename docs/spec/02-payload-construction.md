# 02. Payload construction

The functional core. Everything in this document is a pure function of operator-supplied inputs and
the values read in [01](./01-onchain-reference.md). It is specified separately from the transaction
path because it is where the irreversible mistakes are made, and because a pure core is
exhaustively testable without a network.

Three payloads are constructed: the `extraData` blob, the dispute template JSON, and the evidence
JSON. All three are **inline in calldata**. None of them is pinned, hashed to a URI, or uploaded.
[ADR-0009](../adr/0009-the-cli-references-ipfs-and-never-pins.md)

## 1. `_arbitratorExtraData`

Three 32-byte words: **court ID, juror count, dispute kit ID**.

```ts
encodeAbiParameters(
  [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
  [courtID, numberOfJurors, disputeKitID],
) // exactly 96 bytes
```

Normative:

- The blob **MUST** be exactly 96 bytes for the Classic kit.
- The CLI **MUST NOT** emit a blob of any other length. In particular a 64-byte blob **MUST NOT**
  be emitted — see [01 §4.4](./01-onchain-reference.md).
- The same blob object **MUST** be passed to `arbitrationCost` and to
  `createDisputeForTemplate` in one invocation. The CLI **MUST NOT** rebuild it between the quote
  and the send, and **MUST NOT** reuse a quote across invocations.
- `encodePacked` **MUST NOT** be used. The 44-byte packed form in the published Kleros
  documentation silently selects the General Court.

> **[live]** Gated and GatedShutter concatenate a further 64 bytes of kit data, giving a 160-byte
> blob. Since `isSupported(1, 3)` and `isSupported(1, 4)` are both `false` on Arbitrum One, those
> kits are out of scope **for the General Court** — which is scope enough for this tool, but is not
> evidence that no court supports them, because some do. "96 bytes" is therefore a property of the
> kits in scope rather than of the format. A CLI that later adds them **MUST** revisit this
> section rather than pad the blob.

### 1.1 Validation, before encoding

Every check below is local or a pre-flight read, and every one **MUST** produce a named refusal.
None of them can be delegated to simulation.

| Check | Refuses when | Source |
| --- | --- | --- |
| Court exists | `courtID == 0`, or `getTimesPerPeriod(courtID)` reverts | `getTimesPerPeriod()` reverting past the end of the array |
| Court enabled | `courts(courtID).disabled == true` | `courts()` |
| Juror count | `jurors < 1` | local |
| Kit in range | `kitID == 0` or `kitID >= disputeKits.length` | `disputeKits()` |
| Kit supported | `isSupported(courtID, kitID) == false` | `isSupported()`, **never cached** |
| Ruling options | `numberOfRulingOptions < 2` | local; the contract also refuses, with a string |
| Options agree | `numberOfRulingOptions != answers.length` | local; **the contract does not check this** |

The last row is the one with no on-chain backstop at all: the template is an opaque string to
`DisputeResolver`, so a template offering three answers submitted with
`_numberOfRulingOptions = 2` is created successfully and renders wrong. The CLI **MUST** derive
`_numberOfRulingOptions` from the template's own `answers` array rather than accept it separately.

### 1.2 Effective-value echo

After a successful create, the CLI **MUST** read the resulting dispute's court from
`KlerosCore.disputes(coreDisputeID)` and report the **effective** court, juror count and kit. A
difference from the requested values **MUST** be reported as an error, not a warning, because it
means the decoder substituted a default and the money is already spent.

### 1.3 Test vectors — `extraData`

**[computed]**, with each quote **[live]** on 2026-09-08.

#### X1 — General Court, 3 jurors, Classic

```
--court 1 --jurors 3 --kit 1

extraData = 0x0000000000000000000000000000000000000000000000000000000000000001
              0000000000000000000000000000000000000000000000000000000000000003
              0000000000000000000000000000000000000000000000000000000000000001
length    = 96 bytes
cost      = 15000000000000000 wei = 0.015 ETH
```

#### X2 — court 2, 5 jurors, Classic

```
--court 2 --jurors 5 --kit 1

extraData = 0x0000000000000000000000000000000000000000000000000000000000000002
              0000000000000000000000000000000000000000000000000000000000000005
              0000000000000000000000000000000000000000000000000000000000000001
cost      = 34500000000000000 wei = 0.0345 ETH
```

#### X3 — court 29, 7 jurors, Classic

```
--court 29 --jurors 7 --kit 1

extraData = 0x000000000000000000000000000000000000000000000000000000000000001d
              0000000000000000000000000000000000000000000000000000000000000007
              0000000000000000000000000000000000000000000000000000000000000001
cost      = 37800000000000000 wei = 0.0378 ETH
```

#### X4 — court 34, 3 jurors, Classic

```
--court 34 --jurors 3 --kit 1

extraData = 0x0000000000000000000000000000000000000000000000000000000000000022
              0000000000000000000000000000000000000000000000000000000000000003
              0000000000000000000000000000000000000000000000000000000000000001
cost      = 810000000000000 wei = 0.00081 ETH
```

X1 through X4 span three orders of magnitude of cost. A test that only ever quotes X1 will not
notice a court that is not being encoded at all — which is exactly the failure this section exists
to prevent.

#### X5 — the refusal vectors

Each of these **MUST** be refused locally, with a distinct named code, and **MUST NOT** reach
`arbitrationCost` or `simulateContract`. Every one of them quotes 0.015 ETH and simulates cleanly
**[live]**, which is why local refusal is the only defence.

| Input | Why it must be refused |
| --- | --- |
| `--court 0` | The Forking Court. Maps to General |
| `--court 99` | Out of range. Maps to General |
| `--jurors 0` | Maps to the default juror count |
| `--kit 0` | Maps to Classic |
| `--kit 99` | Out of range. Maps to Classic |
| `--kit 2` with `--court 1` | Not supported by that court. This one *does* revert — refuse it first anyway, so the error is named |
| an `extraData` blob shorter than 96 bytes | Reads past its end or takes the `< 64` branch |

## 2. Arbitration cost

```
cost = KlerosCore.arbitrationCost(extraData)
value = cost          // exactly. Not cost + margin, not a rounded cost
```

**[live]** `cost == courts(courtID).feeForJuror × jurors` in every sample taken. The CLI **MAY**
use that relation to explain the quote in prose. It **MUST NOT** use it to compute the quote.

Normative:

- The CLI **MUST** enforce a local ceiling before quoting, and **MUST** refuse above it with a
  named code rather than send. The ceiling is an operator input with a conservative default.
- The CLI **MUST** state the exact value, in wei and in ETH, in every envelope it produces for
  `create-dispute` — including the simulate-only one.
- The CLI **SHOULD** warn when the quote is large in absolute terms, and that warning **MUST**
  reach the `warnings` array rather than replace the value.
- Underpaying reverts (`ArbitrationFeesNotEnough()`); overpaying does not
  ([01 §3.2](./01-onchain-reference.md)). The CLI's defence against overpayment is arithmetic, not
  the chain's.

## 3. The dispute template

The JSON document describing what jurors are being asked. It travels **inline** in
`_disputeTemplate`, and `_disputeTemplateDataMappings` is `""`.

### 3.1 Fields

Transcribed from the canonical `DisputeDetailsSchema` (`kleros-sdk/src/dataMappings/utils/
disputeDetailsSchema.ts`).

**Required**: `title`, `description`, `question`, `answers`, `policyURI`, `arbitratorChainID`,
`arbitratorAddress`, `version`.

**Optional**: `attachment` (`{ label, uri }`), `frontendUrl`, `metadata`, `category`, `lang`,
`specification`, `aliases`, `extraEvidences`.

That list is the **canonical** one. This CLI's authoring schema diverges on the two arbitrator
fields: it accepts a template that omits them and **derives** them from the selected deployment
(§3.2). What it emits always carries both, so the document it produces still satisfies the canonical
requirement — the divergence is in what an author must type, never in what jurors are shown.

| Field | Constraint |
| --- | --- |
| `answers` | `[{ id, title, description, reserved? }]`, `id` matching `/^0x[0-9a-fA-F]+$/` |
| `policyURI` | **A multiaddr** — `/ipfs/…` or `ipfs://…/…`. A plain `https://` URL fails the refinement |
| `arbitratorChainID` | The chain ID **of the selected deployment**, as a **string**, not a number — `"42161"` for `arbitrum-one`, `"421614"` for `arbitrum-sepolia-testnet` |
| `arbitratorAddress` | The `KlerosCore` address **of the selected deployment**, from the package, checksummed or not. Not the one in the published examples — see the warning below |
| `version` | A string. Free-form; the canonical schema does not constrain it |

> [!WARNING]
> **The published documentation's template examples name arbitrators that are not these ones —
> on both deployments.** **[docs]**, `docs.kleros.io`, read on **2026-09-10**:
>
> | Where | The example pairs | The deployment's `KlerosCore` is |
> | --- | --- | --- |
> | `/reference/data-formats/dispute-templates` — the Escrow V2 and Reality V2 examples | `"42161"` with `"0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002"` | `0x991d2df165670b9cac3B022f4B68D65b664222ea` ([01 §1](./01-onchain-reference.md)) |
> | the same page, Curate V2 registration | `"421614"` with `"0xD08Ab99480d02bf9C092828043f611BcDFEA917b"` | `0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479` **[abi]**, `testnetViem` |
>
> The first is not merely "some other address": **[abi]** it is `xKlerosLiquidAddress` for chain
> `100` — the Kleros **v1** arbitrator on **Gnosis**. So the example is wrong in both fields at
> once, naming the wrong protocol generation on the wrong chain. The second matches neither the
> testnet core above nor the devnet's.
>
> And the docs do not merely carry it, they **assert** it. On
> `/developers/arbitrable-apps/arbitrable-production` **[docs]**, read the same day, a worked
> "Example Template Validation" annotates that address `// ✓ KlerosCore on Arbitrum One` — on the
> same page as its own checklist item ``[ ] `arbitratorAddress` matches deployment``. A reader who
> follows the checklist against the example passes.
>
> The addresses are written out in full here on purpose. A reader has to match them against what is
> in their own template, and eliding them would invite exactly the reconstruction
> [`never-expand-an-elided-address.md`](../knowledge/never-expand-an-elided-address.md) forbids.
> They are here to be **recognised**, never to be called.
>
> Nothing upstream enforces that checklist. **This CLI does**: both fields are checked against the
> selected deployment and a mismatch is refused before anything is contacted (§3.2), so a template
> copied from these examples is refused here rather than paid for.


Two notes on the canonical schema:

- **`extraEvidences` is a field**, declared `z.array(EvidenceSchema).default([])` — so the
  canonical parser *adds* it when it is absent rather than rejecting the document. **[client]**,
  read from `@kleros/kleros-sdk@2.4.0`,
  `lib/src/dataMappings/utils/disputeDetailsSchema.js`, on 2026-09-08. *(An earlier draft of this
  section claimed the opposite and "corrected" the bootstrapping handoff's §14.6, which was
  right — see [Appendix A §3.4](./appendix-a-unresolved.md), which restates it.)* This CLI does
  not author it, so its strict schema refuses a template carrying one; that is an authoring
  choice, not a claim about the canonical schema.
  **The field is version-dependent.** **[client]** A `v2.3.1`-era reference enumerates the output
  fields as "8 required / 7 optional" with no `extraEvidences` row, so the field appears to have
  been **added between 2.3.1 and 2.4.0**. A claim about "the canonical schema" is therefore only
  true of a version, and a 2.3.1 consumer *strips* an `extraEvidences` key rather than defaulting
  it. Name the version whenever this section is cited.
- The canonical schema is a plain `z.object`, so it is **neither** `.strict()` **nor**
  `.passthrough()`: unknown keys are silently stripped when it parses, not rejected. That leniency
  is appropriate for a consumer and wrong for an author.

### 3.2 The authoring schema MUST be strict

The CLI **MUST** hand-write a strict schema and **MUST NOT** validate what it emits with a lenient
parser. [ADR-0010](../adr/0010-a-strict-authoring-schema-not-the-sdk-parser.md)

- Unknown keys **MUST** be rejected, not stripped. A typo'd field name in an operator's template is
  a mistake to surface, not to silently drop into an irreversible paid transaction.
- The authoring schema **MAY** be stricter than the canonical one on a field the canonical one
  leaves open, and **MUST** say so where it is, so a reader does not mistake the extra strictness
  for a canonical constraint. **[client]** The canonical schema types `description`, `question` and
  the answers' `description` as a bare `z.string()` and so accepts `""`, and applies no validation
  at all to `frontendUrl`. Requiring those to be non-empty is this CLI's authoring policy.
- `arbitratorChainID` and `arbitratorAddress` **MUST** be checked against the selected deployment —
  the chain ID against the deployment's own, the address against its `KlerosCore`, and the address
  comparison **MUST** be **checksum-insensitive**, because the canonical schema accepts a
  non-checksummed address. A mismatch **MUST** be refused with `TEMPLATE_INVALID`, local and
  offline, before the quote and before anything is simulated. It **MUST NOT** be a warning: the fee
  is paid on creation and the registration is permanent and unamendable, which is the ground
  `policyURI` is already refused on (§3.4).
- Both fields **MAY** be omitted, and **MUST** then be derived from the selected deployment. The
  precedent is `_numberOfRulingOptions` (§1.1): a value uniquely determined by something the tool
  already holds is derived, so the two cannot disagree. Requiring an author to type a `KlerosCore`
  address into a file is the reconstruction
  [`never-expand-an-elided-address.md`](../knowledge/never-expand-an-elided-address.md) forbids,
  against a rule that addresses are imported and never hand-copied
  ([ADR-0006](../adr/0006-deployment-imported-from-contracts-package.md)).
- A value that is **present and wrong MUST NOT be rewritten**, and the refusal **MUST NOT** print
  the correct address — the fix is to delete the field, not to retype one out of a terminal. Two
  independent reasons for not rewriting: substituting a correct value for an operator's explicit
  statement is what `extraData` pre-flight exists to prevent (§4.4 of [01](./01-onchain-reference.md)),
  and §3.5 pins keccak over the exact serialised bytes, which a rewrite would move.
- `@kleros/kleros-sdk` **MUST NOT** become a runtime dependency. Its compiled schema **MAY** be
  imported in a devDependency test, to assert that what the CLI emits is accepted by the canonical
  definition. That test asserts one direction only, and **MUST NOT** be read as asserting the other.

> [!NOTE]
> **What a mismatch costs is provenance, not misrouting.** Nothing found so far resolves an
> arbitrator from these fields. **[client]** `@kleros/kleros-sdk@2.4.0`'s `populateTemplate`
> renders, validates and then touches only `answers`, and receives no deployment identity to compare
> against; an exhaustive grep of the installed package returns only declarations of the two fields.
> **[client]** `@kleros/agentkit` carries both through verbatim into `renderedTemplateData` and
> selects its chain from its own resolved config. **[maintainer]** The Kleros Court web app does not
> either, asked directly on **2026-09-10** — and that one is a claim about *deployed software*
> resting on the marker alone, which the legend does not let it be: the web app's source is in
> neither tree this repo reads, so it is unverified in the way a code-level check would settle.
> A template naming the wrong arbitrator therefore renders and validates identically to a correct
> one, and what it buys is a paid, permanent, unamendable record carrying a false statement about
> which arbitrator the case belongs to.
>
> **Nothing above depends on that being right.** The refusal is **not** justified by the size of the
> harm — if the web app did resolve from these fields, the harm would be misrouting instead and the
> rule would not change. It is justified by having **no false positives**: the correct pair is
> uniquely determined by the deployment, so no legitimate template can be blocked by it, and with
> derivation alongside, the refusal is reachable only by writing a wrong value deliberately.

### 3.3 Ruling options

- `0x0` is permanently reserved for "Refuse to Arbitrate / Invalid" and **MUST NOT** appear in the
  `answers` array the CLI submits.
- Submitted IDs **MUST** run from `0x1` upward, normalised as `"0x" + BigInt(id).toString(16)`.
- `_numberOfRulingOptions` **MUST** equal `answers.length`, and **MUST** be at least 2.

**[client]** The harm is not an arithmetic mismatch — an earlier draft of this section said it was,
and that mechanism is wrong. The SDK's `populateTemplate` **replaces a submitted `0x0` answer in
place**, keeping only its `description`, and prepends the reserved answer when none is present:

```js
const templateRTAIndex = dispute.answers.findIndex((a) => a.id && BigInt(a.id) === BigInt(0));
if (templateRTAIndex !== -1) { dispute.answers[templateRTAIndex] = { ...RefuseToArbitrateAnswer, … }; }
else { dispute.answers = [RefuseToArbitrateAnswer, ...dispute.answers]; }
```

So `answers.length` never changes and no count ever disagrees. What is lost is the operator's own
option: its `title` is silently overwritten with "Refuse to Arbitrate / Invalid" and it is marked
`reserved`, while `_numberOfRulingOptions` still counts it and the fee has already been paid for it.
A dispute offering three options renders two. Read from
`@kleros/kleros-sdk@2.4.0`, `lib/src/dataMappings/utils/populateTemplate.js`, on 2026-09-08.

Excluding `0x0` is therefore what keeps every option the operator paid for on the ballot, and it is
also why the count and the array length agree.

### 3.4 `policyURI`

**[live]** The contract does not check it. A dispute created with a missing or malformed
`policyURI` is created successfully and jurors are still drawn; it renders degraded in the Kleros
Court web client, whose `isTemplateValid` uses the schema above.

**[client]** "Degraded" is worth stating precisely, because it is what makes this a `MUST` rather
than a `SHOULD`: the SDK's schema requires `policyURI`, so such a template throws a `ZodError` in
`populateTemplate` on read — and the web client swallows every non-viem SDK error, resolving the
query with an empty `DisputeDetails` and showing a generic invalid-data message that names no
field. The operator gets no diagnostic at all, after paying.

The CLI **MUST** enforce the multiaddr form anyway, and **MUST** refuse a plain `https://` URL,
because the failure it prevents is invisible until after the money is spent.

**[client]** The refinement is the SDK's `isMultiaddr`, and its two branches are **not**
symmetrical. The CLI **SHOULD** transcribe the predicate verbatim rather than approximate it: a URI
the CLI accepts and the Kleros Court web client rejects is only discovered after the money is spent.

| Form | Accepts |
| --- | --- |
| `/<protocol>/…`, protocol list including `ipfs` | one **or more** segments of any non-space, non-slash characters. `/ipfs/<cid>`, `/ipfs/<cid>/docs/my-policy_v2.json` |
| `ipfs://…` | **exactly one** path segment, alphanumeric only, with at most one `.extension`. `ipfs://<cid>/policy.json` and `ipfs://<cid>/policy` pass; `ipfs://<cid>`, `ipfs://<cid>/docs/policy.json` and `ipfs://<cid>/my-policy.json` all **fail** |

The `ipfs://` branch is the trap: a hyphen, an underscore or a second path segment fails it while
the same path passes under `/ipfs/…`. Prefer the `/ipfs/…` form.

### 3.5 Test vector — T1

**[computed]**, and **[live]**: this exact payload simulates successfully against
`DisputeResolver` with `extraData` X1 and `value` 0.015 ETH.

```json
{
  "title": "Was the delivery completed as agreed?",
  "description": "The buyer states the package arrived damaged. The seller states it was shipped intact.",
  "question": "Should the escrowed funds be released to the seller?",
  "answers": [
    { "id": "0x1", "title": "Yes", "description": "Release the funds to the seller." },
    { "id": "0x2", "title": "No",  "description": "Return the funds to the buyer." }
  ],
  "policyURI": "/ipfs/QmXFrGGCpTGZq7GTAvxAtNqMEBQ3B3vBGBRTZG5LiwK7Hm",
  "arbitratorChainID": "42161",
  "arbitratorAddress": "0x991d2df165670b9cac3B022f4B68D65b664222ea",
  "version": "1.0"
}
```

Serialised with `JSON.stringify` and no whitespace:

```
utf8 bytes             = 555
keccak256(utf8)        = 0x57c84f487148d5272dc1579c209116d8ea7a057a56b19ef139d0df41fbaf916d
_numberOfRulingOptions = 2
_disputeTemplateDataMappings = ""
total calldata         = 900 bytes
eth_estimateGas        = 698736
```

The keccak hash is not used on chain. It is here so a test can assert the serialisation is
byte-stable — key order, whitespace and escaping included — without embedding the whole string.

**The serialisation MUST be `JSON.stringify` over an object literal with the field order above.**
It is not canonical JSON and does not need to be; it needs to be *reproducible*, and a
re-ordering regression is exactly what this vector catches.

## 4. Evidence

An inline JSON document passed to `submitEvidence`. **Never a bare URI**: a `/ipfs/…` string in
place of the JSON parse-fails in the subgraph and indexes as an unnamed blob.

### 4.1 Fields

From the contracts' own `contracts/specifications/evidence-format.md` and the subgraph handler
(`subgraph/core/src/EvidenceModule.ts`), which agree:

| Field | Required | Notes |
| --- | --- | --- |
| `name` | **yes** | **The field is `name`, not `title`.** A published Kleros documentation page says `title`; it is wrong, and a `title`-keyed document indexes with a null name |
| `description` | **yes** | The body of the evidence |
| `fileURI` | no | Typically `/ipfs/…`. An operator input; never fetched |
| `fileTypeExtension` | no | Read by the subgraph handler. **Not** in the contracts' format specification — subgraph-only |

The subgraph reads exactly these four keys and ignores everything else, so extra keys are harmless
on the consumer side. The CLI's authoring schema **MUST** still reject them, for the reason in §3.2.

### 4.2 The first argument

`submitEvidence(uint256 _externalDisputeID, string _evidence)`.

**The parameter is named `_externalDisputeID`, it is the arbitrable's local dispute ID, and that is
what the CLI passes.** `--dispute` **MUST** still take the **core** dispute ID, and the CLI **MUST**
resolve it to the local one through `DisputeResolver.arbitratorDisputeIDToLocalID` before signing.
The two coincide for every dispute on Arbitrum One today, and only because `DisputeResolver` created
every one of them ([01 §7](./01-onchain-reference.md)). An earlier revision of this section had the
CLI pass the core ID; [ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)
records what that would have cost and what settled it.

**[live]** The contract decides nothing here — it emits its argument and stops. The meaning is
downstream, and downstream keys on the local ID:

- The subgraph's `handleEvidenceEvent` uses the argument verbatim as the `ClassicEvidenceGroup` id,
  and `ensureClassicEvidenceGroup` **creates** that entity on demand. There is no dispute lookup and
  no error path, so an unmatched id becomes a silent orphan group.
- `Dispute.externalDisputeId` is `DisputeResolver`'s `localDisputeID`, and the Kleros Court client
  both lists and submits evidence under that value.
- On the v2 testnet, where the identifiers diverge, **all 47 evidence groups lie in the local range
  4..76 and none in the core-only range 77..126.** Core dispute 126 is local 76; group `76` holds 26
  evidences and group `126` does not exist.

So the harm of a wrong first argument is unreachability, not loss, and there are **two** hard
refusals on this path:

- The CLI **MUST** refuse a core dispute ID that `KlerosCore.disputes()` does not resolve
  (`DISPUTE_NOT_FOUND`), and the error message **SHOULD** say the evidence would be filed where
  nothing can read it, rather than claim the chain would reject it.
- The CLI **MUST** refuse a dispute whose `disputes().arbitrated` is not `DisputeResolver`
  (`DISPUTE_NOT_ADDRESSABLE`), and the message **MUST** name the owning arbitrable. The two codes
  **MUST** stay distinct: a not-found ID may be worth retrying and a foreign one never is.

The CLI **MUST** check `arbitrated` **before** trusting the mapping, and **MUST NOT** treat a
mapping result of `0` as evidence of anything. `arbitratorDisputeIDToLocalID` is a public mapping
getter: it returns the zero default for a key it has never seen rather than reverting, and **[live]**
zero is itself a real local dispute ID — on the v2 testnet, core dispute 0 is local dispute 0. Every
one of that deployment's 50 foreign disputes reads back as `0` and none as a nonzero value.

A failed mapping read is **not** a missing local ID. A public mapping getter cannot revert, so the
CLI **MUST** report it as `DEPLOYMENT_INCONSISTENT` rather than substituting a default.

Neither read may cost a round trip: both take only the core dispute ID, so they **MUST** share the
multicall that fetches the dispute record.

### 4.3 What the CLI must not do with evidence

[ADR-0007](../adr/0007-evidence-is-opaque-operator-supplied-bytes.md), restated normatively:

- The CLI **MUST NOT** parse, interpret, summarise or transform the operator's evidence text beyond
  JSON-encoding it.
- The CLI **MUST NOT** dereference `fileURI`, `policyURI` or any URI found in on-chain data.
- Evidence content **MUST NOT** influence which call is made, against which contract, or with what
  arguments.
- The CLI **MUST NOT** interpolate evidence into any string that is later evaluated, executed, or
  used to build a command.

### 4.4 Test vectors — evidence

**[computed]**. Each is `JSON.stringify` over the object shown, in the field order shown.

#### E1 — text only

```
{"name":"Delivery photographs","description":"The package arrived damaged; see the attached photographs."}

utf8 bytes      = 106
keccak256(utf8) = 0x8314e0c856eabbffdbad22ed6112133b586b998cc2d10cbdb8bbf71d32137cca
```

#### E2 — with an attachment

```
{"name":"Delivery photographs","description":"The package arrived damaged; see the attached photographs.","fileURI":"/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc","fileTypeExtension":"pdf"}

utf8 bytes      = 197
keccak256(utf8) = 0x84cfe72121367ff3afa6132ebcb36ae0474db5e556fe5607c97fd05558358ae3
```

#### E3 — escaping and non-ASCII

Input `name` is `Réponse — 反論`; `description` contains a double quote, a backslash and a newline.

```
{"name":"Réponse — 反論","description":"Quotes \"inside\", a backslash \\ and a newline\nhere."}

utf8 bytes      = 101   (94 UTF-16 code units — the two MUST NOT be conflated)
keccak256(utf8) = 0xc6ec4d8fc8ffaa268bf6573bce5458640da5ef710dce7d4b240fb4f7143dd237
```

E3 exists to catch two regressions at once: an escaping bug, and a length check that counts
JavaScript string length instead of UTF-8 bytes.

#### E4 — the refusal vectors

| Input | Required behaviour |
| --- | --- |
| `{"title":"…","description":"…"}` | **Refuse.** The field is `name` |
| a bare `/ipfs/Qm…` string | **Refuse.** Evidence is inline JSON, not a URI |
| `name` or `description` missing or empty | **Refuse** |
| `policyURI`-style `https://` in `fileURI` | **Accept.** `fileURI` is not constrained to a multiaddr, and it is an operator input |
