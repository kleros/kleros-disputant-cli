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
> kits are out of scope, and "96 bytes" is a property of the kits in scope rather than of the
> format. A CLI that later adds them **MUST** revisit this section rather than pad the blob.

### 1.1 Validation, before encoding

Every check below is local or a pre-flight read, and every one **MUST** produce a named refusal.
None of them can be delegated to simulation.

| Check | Refuses when | Source |
| --- | --- | --- |
| Court in range | `courtID == 0` or `courtID >= courts.length` | `courts()` reverting past the end |
| Court enabled | `courts(courtID).disabled == true` | `courts()` |
| Juror count | `jurors < 1` | local |
| Kit in range | `kitID == 0` or `kitID >= disputeKits.length` | `disputeKits()` |
| Kit supported | `isSupported(courtID, kitID) == false` | `isSupported()`, **never cached** |
| Kit not a ruler | the resolved kit address is a ruler contract | [01 §1](./01-onchain-reference.md) |
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
`specification`, `aliases`.

| Field | Constraint |
| --- | --- |
| `answers` | `[{ id, title, description, reserved? }]`, `id` matching `/^0x[0-9a-fA-F]+$/` |
| `policyURI` | **A multiaddr** — `/ipfs/…` or `ipfs://…/…`. A plain `https://` URL fails the refinement |
| `arbitratorChainID` | The **string** `"42161"`, not a number |
| `arbitratorAddress` | The `KlerosCore` address from the package, checksummed or not |
| `version` | A string. Free-form; the canonical schema does not constrain it |

Two corrections to earlier drafts, both from the canonical schema:

- **`extraEvidences` is not a field.** It is not in `DisputeDetailsSchema`.
- The canonical schema is a plain `z.object`, so it is **neither** `.strict()` **nor**
  `.passthrough()`: unknown keys are silently stripped when it parses, not rejected. That leniency
  is appropriate for a consumer and wrong for an author.

### 3.2 The authoring schema MUST be strict

The CLI **MUST** hand-write a strict schema and **MUST NOT** validate what it emits with a lenient
parser. [ADR-0010](../adr/0010-a-strict-authoring-schema-not-the-sdk-parser.md)

- Unknown keys **MUST** be rejected, not stripped. A typo'd field name in an operator's template is
  a mistake to surface, not to silently drop into an irreversible paid transaction.
- `@kleros/kleros-sdk` **MUST NOT** become a runtime dependency. Its compiled schema **MAY** be
  imported in a devDependency test, to assert that what the CLI emits is accepted by the canonical
  definition. That test asserts one direction only, and **MUST NOT** be read as asserting the other.

### 3.3 Ruling options

- `0x0` is permanently reserved for "Refuse to Arbitrate / Invalid" and **MUST NOT** appear in the
  `answers` array the CLI submits.
- Submitted IDs **MUST** run from `0x1` upward, normalised as `"0x" + BigInt(id).toString(16)`.
- `_numberOfRulingOptions` **MUST** equal `answers.length`, and **MUST** be at least 2.

Because `0x0` is excluded, the count and the array length agree — that is the whole reason to state
it. A CLI that includes the reserved answer will pass its own arithmetic check and create a dispute
whose options are off by one.

### 3.4 `policyURI`

**[live]** The contract does not check it. A dispute created with a missing or malformed
`policyURI` is created successfully and jurors are still drawn; it renders degraded in the Kleros
Court web client, whose `isTemplateValid` uses the schema above.

The CLI **MUST** enforce the multiaddr form anyway, and **MUST** refuse a plain `https://` URL,
because the failure it prevents is invisible until after the money is spent.

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

**The parameter is named `_externalDisputeID`, and what the CLI passes is the core dispute ID.**
Those are the same number for every dispute on Arbitrum One today
([01 §7](./01-onchain-reference.md)). `--dispute` **MUST** take the core dispute ID.

**[live]** Two facts bound the CLI's freedom here:

- `submitEvidence` succeeds against a core dispute ID that does not exist. The contract does not
  look it up.
- The subgraph does not drop such evidence either: `ensureClassicEvidenceGroup` **creates** the
  grouping entity on demand, so the evidence is indexed under an ID no dispute references and no
  case page will ever query.

So the harm is unreachability, not loss. The CLI **MUST** refuse a core dispute ID that
`KlerosCore.disputes()` does not resolve — it is the one hard refusal on this path — and the error
message **SHOULD** say the evidence would be filed where nothing can read it, rather than claim the
chain would reject it.

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
