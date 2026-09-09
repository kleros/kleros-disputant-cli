# A deployment is not a chain, and `--chain` names one anyway

Status: **accepted**, 2026-09-09. Records the domain model that
`.scratch/testnet-support/` builds on, restates the startup-check ordering of
[03 §7](../spec/03-cli-surface.md), and puts **Deployment** in
[`CONTEXT.md`](../../CONTEXT.md). Extends
[ADR-0006](./0006-deployment-imported-from-contracts-package.md), which settled *where* addresses
come from and assumed there would only ever be one set of them.

## The problem

This repo has used "chain" and "deployment" as one word. It asserts `eth_chainId == 42161`, selects
`mainnetViem` from the contracts package, and treats the first as proof of the second. That holds on
Arbitrum One by accident: exactly one Kleros v2 deployment lives there, so the chain ID happens to
name it.

It does not hold anywhere else, and the accident is about to be load-bearing. The v2 testnet is the
only place the identifier defect of
[ADR-0014](./0014-evidence-is-filed-under-the-local-dispute-id.md) is observable, so this tool has
to be able to name a second address set.

## What a chain ID does not tell you

**[abi]** Chain **421614** hosts at least three Kleros v2 deployments, all resolvable from the
installed `@kleros/kleros-v2-contracts@2.0.0-rc.2`:

| Deployment | Package key | `KlerosCore` |
| --- | --- | --- |
| v2 testnet | `arbitrumSepolia` | `0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479` |
| v2 devnet | `arbitrumSepoliaDevnet` | `0x244e65F833Be5Ab13c20a00EBc40940BD3514d4C` |
| university | `arbitrumSepoliaDevnet`, `…University` entries | `0xAA6D19e1c067D8DaCA4b3995474D64b2b3DA7292` |

Three different arbitrators, three different dispute resolvers, one chain ID. The university set is
not a separate artifact file at all — it shares the devnet's, under suffixed contract names.

Two sources outside the package agree, and neither is a chain read, so neither carries a
verification marker. Upstream's own `getContractsViem` integration test resolves `university` as a
third `deployment` value against the same Arbitrum Sepolia client. And `@kleros/agentkit` reaches
the conclusion from the other side: its `DeploymentName` union admits all three, and its comment
records that **this field, not the chain ID, is what routes between two cores on 421614**.

They are not merely differently addressed, either. **[live]** Measured 2026-09-09, Arbitrum One
block 503 448 113 and Arbitrum Sepolia block 307 153 674: `arbitrableWhitelist(address)`
(`0xb44d573c`) returns `true` for the v2 Beta dispute resolver on the Beta arbitrator, and the same
calldata against the testnet arbitrator **reverts bare** — the function does not exist there. Two
deployments of "the same" contract, one chain apart, with different write surfaces.

So: a chain ID identifies the chain an endpoint is serving. It never identifies the contracts. The
assertion this tool runs at startup proves the first and was being read as proof of the second.

## Decision: `--chain` keeps its name and selects a deployment

The option is `--chain`, alias `-c`, taking `arbitrum-one` or `arbitrum-sepolia-testnet`. It selects
a **deployment**: one address set of the Kleros v2 contracts, with its own ABIs, its own expected
chain ID and its own default endpoint.

**It defaults to `arbitrum-one`, and that default is load-bearing**: every invocation written before
the option existed must keep meaning what it meant. A required flag would silently invalidate every
example, every CTA and every command an agent has already learned.

`--deployment` would be the accurate name and is the wrong one. The primary consumer calls two CLIs:
this one and `@kleros/agentkit`, where the option is `--chain` and the slugs are these slugs. An
agent that has discovered a dispute with one flag name and must act with a different one has been
handed a translation step at exactly the boundary where a mistake spends money. Consistency across
the pair beats local precision, and the imprecision is repaired where repair is cheap: the glossary
says *deployment*, and the `--chain` gloss and every envelope **MUST** say it too.

The slugs already carry the model. `arbitrum-sepolia-testnet` is not the name of a chain; the chain
is `arbitrum-sepolia`. agentkit retired that bare slug precisely because it stopped identifying
anything the moment a second deployment appeared on it, and this repo refuses it by name for the
same reason. The flag name is a chain word; the values are deployment names.

**"mainnet" appears nowhere in user-facing text**, though it is the contracts package's own key for
Arbitrum One. To an agent that also reads agentkit, mainnet is Ethereum. The package's keys are an
implementation detail, mapped exactly once, inside the deployment module.

**"Neo"** stays a technical codename — upstream's suffix for the Arbitrum One contract set, as in
`DisputeKitClassicNeo`. It may appear in a code comment where it names an artifact. It is not a
slug, not a prose name, and never reaches the CLI surface.

## Consequence: the startup ordering inverts

The old invariant was "**no deployment registry lookup before the chain assertion**". It becomes
"**no contract call before the chain assertion**".

The old rule was a proxy for the real one. Resolving an address from a package on disk is a local
act — it opens no socket and reveals nothing. The hazard was never the lookup; it was *using* a
resolved address on an unverified chain. The lookup had to come second only because the deployment
was being inferred **from** the chain ID, which made the assertion's input the lookup's input too.

Now the caller names the deployment, so the order is:

1. Resolve the slug to a deployment. Local; refuses an unserved slug before anything is contacted.
2. Read that deployment's addresses, ABIs and expected chain ID. Local.
3. Assert `eth_chainId` **equals that deployment's expected chain ID**. First network call.
4. Only then, the first contract call.

Nothing is weakened, and the assertion gets stronger: it compares against the selected deployment's
own chain ID rather than a constant.

It still cannot distinguish two deployments on one chain ID, and it does not need to. **An endpoint
does not choose the contracts — the address resolution in step 2 does**, and every deployment on a
chain is reachable from any endpoint serving that chain. A mis-pointed endpoint can therefore only
be wrong about the chain, which is precisely what the assertion catches. The arbitrable's
self-assertion that follows it (`DisputeResolver.arbitrator()` and `.templateRegistry()` against the
resolved addresses, [03 §7](../spec/03-cli-surface.md)) is not a second deployment check: it catches
a stale registry entry or an upstream redeployment.

## What this costs

**A fingerprint test per deployment, and a testnet redeployment breaks the build.** That is the
intended behaviour — a redeployment silently changes where transactions are sent — but it is the one
place this model adds ongoing maintenance, and it is written here so the next failure is not
mistaken for a regression.

**The flag name will keep being questioned.** It is named for a chain and selects a deployment; that
is a real mismatch and no amount of glossary repairs it. The answer is that it is deliberate, that
the reason is a second tool's surface rather than this one's taste, and that it is written down here
so it is questioned once.
