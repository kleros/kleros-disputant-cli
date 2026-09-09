# 01. On-chain reference

Everything in this document was read from the deployment artifacts shipped in
`@kleros/kleros-v2-contracts@2.0.0-rc.2` (**[abi]**), computed locally with `viem`
(**[computed]**), or verified by live call against Arbitrum One on 2026-09-08 at block
`503066782` (**[live]**). Markers are defined in the [README](./README.md). A **[live]** claim that
cites its own block was measured later than that; §4.2's matrix is the one such claim today.

## 1. Deployment, Arbitrum One (chain ID 42161)

**[abi]**, cross-checked **[live]**.

| Contract | Address | `version()` | CLI use |
| --- | --- | --- | --- |
| `KlerosCore` | `0x991d2df165670b9cac3B022f4B68D65b664222ea` | `0.10.0` **[live]** | Read only: cost, court, kit support, dispute state |
| `DisputeResolver` | `0xb5526D022962A1fFf6eD32C93e8b714c901F4323` | *no `version()`* **[abi]** | **Write target. Dispute creation** |
| `EvidenceModule` | `0x48e052B4A6dC4F30e90930F1CeaAFd83b3981EB3` | `0.8.0` **[live]** | **Write target. Evidence** |
| `DisputeTemplateRegistry` | `0x0cFBaCA5C72e7Ca5fFABE768E135654fB3F2a5A2` | — | Written to indirectly. `templates()` = 227 **[live]** |
| `PolicyRegistry` | `0x553dcbF6aB3aE06a1064b5200Df1B5A9fB403d3c` | — | Not used in v1 |
| `DisputeResolverRuler` | `0xb3a5FdEAF461c42caCe148e978e6FBCa97bE6140` | — | **Refuse by name** |
| `KlerosCoreRuler` | `0xc0169e0B19aE02ac4fADD689260CF038726DFE13` | — | Not used. A developer tool for arbitrable developers **[maintainer]** |

**[live]** The deployment is internally consistent: `DisputeResolver.arbitrator()` returns the
`KlerosCore` above, and `DisputeResolver.templateRegistry()` returns the registry above. The CLI
**SHOULD** assert both at startup rather than assume the registry entries agree with each other.

`DisputeResolverRuler` is a governance override tool, and **the pinned address is the control**.
There is no runtime refusal: the write target is resolved from the contracts package and its address
is asserted in the fingerprint test, which also asserts that it is not the ruler, so a ruler can only
become the write target through an upstream change that fails the build first. That is a build-time
guarantee, and it is stronger than a runtime check against a value the same source supplied. A
pre-flight check against the resolved *dispute kit* was tried and deleted: a ruler can never be a
dispute kit — KlerosCore's five registered kits are the NULL kit plus four `DisputeKit*` contracts
**[live]** — so it could not fire. `KlerosCoreRuler` is **not** in scope at all: a developer tool for
arbitrable developers **[maintainer]**.

### 1.1 Importing the deployment

Addresses and ABIs **MUST** be imported from `@kleros/kleros-v2-contracts` and **MUST NOT** be
hand-copied. [ADR-0006](../adr/0006-deployment-imported-from-contracts-package.md)

Three mechanical facts, all verified against `2.0.0-rc.2`:

- **Only `./cjs/deployments` can be imported.** The `exports` map declares `.`,
  `./cjs/deployments` and `./esm/deployments`, but **the root and the `esm/` subpath both throw**
  `ReferenceError: exports is not defined in ES module scope` **[computed]** — the `esm/` tree is
  transpiled CommonJS shipped under an `esm/package.json` declaring `"type": "module"`, so Node
  parses it as ESM and finds no named exports. This is a broken upstream build, **not** an
  undeclared export: all three specifiers are declared and one of them works. Paths *below*
  `./cjs/deployments` are genuinely undeclared, which is why the bundler shim reaches leaf modules
  by relative path.
- **`mainnetViem` is a real export of `cjs/deployments`.** It is a namespace object holding
  `klerosCoreAbi`, `klerosCoreAddress`, `klerosCoreConfig`, `disputeResolverAbi`, … Binding to
  `mainnetViem.*Abi` is correct and needs no local shim to invent the name. *(This corrects
  handoff §14.1 — see [Appendix A §3](./appendix-a-unresolved.md).)*
- **`Config.address` and `*Address` are chain-keyed maps, not addresses.** `klerosCoreAddress` is
  `{"42161": "0x991d…"}` and `policyRegistryAddress` has two keys (`100` Gnosis and `42161`).
  Passing either straight to viem fails. Use the package's own `getAddress(config, chainId)`,
  aliased on import so it does not collide with viem's checksumming `getAddress`.

