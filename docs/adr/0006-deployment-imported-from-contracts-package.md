# Addresses and ABIs come from the contracts package, bundled at build time

`src/core/deployment.ts` imports the five Arbitrum One addresses and every ABI this tool binds to
from `@kleros/kleros-v2-contracts`, rather than hand-pinning fragments.

`kleros-juror-cli` reached this position by reversal: its ADR-0005 hand-pinned addresses and
fourteen ABI fragments as the cautious first move, and its ADR-0006 replaced that with the package
import. **This repo starts at the end state**, so there is no ADR-0005 here and the number stays
unused. The reasoning that made the reversal correct is worth restating, because it is what makes
the import safe rather than merely convenient.

## Why hand-pinning is the wrong caution

The requirement it was protecting is real: bind to the **deployed** ABI, never one compiled from
`master`. What the cautious reading got wrong is the conclusion — the package ships the deployed
artifacts, not `master`. The proof is the test itself: a fingerprint test asserting properties of
the deployed contracts can be pointed at the package's ABI just as well as at a local copy, and a
package regenerated from `master` then fails the build exactly as a drifted copy would. The canary
does not go away; it moves from guarding a copy to guarding the import.

Addresses were never the concern at all. Verifying that a *configured* address is the contract you
think it is is a constraint on verification, not on provenance.

## The fingerprints are not optional here

> The package's `.sol` sources are compiled from `master` and are **not the deployed code**, and
> they diverge for exactly the contracts this tool needs.

The deployed `DisputeResolver` exposes `governor()` — there is no `owner()` selector in the
bytecode — has **both** create functions, and emits a **5-argument** `DisputeRequest`; the source
has `owner()`, one create function and three arguments. The deployed `KlerosCore` has no
`arbitrableWhitelistEnabled` toggle that `master` added, which is why an EOA's `createDispute`
reverts unconditionally (see `CONTEXT.md`, **Arbitrable**).

So: bind to `mainnetViem.*Abi`, never to anything compiled from source, and pin a signature
fingerprint per bound function — rendering `name(inputTypes) -> (outputType outputName, …)` and
comparing against a literal, with **output names and order deliberately part of the assertion**,
because multicall results are destructured positionally and a tuple-layout change must fail a test
rather than silently shift a field.

One fingerprint is specific to this repo and load-bearing: **the deployed `disputeResolverAbi`
carries zero custom errors**, even though the rc.2 source declares
`ShouldBeAtLeastTwoRulingOptions()`. A live revert therefore arrives as raw data with no name, so
`reverts.ts` maps `DisputeResolver` reverts **by selector, not by name** — a real difference from
the juror CLI, whose dispute kit reverts with `require` strings. If a package regeneration ever
gives that ABI its custom errors back, the fingerprint must fail, because the decoding strategy
would then be wrong.

## What we gain

Five addresses that are correct by construction, and the deployed ABIs for `KlerosCore`,
`DisputeResolver`, `EvidenceModule`, `DisputeTemplateRegistry` and `PolicyRegistry` — plus
`getDisputeKitsViem`, which the package exports as a dispute-kit lookup keyed by kit ID. Its exact
return shape is **not yet confirmed** — confirm it before ADR-0004's effective-versus-requested
echo is built on it, since echoing a kit by name rather than as a bare integer is what that check
needs.

## The ESM defect, handled rather than avoided

`@kleros/kleros-v2-contracts@2.0.0-rc.2` maps its `import` condition at `esm/`, whose files are
CommonJS under an `esm/package.json` declaring `"type": "module"`, so importing the package root
throws `ReferenceError: exports is not defined in ES module scope`. **Re-verified on Node 22.23.1
against `2.0.0-rc.2`, which is still the `latest` tag** — this workaround is live, not inherited.
Source therefore imports the `cjs/deployments` subpath, and tsup bundles it — the same workaround
`@kleros/agentkit` applied.

Two consequences worth knowing:

- The barrel re-exports 95 typechain factories that `require("ethers")` at module scope, a
  dependency the package never declares and which resolves only to a hoisted wrong-major copy.
  CommonJS is not tree-shakeable, so bundling the barrel produces a multi-megabyte chunk containing
  `ethers`. `build/kleros-deployments.mjs` reaches the leaf modules directly instead — their
  require graph is only viem. It exists as a **bundler alias** rather than a plain import because
  the package's `exports` map declares `./cjs/deployments` but **nothing below it**: importing
  `@kleros/kleros-v2-contracts/cjs/deployments/arbitrum.js` fails with
  `Package subpath … is not defined by "exports"`, so the leaf modules are reachable only by
  relative path from inside a bundle. *(The juror repo's ADR-0006 and its shim comment both say the
  map "declares no deep subpaths"; that is wrong — `./cjs/deployments` is declared. The correction
  matters because it is the reason the alias points at a shim rather than the reason a shim exists
  at all.)*
- Those leaf modules are CommonJS and `require("viem")`. esbuild cannot satisfy that in ESM output
  while viem stays external, and its fallback throws on first call, so `tsup.config.ts` emits a
  `createRequire` banner into every output file — including the shared chunk, which evaluates
  before the entry and so cannot be fixed from there.

Because the code is bundled, the package stays a **devDependency**: shipping it as a runtime
dependency would put 54MB, plus `@shutter-network/shutter-sdk`, into every install for something
the built artifact never loads.

## Costs accepted

Taken from the juror repo as a baseline expectation to measure against, not as a measurement of
this repo: `dist` grew there from 176KB to 4.8MB (1.7MB of JS, the rest sourcemaps) and cold start
from ~0.30s to ~0.48s. Most of the JS is testnet and devnet deployment data that `contractsViem`
pulls in alongside mainnet. Re-measure once `tsup.config.ts` lands; if this repo is materially
worse, the shim's leaf-module list is where to look.
