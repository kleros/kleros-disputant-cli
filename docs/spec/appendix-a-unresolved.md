# Appendix A. Unresolved, unverified, and corrected

Three registers. §1 and §2 are claims this specification depends on but has **not** verified — do
not build on them without a fork test. §3 lists claims in `HANDOFF_DISPUTANT_CLI.md` §14 that this
specification **corrects**, because each one is something a reader may already believe.

## 1. Blocked: do not build these

### 1.1 The ERC-20 fee path

**[live]** `arbitrationCost(extraData, WETH)` returns `0.15` for a dispute that costs `0.015` in
ETH — a 10× discrepancy — with `currencyRates(WETH) = (feePaymentAccepted: true, rateInEth: 1,
rateDecimals: 1)`. Either the rate is misconfigured on chain or the conversion runs backwards. The
deployed `KlerosCore` 0.10.0 uses `currencyRates` while `master` delegates to a `RatesConverter`,
so the formula could not be read from the source that matters.

**Ship ETH-only.** There is no `--fee-token` flag, so the broken path cannot be asked for.
[ADR-0008](../adr/0008-arbitration-fees-are-paid-in-eth-only.md)

Resolving it needs the verified deployed source from Arbiscan, plus a fork test that sends an
ERC-20 fee and asserts the panel size — not just that the call succeeds.

### 1.2 `createDisputeForTemplateUri`

**[live]** Of the 216 `DisputeRequest` logs ever emitted on Arbitrum One, **zero** carry a non-empty
`_templateUri`. Every dispute in existence used the inline path. Nothing about the URI path's
behaviour has been observed — only its ABI is known.

`--template-uri` is specified in [03 §2](./03-cli-surface.md) and **MUST NOT** ship in v1.

## 2. Unverified claims this specification carries

| # | Claim | Marker | How it gets settled |
| --- | --- | --- | --- |
| 1 | **Excess `msg.value` is not refunded** and buys extra jurors, via `round.nbVotes = _feeAmount / feeForJuror` | **[inferred]** from `master` source | Fork test [05 §2.2 and §2.3](./05-verification.md). **The most expensive unverified claim here** |
| 2 | `_externalDisputeID` in `DisputeRequest` is the arbitrable's local index rather than the arbitrator's dispute ID | **[inferred]** | Verified deployed source from Arbiscan. **Unobservable in production** — all 216 disputes have them equal **[live]** |
| 3 | The Kleros Court web client resolves evidence by `dispute.externalDisputeId`, so passing the core dispute ID is only correct while the two coincide | **[client]** | Read the deployed `DisputeResolver` source; then decide whether `--dispute` needs a second form |
| 4 | The `KlerosCore` `extraData` decoder has the shape quoted in [01 §4.4](./01-onchain-reference.md) | **[inferred]**; every *consequence* is **[live]** | Verified deployed source. Low priority: the behaviour is confirmed nine ways |
| 5 | `DisputeCreation`, `DisputeRequest` and `DisputeTemplate` all land in one transaction | **[inferred]**, strongly supported by 216 matched log pairs **[live]** | Fork test asserting all three in one receipt |

Claim 1 is why [02 §2](./02-payload-construction.md) says *send exactly the quote* rather than
*send at least the quote*. The rule holds whichever way the claim resolves, which is the point of
stating it that way.

Claim 2 deserves emphasis. **`DisputeResolver` has created every dispute that exists on Kleros v2
Arbitrum One** — 216 of 216, no other arbitrable has ever called `createDispute` there **[live]**.
So core, local and external dispute IDs are numerically identical everywhere, and **no test against
production can distinguish them**. The first dispute created by any other arbitrable breaks the
coincidence, silently, for everyone who assumed it.

## 3. Corrections to `HANDOFF_DISPUTANT_CLI.md` §14

Each row is a claim in the handoff that this specification supersedes. They are listed because
`CLAUDE.md` and `CONTEXT.md` were written from §14, and two of them are load-bearing there.

### 3.1 `mainnetViem` exists in the package

§14.1 says there is "**no `mainnetViem` namespace object** in the package — that name exists only
because `build/kleros-deployments.mjs` creates it".

**Wrong for `2.0.0-rc.2`.** `mainnetViem` is a real named export of `cjs/deployments`, holding
`klerosCoreAbi`, `klerosCoreAddress`, `klerosCoreConfig`, `disputeResolverAbi` and the rest. The
package also exports `getAddress(config, chainId)`. The shim is still needed for **bundling**
([ADR-0006](../adr/0006-deployment-imported-from-contracts-package.md)), but not to invent the
name. Verified **[abi]**.