The CLI **MUST** pin an ABI fingerprint test over the entries it binds to, so that an upstream
regeneration from `master` fails the build rather than a transaction. See
[05 §1.6](./05-verification.md).

## 2. ABI provenance: the artifacts are deployed, the Solidity is not

The `.sol` sources in the package — and the **typechain `*__factory` exports compiled from them** —
track upstream **`dev`**, not `master`, and `master` is what is deployed. They disagree with the
deployment for exactly the contracts this tool writes to. The `*Viem` exports shipped alongside them
are the deployed ABIs, and are what this specification cites.

> **The trap is inside one package, not between the package and the chain** **[computed]**, and it
> is reproducible offline:
>
> ```
> EvidenceModule__factory.abi          submitEvidence arg0 = _arbitratorDisputeID   owner()
> mainnetViem.evidenceModuleAbi        submitEvidence arg0 = _externalDisputeID     governor()
> ```
>
> Reading the factory export answers a question about `dev` while appearing to answer one about the
> deployment. It cost an hour on 2026-09-09, when the factory's parameter name was briefly taken as
> evidence against [02 §4.2](./02-payload-construction.md).

Known divergences, all **[abi]**:

| Claim | Package Solidity / `__factory` (`dev`) | Deployed ABI (`*Viem`) |
| --- | --- | --- |
| `DisputeResolver` ownership accessor | `owner()` | **`governor()`**, selector `0x0c340a24` |
| `DisputeResolver` create functions | one | **two** — inline and by URI |
| `DisputeResolver.DisputeRequest` arity | 3 | **5** |
| `DisputeResolver` custom errors | `ShouldBeAtLeastTwoRulingOptions()` and others | **zero** |
| `KlerosCore.arbitrableWhitelistEnabled()` | present | **absent** |

Consequences, normative:

- The CLI **MUST** bind to `mainnetViem.*Abi`, and **MUST NOT** bind to an ABI compiled from the
  package's Solidity — which includes the `*__factory.abi` exports, whose shape is `dev`'s. This
  applies to reading them for evidence as much as to binding: a claim read from a `__factory` is
  **[inferred]** about a branch this repo does not target, never **[abi]**.
- The CLI **SHOULD** read `version()` where the contract offers one and **warn**, never fail, on a
  mismatch. `DisputeResolver` offers none, so no version check is possible for it.
- Revert decoding **MUST** follow §5 exactly, because the divergence lands squarely there.

## 3. Write surface

**[abi]**, with selectors **[computed]** and behaviour **[live]**.

```solidity
// DisputeResolver — permissionless. No whitelist, no owner check.
// selector 0xdc653511 — the path the Kleros Court web client uses, and the only path in v1
function createDisputeForTemplate(
    bytes  _arbitratorExtraData,         // 96 bytes, see 02 section 1
    string _disputeTemplate,             // the template JSON, inline
    string _disputeTemplateDataMappings, // "" for a static template
    uint256 _numberOfRulingOptions       // MUST be >= 2
) external payable returns (uint256 localDisputeID);

// selector 0x908bb295 — specified, not shipped in v1. See section 7 and Appendix A section 2
function createDisputeForTemplateUri(
    bytes _arbitratorExtraData, string _disputeTemplateUri, uint256 _numberOfRulingOptions
) external payable returns (uint256 localDisputeID);

// EvidenceModule — selector 0xa6a7f0eb. NOT payable, NO access control, NO period gate
function submitEvidence(uint256 _externalDisputeID, string _evidence) external;
```

**[abi]** The whole of `EvidenceModule`'s public surface is `governor()`, `initialize`,
`initialize2`, `proxiableUUID`, `submitEvidence`, `upgradeToAndCall` and `version()`. It holds no
reference to `KlerosCore` and reads no dispute state; `submitEvidence` emits an event and returns.
That is the mechanism behind "no access control, no payment and no period gate" — there is nothing
in the contract that *could* gate it.

### 3.1 An EOA cannot call `KlerosCore.createDispute`

**[live]** `eth_call` of `KlerosCore.createDispute(2, extraData)` from an arbitrary EOA, with a
balance state override and the correct value, reverts with raw data `0x203b0c18` —
`ArbitrableNotWhitelisted()`. **[live]** `arbitrableWhitelist(0xb5526D…4323)` is `true` and
`arbitrableWhitelist(<arbitrary EOA>)` is `false`. **[abi]** The deployed core has no
`arbitrableWhitelistEnabled()` toggle, so the whitelist is enforced unconditionally.

The disputant path therefore runs **necessarily** through `DisputeResolver`. The CLI **MUST NOT**
offer a direct-to-core path, and **SHOULD** map `0x203b0c18` to an error that says so.

### 3.2 `msg.value` is forwarded wholesale, and the excess is never returned

`DisputeResolver` forwards `msg.value` to `KlerosCore.createDispute{value: msg.value}`, and the
core derives the panel size from the amount.

The asymmetry is what makes this dangerous:

- **[live]** Sending one wei *less* than `arbitrationCost` reverts with `0x38cd83c4` —
  `ArbitrationFeesNotEnough()`. Underpayment is caught.
- **[live]** Sending **twice** `arbitrationCost` does **not** revert. The call simulates cleanly and
  returns a dispute ID. Overpayment is not caught.

Too little is refused loudly; too much is accepted silently. What the core then *does* with the
excess was **[inferred]** until a fork could be made to show it, because no dispute on Arbitrum One
has ever overpaid, so production carries no sample to read.

**[fork]** Creating with `2 × arbitrationCost` on an Arbitrum One fork, X1 (General Court, three
jurors, Classic, 0.015 ETH):

| Measurement | Exact payment | Double payment |
| --- | --- | --- |
| `msg.value` | `15000000000000000` | `30000000000000000` |
| `getRoundInfo(id, 0).nbVotes` | **3** | **6** |
| `getRoundInfo(id, 0).totalFeesForJurors` | `15000000000000000` | `30000000000000000` |
| Sender's balance, less `gasUsed × effectiveGasPrice` | fell by exactly `msg.value` | fell by exactly `msg.value` |
| Refunded | **0** | **0** |

**The excess is not change. It is a larger panel nobody asked for**, drawn at the operator's
expense, and there is no mechanism that gives it back. A 10× typo in the value buys thirty jurors
and cannot be undone. This is the single most expensive fact in this specification, and it is why
the rule below is *send exactly the quote* rather than *send at least the quote*:

> The CLI **MUST** send exactly `arbitrationCost(extraData)`, quoted with the byte-identical
> `extraData` blob in the same invocation. It **MUST NOT** add a margin, round up, or reuse a
> quote from a previous run.

## 4. Court, kit and cost

### 4.1 Bounds

**[live]**, all four by direct call:

| Fact | Value |
| --- | --- |
| `courts(35)` | reverts — so `courts.length == 35` and court IDs are `0..34` |
| `courts(0)` | does **not** revert; every field reads zero. This is the Forking Court |
| `disputeKits(5)` | reverts — so `disputeKits.length == 5` and kit IDs are `1..4` |
| `disputeKits(0)` | the zero address |
| Courts with `disabled == true` | **none**, across IDs 1–34 |

**[live]** Dispute kit IDs, resolved to addresses:

| ID | Kit | Address |
| --- | --- | --- |
| 1 | Classic | `0x70B464be85A547144C72485eBa2577E5D3A45421` |
| 2 | Shutter | `0x9D3e3f1765744c2a1BC6F6088549770444BBC768` |
| 3 | Gated | `0xaE1eed20C125B739b64c948820C61F809ad9a925` |
| 4 | GatedShutter | `0x788330092B9704809C19858E39EB9Ac402c2E47b` |

**Court 0 is never a valid target.** It reverts nothing and reads all-zero, and the decoder maps it
to the General Court. The CLI **MUST** refuse `--court 0` locally.

### 4.2 Kit support is per court, and narrower than the documentation says

**[live]**:

```
isSupported(1, 1) = true      isSupported(2, 1)  = true
isSupported(1, 2) = false     isSupported(29, 1) = true
isSupported(1, 3) = false     isSupported(34, 1) = true
isSupported(1, 4) = false
```

**The General Court supports only Classic on Arbitrum One**, contradicting the published
documentation's claim that it supports all four. Classic is the only realistic v1 target.

The full matrix, **[live]** at block `503203767` (2026-09-09T01:10:11Z), 140 `isSupported` calls
over every court and kit that exists, all pinned to that one block:

```
courts 1..34 exist, none disabled.   getDisputeKitsLength() = 5, so kits are 1..4.

every court 1..34 ....... kit 1        court 24 .... kits 1, 2, 3
court 0 (the sentinel) .. no kit       court 32 .... kits 1, 3
                                       kit 4 ....... no court at all
```

Three facts worth separating, because only one of them is durable:

1. **Kit 1 is supported by every court**, so `--kit 1` is the request that cannot fail this check.
2. **Support for anything else is per court**, and two courts have it. A refusal therefore says
   something about the *pairing*, not about the kit — a message that explains it by naming the
   General Court is wrong for any other court.