### 3.2 `DisputeResolver` reverts with a string, not an anonymous selector

§14.2 says `ShouldBeAtLeastTwoRulingOptions()` "exists in the rc.2 *source*, but the deployed
`disputeResolverAbi` carries **zero** custom errors. A live revert surfaces as raw data with no
name."

**Half wrong, and the wrong half matters.** The ABI does carry zero custom errors **[abi]**. But
**[live]**, a create with one ruling option reverts with `0x08c379a0…` — a standard
`Error(string)` reading `"Should be at least 2 ruling options."`. `DisputeResolver`'s own guards
are `require` statements, which viem decodes without help.

What *does* arrive as a bare selector is a `KlerosCore` error forwarded through `DisputeResolver` —
`0xb34eb75d`, `0x38cd83c4` — and those **are** named, in `klerosCoreAbi`, just not in the ABI of
the contract that was called.

So `reverts.ts` needs **both**: an `Error(string)` decoder, and a selector table spanning both
ABIs. `CLAUDE.md`'s "a live revert arrives as raw data with no name" is true only of the forwarded
errors. See [01 §5](./01-onchain-reference.md).

### 3.3 The subgraph does not drop evidence for an unknown dispute

§14.5 says the subgraph "does `Dispute.load(coreDisputeID.toString())` and **drops the evidence on
the floor** if no such dispute exists". `CLAUDE.md` repeats it as the justification for the one
hard refusal on the evidence path.

**Wrong mechanism.** `subgraph/core/src/EvidenceModule.ts` calls `ensureClassicEvidenceGroup`,
which **creates** the grouping entity when it is missing. The evidence is indexed — under an ID
that no dispute references and no case page queries.

The refusal is still right; the reason is unreachability, not loss. The error message **MUST** say
so, because "the chain would reject it" is false and an agent may act on it.
See [02 §4.2](./02-payload-construction.md).

### 3.4 `extraEvidences` is not a template field

§14.6 lists `extraEvidences` among the optional fields. It is **not** in the canonical
`DisputeDetailsSchema`. The optional set is `attachment`, `frontendUrl`, `metadata`, `category`,
`lang`, `specification`, `aliases`.

Related: the canonical schema is a plain `z.object`, so it is neither `.strict()` nor
`.passthrough()` — it **strips** unknown keys silently. That is a further argument for
[ADR-0010](../adr/0010-a-strict-authoring-schema-not-the-sdk-parser.md), not against it.

### 3.5 `createDisputeForTemplate` returns the local dispute ID

§14 does not say what the function returns, and the omission is dangerous: the obvious reading is
that it returns the dispute ID you want.

**[live]** It returns `DisputeResolver`'s own `disputes.length` — the local dispute ID. Today that
equals the core dispute ID, because of the coincidence in §2. The CLI **MUST** parse
`DisputeCreation` instead. See [01 §7](./01-onchain-reference.md).

### 3.6 Underpayment reverts — a fact §14 does not record

**[live]** `msg.value` one wei below `arbitrationCost` reverts with `ArbitrationFeesNotEnough()`,
`0x38cd83c4`. Overpayment does not revert. The asymmetry is worth stating because it tells you
which direction the chain protects you in, and which one it does not.

### 3.7 `fileTypeExtension` is subgraph-only

§14.5 presents `{ name, description, fileURI?, fileTypeExtension? }` as the evidence schema. The
contracts' own `contracts/specifications/evidence-format.md` specifies only `name`, `description`
and `fileURI`; `fileTypeExtension` appears in the subgraph handler and the subgraph schema. It is
safe to emit and is read by the indexer — it simply is not in the format specification.

## 4. Open design questions

Not defects. Decisions this specification deliberately leaves to the implementation.

1. **Should `--dispute` accept a local dispute ID at all?** Today it cannot matter. It will, once
   another arbitrable creates a dispute. Deciding now costs nothing; deciding later costs a
   breaking change to the option's meaning.
2. **Where does the cost ceiling default sit?** [03 §3.2](./03-cli-surface.md) requires
   `--max-cost-eth` but does not fix a default. Court costs on Arbitrum One span 0.00081 to 0.075
   ETH for realistic panels **[live]**, so any default is a policy choice about which courts are
   reachable without an explicit override.
3. **How is evidence-period pressure expressed?** [01 §9](./01-onchain-reference.md) rules out a
   fixed second count — the periods span 600 s to 540 000 s. A fraction of the court's own
   `timesPerPeriod[0]` is the obvious replacement, but the threshold is unchosen.