3. **This table is a snapshot and nothing signals when it stops being true.** Kit support is
   governance-controlled: a court can gain or lose a kit with no event this tool watches, no
   version bump, and no change to any ABI the fingerprint test pins. Do not build on the matrix.
   Build on the rule below, which is why it is a **MUST**.

The CLI **MUST** call `isSupported` on every invocation and **MUST NOT** cache it, across process
boundaries or within one. The re-read is the whole defence; the matrix above is only evidence that
the shape of the answer is per court rather than global.

An unsupported kit **does** revert — `0xb34eb75d`, `DisputeKitNotSupportedByCourt()`,
confirmed **[live]** by simulating a create with `extraData` naming court 1 and kit 2. It is the
one `extraData` mistake simulation catches. The CLI **MUST** still check it locally first, so the
failure carries a named code rather than a decoded selector, and **MUST** call `isSupported` on
every invocation rather than cache a table — court configuration is governance-mutable.

### 4.3 The arbitration cost is exactly `feeForJuror × jurors`

**[live]**, across four courts:

| Court | `feeForJuror` | Jurors | `arbitrationCost(extraData)` |
| --- | --- | --- | --- |
| 1 (General) | 0.005 ETH | 3 | **0.015 ETH** = `15000000000000000` wei |
| 1 | 0.005 ETH | 1 | 0.005 ETH |
| 1 | 0.005 ETH | 15 | 0.075 ETH |
| 2 | 0.0069 ETH | 5 | **0.0345 ETH** |
| 29 | 0.0054 ETH | 7 | **0.0378 ETH** |
| 34 | 0.00027 ETH | 3 | **0.00081 ETH** |

The relation holds exactly in every sample. The CLI **MAY** use it to explain a quote in prose, and
**MUST NOT** use it to compute one: the quote **MUST** come from `arbitrationCost`.

**[live]** The ERC-20 quote is inconsistent with the ETH quote by a factor of ten —
`arbitrationCost(extraData, WETH)` returns `0.15` for the same dispute that costs `0.015` in ETH.
The ERC-20 path is out of scope. [ADR-0008](../adr/0008-arbitration-fees-are-paid-in-eth-only.md)

### 4.4 The decoder substitutes defaults and never reverts

The deployed `KlerosCore._extraDataToCourtIDMinJurorsDisputeKit` reads three words at offsets
`0x20`, `0x40` and `0x60` when `_extraData.length >= 64`, and clamps each:

```solidity
if (_extraData.length >= 64) {
    assembly { courtID := mload(add(_extraData,0x20)); minJurors := mload(add(_extraData,0x40));
               disputeKitID := mload(add(_extraData,0x60)); }
    if (courtID == FORKING_COURT || courtID >= courts.length) courtID = GENERAL_COURT;
    if (minJurors == 0) minJurors = DEFAULT_NB_OF_JURORS;
    if (disputeKitID == NULL_DISPUTE_KIT || disputeKitID >= disputeKits.length)
        disputeKitID = DISPUTE_KIT_CLASSIC;
} else { courtID = GENERAL_COURT; minJurors = DEFAULT_NB_OF_JURORS; disputeKitID = DISPUTE_KIT_CLASSIC; }
```

*(Source shape **[inferred]**; every consequence below is **[live]**.)*

**[live]** Nine probes, each quoting `arbitrationCost`. All nine return **0.015 ETH** — General
Court, three jurors, Classic — with no revert and no warning:

| Probe | Length | Quote |
| --- | --- | --- |
| `0x` (empty) | 0 | 0.015 ETH |
| `encodePacked(uint96 1, uint256 3)` — the encoding the published Kleros documentation gives | 44 | 0.015 ETH |
| `encodePacked(uint96 2, uint256 5)` — a *different* court, same result | 44 | 0.015 ETH |
| two-word ABI encoding | 64 | 0.015 ETH |
| court `0`, 3 jurors, kit 1 | 96 | 0.015 ETH |
| court `99` (out of range), 3 jurors, kit 1 | 96 | 0.015 ETH |
| court 1, **0 jurors**, kit 1 | 96 | 0.015 ETH |
| court 1, 3 jurors, kit `0` | 96 | 0.015 ETH |
| court 1, 3 jurors, kit `99` | 96 | 0.015 ETH |

The two 44-byte rows are the important ones: **the published Kleros arbitrable guide and production
checklist are wrong**, in a way that costs money silently. Anyone who follows them pays for a
General Court dispute no matter which court they asked for.

Normative consequences:

- The CLI **MUST** validate `1 <= courtID < courts.length` and `courts(courtID).disabled == false`
  before building `extraData`, and **MUST** refuse rather than let the fallback fire.
- The CLI **MUST** validate `jurors >= 1` and `1 <= disputeKitID < disputeKits.length`.
- The CLI **MUST NOT** emit a blob shorter than 96 bytes. In particular it **MUST NOT** emit a
  64-byte blob: the length guard is `>= 64` while the decoder reads to `0x60`, so a 64-byte blob is
  read past its end. The bounds checks sanitise the garbage unless it happens to land in
  `[1, 5)` — narrow, but not zero.
- The CLI **MUST** echo the **effective** court, juror count and kit, read back from chain state,
  and **MUST** treat any difference from the requested values as an error.

## 5. Revert conditions

**Decoding is not uniform, and this is the trap.** `DisputeResolver` carries zero custom errors
**[abi]**, but that does not mean its reverts are anonymous: its own failures are `require`
statements with reason strings, while the failures it *forwards* from `KlerosCore` arrive as bare
4-byte selectors that are named in `klerosCoreAbi` but not in `disputeResolverAbi`.

**[live]**, every row observed by `eth_call` against the live contracts with a balance override:

| Condition | Target | Raw data | Decodes as |
| --- | --- | --- | --- |
| `_numberOfRulingOptions < 2` | `DisputeResolver` | `0x08c379a0…` | `Error(string)`: `"Should be at least 2 ruling options."` |
| Kit not supported by court | `DisputeResolver` → core | `0xb34eb75d` | `DisputeKitNotSupportedByCourt()`, in `klerosCoreAbi` |
| `msg.value < arbitrationCost` | `DisputeResolver` → core | `0x38cd83c4` | `ArbitrationFeesNotEnough()`, in `klerosCoreAbi` |
| EOA calls the core directly | `KlerosCore` | `0x203b0c18` | `ArbitrableNotWhitelisted()`, in `klerosCoreAbi` |

Normative:

- `reverts.ts` **MUST** map **by selector**, over a table that spans `klerosCoreAbi` *and*
  `disputeResolverAbi`, because viem given only the call target's ABI will fail to name a core
  error forwarded through `DisputeResolver`.
- `reverts.ts` **MUST** also decode `Error(string)` (`0x08c379a0`), because `DisputeResolver`'s own
  guards are `require` strings.
- The CLI **MUST NOT** rely on `ShouldBeAtLeastTwoRulingOptions()` (`0x5fea5b86` **[computed]**).
  That error exists in the package's Solidity and is **not** what the deployment emits.
- Unmapped revert data **MUST** be surfaced verbatim under a stable code rather than swallowed.

**[fork]** All four rows were re-forced on a fork and decoded by `reverts.ts` itself, so what is
verified is not merely the raw data the chain returns but the sentence the operator receives
([05 §2.6](./05-verification.md)). Reaching the first three at all means bypassing a guard that
exists to prevent them: the template schema will not build a one-option dispute, pre-flight refuses
an unsupported kit before the chain is asked, and the value is always the quote.

## 6. Events

**[abi]**, topic hashes **[computed]**.

| Event | Emitter | Topic 0 |
| --- | --- | --- |
| `DisputeCreation(uint256 indexed _disputeID, address indexed _arbitrable)` | `KlerosCore` | `0x141dfc18aa6a56fc816f44f0e9e2f1ebc92b15ab167770e17db5b084c10ed995` |
| `DisputeRequest(address indexed _arbitrator, uint256 indexed _arbitratorDisputeID, uint256 _externalDisputeID, uint256 _templateId, string _templateUri)` | `DisputeResolver` | `0x8bd32f430ff060e6bd204709b3790c9807987263d3230c580dc80b5f89e27186` |
| `DisputeTemplate(uint256 indexed _templateId, string indexed _templateTag, string _templateData, string _templateDataMappings)` | `DisputeTemplateRegistry` | `0x00f7cd7255d1073b4e136dd477c38ea0020c051ab17110cc5bfab0c840ff9924` |
| `Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence)` | `EvidenceModule` | `0x39935cf45244bc296a03d6aef1cf17779033ee27090ce9c68d432367ce106996` |

**[live]** All 216 `DisputeRequest` logs ever emitted by `DisputeResolver` correspond one-to-one
with the 216 `DisputeCreation` logs `KlerosCore` has ever emitted. **[fork]** A create on a fork
puts all three in **one receipt**, emitted by `KlerosCore`, `DisputeResolver` and
`DisputeTemplateRegistry` respectively — the log correspondence above is consistent with three
separate transactions, and this is not.

The CLI **MUST** take the core dispute ID from `KlerosCore.DisputeCreation`, and **MUST NOT** take
it from the function's return value. See §7.

## 7. The three dispute IDs

Three numbers name the same dispute, and on Arbitrum One today they are all equal:

| Name | Where it lives | What it is |
| --- | --- | --- |
| **core** dispute ID | `KlerosCore.disputes`, `DisputeCreation._disputeID` | The arbitrator's index. **What this CLI reports and what `--dispute` takes** |
| **local** dispute ID | `DisputeResolver.disputes`, `DisputeRequest._externalDisputeID` | The arbitrable's own index, mapped back by `arbitratorDisputeIDToLocalID` |
| the function's **return value** | `createDisputeForTemplate` | See below |

The equality is a coincidence of this deployment, and it is total:

| Measurement | Value |
| --- | --- |
| `KlerosCore.disputes.length` | **216** **[live]** |
| `DisputeResolver.disputes.length` | **216** **[live]** |
| `DisputeCreation` logs on `KlerosCore`, all time | **216**, **every one** naming `DisputeResolver` as the arbitrable **[live]** |
| `DisputeRequest` logs where `_arbitratorDisputeID != _externalDisputeID` | **0 of 216** **[live]** |
| `arbitratorDisputeIDToLocalID(n)` for sampled `n` | `n`, for every sample **[live]** |

**`DisputeResolver` has created every dispute that exists on Kleros v2 Arbitrum One.** No other
arbitrable has ever called `createDispute` there. That is why core, local and external IDs coincide
for all 216, and why **no test against production can distinguish them**. The first dispute created
by any other arbitrable breaks the coincidence permanently and silently.

#### What a seeded fork shows

**[fork]** On a fork where another arbitrable is whitelisted and creates three disputes, the
coincidence breaks and the three numbers separate for the first time. Creating through
`DisputeResolver` immediately afterwards:

| Measurement | Value |
| --- | --- |
| `DisputeCreation._disputeID` | **224** — the core dispute ID |
| `createDisputeForTemplate` return value | **224** |
| `DisputeRequest._arbitratorDisputeID` | **224** |
| `DisputeRequest._externalDisputeID` | **220** |
| `arbitratorDisputeIDToLocalID(224)` | **220** |
| `DisputeResolver.disputes(220)` | the dispute, carrying X1's `extraData` and two ruling options |
| `DisputeResolver.disputes(224)` | **reverts** — the local array is shorter than the core ID |

Two corrections follow, and both were invisible from production:

- **`createDisputeForTemplate` returns the CORE dispute ID, not the local index.** An earlier
  reading of this section had it the other way round, from the observation that a simulated create
  returned `216` and `DisputeResolver.disputes.length` was also `216` — true, and unable to tell the
  two apart. It is the core ID. **This changes nothing the CLI does**: it never reads the return
  value, and taking the ID from `DisputeCreation` is right either way. It is recorded because the
  opposite claim was believed, is quotable, and would mislead the next reader.
- **`DisputeRequest._externalDisputeID` is the arbitrable's local index**, confirming
  [Appendix A §2](./appendix-a-unresolved.md) claim 2, which that appendix called unobservable in
  production.

Normative:

- The CLI **MUST** parse `DisputeCreation._disputeID` for the core dispute ID it reports, and
  **MUST NOT** report the function return value as the core dispute ID. The two agree today
  **[fork]**, so this is no longer a correctness fix — it is a provenance rule: the log is
  `KlerosCore`'s own statement of the ID it assigned, and the return value is `DisputeResolver`
  relaying it. Only one of the two stays right if the relay changes.
- `--dispute` **MUST** be documented and treated as the **core** dispute ID, and the CLI **MUST NOT**
  report a local dispute ID to a caller.
- The CLI **MUST NOT** implement any behaviour that depends on local and external IDs being equal.
  `submitEvidence` was such a behaviour until 2026-09-09; it now resolves the core dispute ID to the
  local one before signing ([02 §4.2](./02-payload-construction.md),
  [ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)).

> **Settled, 2026-09-09.** This paragraph previously carried the **[client]** caveat below and
> called it "the single weakest link between this tool and the Court UI". It was, and the CLI was on
> the wrong side of it. The Kleros Court client looks evidence up by the subgraph's
> `dispute.externalDisputeId` — the third field of `DisputeRequest`, which is the local index — and
> submits under the same value (`web/src/pages/Cases/CaseDetails/Evidence/index.tsx`,
> `web/src/hooks/queries/useEvidences.ts`).
>
> **[live]** What upgraded the claim was not the UI but the index. On the v2 testnet, where the
> identifiers diverge, all 47 `ClassicEvidenceGroup` ids lie in the local range 4..76 and none in the
> core-only range 77..126: core dispute 126 is local 76, group `76` holds 26 evidences, and group
> `126` does not exist. Evidence filed under a core ID above the local range is not filed against the
> dispute at all.
>
> The CLI now resolves core → local before signing
> ([ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)). Note the direction of
> travel in [§7.1](#71-evidencegroupid--a-v1-inheritance-being-removed): upstream intends to move
> back to the core ID, in the **indexer**, and that reversal is tracked there.

### 7.1 `evidenceGroupID` — a v1 inheritance being removed

**[maintainer]** The first argument of `submitEvidence` is inherited from Kleros v1, where it was
an *evidence group ID*. It existed to correlate evidence submitted **before** a dispute was created
— in that case there is no dispute ID yet to key on. That case proved unnecessary in practice and
the field carried substantial complexity, so it was **removed in the devnet deployment**. Beta
(Arbitrum One) and testnet still inherit it. It is one of the few beta/devnet incompatibilities.

The rename is already visible in the deployment artifacts **[abi]**:

| Deployment export | Chain | `submitEvidence` first parameter | Admin function |
| --- | --- | --- | --- |
| `mainnetViem` — beta, what this CLI targets | 42161 | `uint256 _externalDisputeID` | `governor()` |
| `testnetViem` | 421614 | `uint256 _externalDisputeID` | `governor()` |
| `devnetViem` | 421614 | `uint256 _arbitratorDisputeID` | `owner()` |

**The rename is invisible to a signature fingerprint** **[computed]**. Both shapes are
`submitEvidence(uint256,string)`, selector `0xa6a7f0eb`, and both emit
`Evidence(uint256,address,string)`, topic0
`0x39935cf45244bc296a03d6aef1cf17779033ee27090ce9c68d432367ce106996`. Only the ABI's *parameter
name* differs, and a selector is not derived from parameter names. A fingerprint test that pins the
selector alone would pass unchanged against a beta upgraded to the devnet shape, while the meaning
of the argument had moved underneath it — so [05 §1.6](./05-verification.md) pins the parameter
name as well.

Note also that **a chain ID does not identify a deployment**: testnet and devnet are both 421614.
That is a second, independent reason [03 §7](./03-cli-surface.md) asserts 42161 and then selects
`mainnetViem` explicitly, rather than resolving a deployment from the chain ID.

**[inferred]** The rename lives on upstream `dev`, not on `master`, and `master` is what is deployed
to both Arbitrum One and the v2 testnet — each reports `EvidenceModule.version()` `0.8.0`, which is
`master`'s constant. The contract half of the change is **cosmetic**: `dev`'s `submitEvidence` body
still only emits its argument, and the selector is unchanged.

The substantive half is in the **indexer**. `dev` deletes `ClassicEvidenceGroup`, attaches evidence
to the `Dispute` entity keyed by the core dispute ID, and **drops** evidence whose id matches no
dispute, with a logged error. Neither chain this specification covers runs it: both subgraphs still
answer `classicEvidenceGroups` and neither knows a `Dispute.evidenceCount` field **[live]**.

So the two identifiers swap places when that indexer ships, and the current behaviour becomes wrong
in the opposite direction — from unreachable to discarded.

Normative:

- `--dispute` **MUST** remain the core dispute ID. That rule is right before and after the change:
  today it is resolved to the local ID before signing ([02 §4.2](./02-payload-construction.md)), and
  after the change it will be passed through.
- The CLI **MUST NOT** expose an evidence-group concept in its surface or its vocabulary. It is
  being deleted upstream.
- [05 §1.6](./05-verification.md)'s pin on the parameter **name** is the tripwire for the reversal,
  and it fires on the ABI — which changes before the subgraph does. A failure there **MUST** send the
  reader to [ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md) before shipping,
  not to the code.

## 8. Read surface for pre-flight

Only reads that can change the decision to sign belong here — and one that decides *what* is
signed ([ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)). **[abi]**,
selectors **[computed]**.

| Call | Contract | Used for |
| --- | --- | --- |
| `eth_chainId` | — | The chain assertion. **Runs before every registry lookup** |
| `courts(uint256) → (parent, hiddenVotes, minStake, alpha, feeForJuror, jurorsForCourtJump, disabled)` | `KlerosCore` | Court exists, is not disabled, and the fee that explains the quote |
| `isSupported(uint96, uint256) → bool` | `KlerosCore` | Kit is enabled in that court. **Never cached** |
| `arbitrationCost(bytes) → uint256` | `KlerosCore` | The exact value to send. **Overloaded** — see below |
| `disputes(uint256) → (courtID, arbitrated, period, ruled, lastPeriodChange)` | `KlerosCore` | The dispute exists; its period, for the evidence warning; and **`arbitrated`, which gates the call below** |
| `arbitratorDisputeIDToLocalID(uint256) → uint256` | `DisputeResolver` | **The identifier `submitEvidence` is given** ([02 §4.2](./02-payload-construction.md)). Shares the `disputes` multicall. A public mapping getter, so it returns `0` rather than reverting for a dispute another arbitrable created — `arbitrated` **MUST** be checked first |
| `getTimesPerPeriod(uint96) → uint256[4]` | `KlerosCore` | **Court existence** (it reverts past the end of the array), and the period deadline for the evidence warning |
| `version()` | `KlerosCore`, `EvidenceModule` | A **warning** on mismatch, never a failure |
| `getBalance` | — | `INSUFFICIENT_BALANCE`, which **MUST** include `value` |
| `getBlock().timestamp` | — | **Chain time.** `Date.now()` **MUST NOT** be used for deadline arithmetic |

**[live]** There is **no courts-length call.** KlerosCore's ABI has `getDisputeKitsLength()` and no
equivalent for courts, and Solidity generates no length getter for a public array, so court
existence **MUST** be established by probing `getTimesPerPeriod(courtID)`, which reverts past the
end. It reverts with a **decodable** `Array index is out of bounds.` panic where `courts(n)` reverts
with no reason at all, so it is also the better diagnosis. Verified against Arbitrum One: courts 1
and 34 resolve, 35 and 99999 revert. A consequence the CLI **MUST** accept is that no refusal can
quote an upper bound — there is nothing to read one from, and `kleros court list` is the hint.

**[abi]** `arbitrationCost` is **overloaded**: `arbitrationCost(bytes)` and
`arbitrationCost(bytes,address)`, the second taking a fee token. That second form is the ERC-20 path
[ADR-0008](../adr/0008-arbitration-fees-are-paid-in-eth-only.md) leaves unresolved, and there is no
flag that can reach it. viem selects an overload by argument count, so calling with a single
argument is correct — but an ABI that dropped the one-argument form would silently retarget the
quote at the token path, so [05 §1.6](./05-verification.md) pins both overloads.

**[live]** A non-existent core dispute ID makes `disputes(n)` revert — an array out-of-bounds
panic, not a named error. The CLI **MUST** convert that into a readable `DISPUTE_NOT_FOUND`
rather than surface a decoding failure.

## 9. Periods and the evidence window

`disputes()` returns `period` as a `uint8` over `evidence, commit, vote, appeal, execution`, and
`getTimesPerPeriod(courtID)` returns four durations. The nominal deadline is
`lastPeriodChange + timesPerPeriod[period]`.

**The deadline is an upper bound, never an entitlement.** A period can end early and `passPeriod`
is permissionless. Deadline arithmetic **MUST** use chain time.

**[live]** Evidence-period lengths across courts 1–34 span three orders of magnitude:

| Court | Evidence period |
| --- | --- |
| 34 (Agentic Commerce) | **600 s — ten minutes** |
| 29, 32 | 21 600 s (6 h) |
| 1 (General) | 280 800 s (3.25 days) |
| 24 | 540 000 s (6.25 days) |

Eight distinct lengths are in use. A fixed warning threshold in seconds would be meaningless across
that range, so the CLI **SHOULD** express evidence-period pressure as a fraction of the court's own
`timesPerPeriod[0]`.

**[live]** `submitEvidence` is not gated on any of this: it succeeds by `eth_call` against a
dispute in the `execution` period, and against a core dispute ID that does not exist at all. Any
period discipline is this CLI's policy, and it **MUST** warn rather than refuse.
[ADR-0011](../adr/0011-evidence-period-pressure-warns-and-never-refuses.md)

## 10. Gas and fee environment

Arbitrum One. Carried over from the juror CLI's transaction path, which is the sibling write plane:

- Gas estimates are multiplied by `150/100` before use.
- `MAX_FEE_MULTIPLIER = 3n` caps the fee escalation.
- `maxPriorityFeePerGas: 0n` — tips are ignored on Arbitrum, and zero states that plainly.
- `confirmations: 1` is the right notion of done on an L2 with immediate soft finality, and
  `onReplaced` does not fire above 1.

The balance check **MUST** be `balanceWei < estimatedFeeWei + value`, not
`balanceWei < estimatedFeeWei`. See [04 §2](./04-transaction-relaying.md).
