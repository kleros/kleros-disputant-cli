# 05. Verification

The bar is `kleros-juror-cli`'s, plus three criteria that exist only because of
[01 §4.4](./01-onchain-reference.md).

Suites with a prerequisite (a fork, an archive RPC) **MUST** self-skip at module scope and announce
it with `console.warn`, rather than being excluded by config. A skipped suite must be visible in the
run output, never silently green. That idiom needs `disableConsoleIntercept: true` in the vitest
config — verified against vitest 4.1.11, which otherwise prints console output only for *failing*
files and swallows the warning entirely.

## 1. Unit tests, no network

Everything in [02](./02-payload-construction.md) is a pure function, and everything in this section
runs without an RPC, a key, or a filesystem write.

### 1.1 `extraData` encoding

- Vectors X1–X4 encode to the exact bytes in [02 §1.3](./02-payload-construction.md).
- Every vector is exactly 96 bytes.
- Decoding each vector's three words returns the inputs.
- `encodePacked` is not reachable from any code path.

### 1.2 Refusals — the safety core

Every row of X5 ([02 §1.3](./02-payload-construction.md)) **MUST** be refused by `checkPreflight`
as a **pure function over a facts struct**, with the code from
[03 §5.5](./03-cli-surface.md), and with **zero network calls**. This is the single most important
test file in the repository: it is the only thing standing between a typo and a paid mistake, and
on this write surface it has no on-chain backstop.

The suite **MUST** also assert refusal ordering, because ordering is a diagnosis quality: an
out-of-range court is reported as such rather than as an unsupported kit.

### 1.3 Payload serialisation

- T1 serialises to 555 UTF-8 bytes and `keccak256` `0x57c84f48…f916d`.
- E1, E2 and E3 serialise to the bytes and hashes in [02 §4.4](./02-payload-construction.md).
- E3 specifically: the length check counts **UTF-8 bytes** (101), not UTF-16 code units (94).
- Field order is stable across runs.

### 1.4 The strict authoring schema

- Every required template field missing → rejected, one at a time.
- An unknown key → **rejected**, not stripped.
- `policyURI` as `https://…` → rejected. As `/ipfs/…` and `ipfs://…/…` → accepted.
- `arbitratorChainID` as a number rather than a string → rejected.
- An `answers` entry with `id: "0x0"` → rejected.
- `answers.length < 2` → rejected.
- Evidence keyed `title` instead of `name` → rejected.
- A bare `/ipfs/…` string as the whole evidence document → rejected.

### 1.5 Cost arithmetic

- The value sent equals the quote exactly, for each of X1–X4.
- A quote above `--max-cost-eth` refuses **before** any simulate call is issued.
- The balance check is `balance < estimatedFee + value`, asserted with a `value` large enough that
  the old comparison would pass.
- **Every double standing in for `eth_estimateGas` MUST model the node's balance precheck**
  (`04 §2.1`): reject when `value + (fee fields present ? gas * maxFeePerGas : 0) > balance`.
  Without it a suite asserting `INSUFFICIENT_BALANCE` passes while exercising a path a real node
  makes unreachable, which is what happened — `broadcast.test.ts` asserted that refusal and was
  green for as long as the defect existed.
- At least one test **MUST** reach that refusal through a double that speaks **JSON-RPC**, so viem
  builds the request itself. A double that stubs `estimateContractGas` directly cannot falsify a
  claim about which account shape viem populates fee fields for, and that claim is what the
  refusal's reachability rests on.

### 1.6 Deployment fingerprint

A test **MUST** pin the ABI entries this tool binds to, so an upstream regeneration from `master`
fails the build rather than a transaction. At minimum:

- `createDisputeForTemplate` selector is `0xdc653511` and the function is `payable`.
- `submitEvidence` selector is `0xa6a7f0eb` and the function is **not** payable.
- `submitEvidence`'s first parameter is **named `_externalDisputeID`**, and `evidenceModuleAbi`
  contains `governor()` and **not** `owner()`. The selector alone is **not** sufficient: the devnet
  deployment renames the parameter to `_arbitratorDisputeID` without changing the signature, so a
  selector-only assertion cannot see the change ([01 §7.1](./01-onchain-reference.md)).
- `arbitratorDisputeIDToLocalID` is `view`, takes one `uint256` and returns one `uint256`. It
  decides **which identifier is signed** ([02 §4.2](./02-payload-construction.md)), so its shape
  belongs here and not only in the read layer's own tests.
- `DisputeRequest` has **five** arguments.
- `disputeResolverAbi` contains **zero** custom errors.
- `klerosCoreAbi` contains `ArbitrableNotWhitelisted`, `ArbitrationFeesNotEnough` and
  `DisputeKitNotSupportedByCourt`, and does **not** contain `arbitrableWhitelistEnabled`.
- `arbitrationCost` still offers **both** overloads, `(bytes)` and `(bytes,address)`. The one-argument
  form is the ETH path; losing it would silently retarget the quote at the fee-token path
  ([01 §8](./01-onchain-reference.md), ADR-0008).
- The addresses in [01 §1](./01-onchain-reference.md) are what the package resolves for 42161 —
  including both governance override contracts, which are refused by name.

**The fingerprint covers every served deployment, and carries one address table per deployment.**
The testnet's addresses are those in [01 §1.0a](./01-onchain-reference.md), resolved and pinned the
same way, so neither deployment can move quietly.

- The shape assertions above **MUST** run against **every** served deployment, not only the default.
  They are pure and offline, and they are the build-time half of "no path exists on one deployment
  only": a called fragment diverging is what they would catch.
- A test **MUST** record the measured ABI difference in [01 §1.0b](./01-onchain-reference.md) —
  which entries are Beta-only and which testnet-only — so an upstream regeneration breaks the build
  rather than a transaction.
- A test **MUST** assert `arbitrableWhitelist` is present on `arbitrum-one` and **absent** on the
  testnet. This is the build-time half of the whitelist being a v2 Beta property.
- The ruler assertion **MUST** be skipped where the deployment has no ruler, rather than rewritten
  to assert the absence — so it returns by itself if the package ever ships one.
- **Accepted cost, and the only ongoing maintenance this feature adds:** a testnet redeployment
  fails this block. That is intended — a redeployment silently changes where transactions are sent
  — so a failure here is a question about what moved, never a number to update.

### 1.6a Which dispute identifier is signed

The defect these close was invisible on Arbitrum One, where all three identifiers coincide, so the
fixtures come from the v2 testnet **[live]** and are stated in
[ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md).

- **The tests are written against the v2 Beta double, deliberately.** The divergence is reachable on
  Arbitrum One the day a second arbitrable files there. Placing the fixture on a testnet double
  would re-encode the belief this work disproves — that the defect is a testnet quirk.
- A test **MUST** assert that `submitEvidence` receives the **local** dispute ID, using the measured
  pair: core dispute 58 resolves to local dispute 33. Asserting the envelope is not sufficient; the
  assertion is on the argument.
- A test **MUST** assert that the caller is never shown the second identifier — the envelope reports
  the core dispute ID it was given, and nothing else.
- A test **MUST** reach `DISPUTE_NOT_ADDRESSABLE` through a double that speaks **JSON-RPC**, so viem
  builds the request and the node answers from the real ABIs. The fixture is core dispute 98: a
  foreign arbitrable, and a mapping that answers `0`.
- A test **MUST** assert that **local dispute ID `0` is accepted**. Zero is a real dispute, not a
  miss, and this is the assertion that fails if the check is ever written against the raw mapping
  value instead of the `null` the read layer substitutes.
- A test **MUST** assert that a mapping read which *fails* is reported as `DEPLOYMENT_INCONSISTENT`
  and never as a missing local ID. A public mapping getter cannot revert.
- A test **MUST** assert that both reads share one multicall.

### 1.6b Two deployments, and why the suite is not a matrix

**The second deployment appears in exactly five places, and the suite is NOT run twice.** Mechanics
are identical across deployments by design, so a matrix would execute the same lines against
different constants — a slower suite and a standing tax on every future test, for duplicate
coverage. The five:

- **The fingerprint** ([§1.6](#16-deployment-fingerprint)), which is pure and offline.
- **A differential test.** The same inputs against both deployments, asserting the envelopes are
  **structurally identical apart from the deployment fields and the addresses**. It **MUST** cover a
  read, both writes stopped at simulation, and **at least one refusal** — a success-path comparison
  alone cannot see a safety check relaxed on one deployment, because the inputs never trip it. This
  is what turns "identical mechanics" from a design promise into a pinned property, and it is the
  test that catches a future branch on the deployment: a cost ceiling skipped on the testnet, a
  confirmation gate added there, a warning only one of them emits.
- **The startup ordering at the testnet chain ID**, proving the expected value is read from the
  selected deployment rather than a constant, and that no contract call precedes the assertion. It
  **MUST** also assert the batch carries **that deployment's** addresses — the half a chain-ID
  assertion cannot check.
- **The unsupported-slug refusals**, asserting zero network round trips.
- **The acceptance test** ([§3](#3-acceptance-test)), which is the odd one out and **does not live
  in §1 at all**: it is not an in-process double but the live testnet, reached through the built
  binary, and it is the only place this tool signs against that deployment. It is counted here
  because this is where the deployment's appearances are enumerated, not because it is a unit test.
  The rule below does not reach it — nothing about its endpoint is ours to set — and it is the one
  place that buys coverage a deployment-parameterised double cannot: real gas, a real mempool, a
  real receipt.

The in-process JSON-RPC double **MUST** take a deployment and answer as either one, from the real
ABIs. The seam stays the endpoint option: nothing injected, no module mocked. Its chain ID
**MUST** default to that deployment's, with an explicit override reserved for modelling a
mis-pointed endpoint — a double whose addresses and chain ID could be set apart independently would
let a test pass a combination no endpoint can serve.

**A differential test that cannot fail is worse than none.** It **SHOULD** be falsified once, by
introducing a deliberate branch on the deployment and confirming the comparison catches it.

### 1.7 Output and safety

- Every bigint in every envelope survives `JSON.stringify`.
- Every success payload has a `warnings` array.
- No envelope, on any path including every failure path, contains the key material.
- The exit-code map is exhaustive over the error-code union — a compile-time assertion, not a
  runtime one.

### 1.8 Attachment upload

Offline, against a fake `fetch`. Nothing in this group may reach the network — the live checks are
[06 §5](./06-attachment-upload.md), and the one suite that does reach it is §2.1 below.

- The request is shaped as [06 §2](./06-attachment-upload.md) fixes it: `POST`, one `file` part,
  `operation` present and non-empty, `pinToGraph=false`.
- **`operation` is present even though the service discards its value.** A regression that drops it
  turns every upload into a `400`, and no other assertion here would notice.
- A `2xx` whose `cids` array is empty is `UPLOAD_FAILED`, not a success.
- A non-`2xx` with an empty `text/plain` body is `UPLOAD_FAILED` and is **not** JSON-parsed.
- A CID returned bare and one returned `/ipfs/`-prefixed normalise to the same `fileURI`.
- The size gate is computed from the **serialised body**, base64-expanded, against
  `6 MiB − 64 KiB` — not from the file length. A long filename moves the boundary, and a test with
  one asserts that it does.
- An empty file is `FILE_EMPTY` **before** any request is attempted; an unreadable path is
  `FILE_UNREADABLE` before it too. The fake `fetch` asserts it was never called.
- Verification: matching bytes pass; differing bytes are `UPLOAD_MISMATCH`; a gateway that never
  answers is a **warning** with `verified: false`, never a failure.
- Without `--publish`, `fetch` is never called at all.
- `fileTypeExtension` is derived from the path, omitted when there is none, and never guessed.

## 2. Fork tests

On an Arbitrum One fork at `:8546`. `pnpm test:fork`, which starts anvil, waits for it and reaps it.
Implemented in `src/__tests__/fork.test.ts`; absent a fork the suite self-skips loudly per §1.

Each test runs inside an `evm_snapshot` / `evm_revert` pair, so a test that seeds the chain or
spends the disputant's balance cannot change what the next one measures.

**A fork is not just a cheaper Arbitrum One. It is the only place the state production lacks can be
created** — an overpayment, and a second arbitrable. Tests 2, 3 and 5 exist for that reason alone,
and three of the five claims in [Appendix A §2](./appendix-a-unresolved.md) were settled by them.

1. **A create with a deliberately wrong court ID is refused.** Ask for court 99; assert the CLI
   refuses with `COURT_OUT_OF_RANGE` and that **no transaction was sent**. There is no revert to
   prove this for you — the chain would happily create a General Court dispute.
2. **The value sent equals `arbitrationCost` exactly.** Broadcast on the fork and assert the
   sender's balance decreased by exactly `arbitrationCost + gasUsed × effectiveGasPrice`, and that
   the transaction's own `value` field is the quote — not the envelope's account of it.
3. **A deliberate overpayment is observed, not guessed.** Send `2 × arbitrationCost` on the fork and
   record `round.nbVotes` and the resulting balance. Not reachable through `create-dispute`, which
   sends exactly the quote and offers no way to ask for anything else, so it drives
   `simulateAndMaybeBroadcast` directly.

   > **Settled.** `nbVotes` is 6 rather than 3 and nothing is refunded: the excess buys a larger
   > panel. [01 §3.2](./01-onchain-reference.md) carries the table and no longer says
   > **[inferred]**. This was the most expensive unverified claim the specification held.
4. **`effective` matches `requested`.** Create with X1 and assert the envelope's effective court,
   juror count and kit equal the requested ones, read back from `KlerosCore.disputes()`.
5. **The core dispute ID comes from the log.** On a fork seeded so that another arbitrable has
   created disputes — whitelist one by impersonating the governor — assert the reported
   `coreDisputeID` equals `DisputeCreation._disputeID`, and that it **differs from the arbitrable's
   local ID**, read back through `arbitratorDisputeIDToLocalID` and seen again as
   `DisputeRequest._externalDisputeID`. This is the only place the local/core distinction can be
   exercised at all ([01 §7](./01-onchain-reference.md)).

   > This test was originally specified as *the reported ID must differ from the function's return
   > value*. It cannot: **the return value is the core dispute ID**, which the same fork run showed
   > and [01 §7](./01-onchain-reference.md) now records. The distinction that is real is core
   > against **local**, so that is what is asserted — plus the return value, pinned to what it
   > actually is so the correction cannot quietly regress.
6. **Revert decoding.** Force each row of [01 §5](./01-onchain-reference.md) and assert the CLI
   names it: the `Error(string)` from `DisputeResolver`, and each forwarded core selector.
7. **`submit-evidence` against a non-existent core dispute ID is refused**, and against a dispute
   in the `execution` period **warns and proceeds**. "Proceeds" is asserted by broadcasting: the
   emitted `Evidence` log must carry E1's bytes verbatim, the sender, and the **local** dispute ID
   read back from `arbitratorDisputeIDToLocalID` — **not** compared against the core ID passed in.
   The two coincide on this deployment, so an equality assertion against the input would pass
   whichever identifier the CLI sent, which is how the defect in §1.6a survived
   ([ADR-0014](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)).

8. **Not one of the seven, and worth having anyway:** one create emits `DisputeCreation`,
   `DisputeRequest` and `DisputeTemplate` in **one receipt**, from three different contracts. That
   is [Appendix A §2](./appendix-a-unresolved.md) claim 5, which names a fork test as its remedy,
   and the receipt tests 2 and 4 already fetch is enough to settle it.

## 3. Acceptance test

`pnpm test:acceptance`, against the **live v2 testnet** — `--chain arbitrum-sepolia-testnet`, a
funded testnet key, no fork and no archive RPC. Full lifecycle, **in separate processes**, through
the built binary rather than the modules: the envelope, the signing path, the endpoint and the
receipt exercised together against real infrastructure for the first time. It runs **before the
first Arbitrum One broadcast**, so that broadcast is a confirmation rather than an experiment.

It **MUST** self-skip loudly when the funded key is absent, per the §1 preamble's idiom. A key
that cannot pay is a skipped suite, never a green one.

**Assertions here MUST be relational, never pinned.** A live chain moves, and the numbers in this
document are `arbitrum-one`'s: the fee, the court tree and the period lengths are all that
deployment's ([01](./01-onchain-reference.md) preamble). Asserting `0.015 ETH` would be asserting
the wrong deployment's constant against a chain that is free to change it.

1. `arbitration-cost` returns a quote for a court that exists **on that deployment**, resolved
   rather than assumed, and the same call twice returns the same number.
2. `create-dispute` without `--broadcast` returns `status: "simulated"` and sends nothing —
   asserted by the sender's balance being unchanged.
3. `create-dispute --broadcast` mines, the value sent equals the quote **exactly**, and the
   reported core dispute ID resolves on chain.
4. `submit-evidence` against that dispute mines, and the emitted `Evidence` log carries the exact
   bytes of E1 **and the local dispute ID read back from `arbitratorDisputeIDToLocalID`** — never
   the core ID that was passed in. **This is the deployment where that assertion has teeth**: a
   second arbitrable exists on the testnet, so the two identifiers have already separated and a
   bytes-only assertion would fail to catch the regression §2.7 names. On a pinned Arbitrum One
   fork they coincide unless the fork is seeded.
5. `status` reports the dispute in the `evidence` period.

The acceptance test **MUST** assert that no secret reached stdout or stderr, and that nothing was
written to disk.

## 4. Live read-only checks

Re-run these when the deployment might have changed. Every one is read-only and needs no key.

**These are `arbitrum-one`'s addresses**, and they refresh this document set's **[live]** claims,
which are that deployment's ([01](./01-onchain-reference.md) preamble). The testnet's address set is
[01 §1.0a](./01-onchain-reference.md); pointing `$RPC` at Arbitrum Sepolia without also replacing
`$CORE`, `$RES` and `$EV` reads three addresses that hold no Kleros contract, and `cast` will say
nothing useful about why. **Most of the expected values below do not carry either**: every court ID,
kit-support answer, fee level, period length and the `courts(35)` bound is that deployment's, so
only the `version()` reads and the address-consistency checks transfer unchanged. One call has no
testnet counterpart at all — `arbitrableWhitelist`, whose selector is absent from that ABI
([01 §1.0b](./01-onchain-reference.md)).

```bash
RPC=https://arb1.arbitrum.io/rpc
CORE=0x991d2df165670b9cac3B022f4B68D65b664222ea
RES=0xb5526D022962A1fFf6eD32C93e8b714c901F4323
EV=0x48e052B4A6dC4F30e90930F1CeaAFd83b3981EB3
X1=0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001

# versions — a mismatch is a warning, and a prompt to re-read 01
cast call $CORE "version()(string)" --rpc-url $RPC     # expect "0.10.0"
cast call $EV   "version()(string)" --rpc-url $RPC     # expect "0.8.0"

# the deployment still agrees with itself
cast call $RES "arbitrator()(address)"       --rpc-url $RPC   # expect $CORE
cast call $RES "templateRegistry()(address)" --rpc-url $RPC   # expect 0x0cFBaCA5…a5A2

# the cost vector
cast call $CORE "arbitrationCost(bytes)(uint256)" $X1 --rpc-url $RPC   # expect 15000000000000000

# the silent default: BOTH of these MUST still return the same number as $X1.
# If either ever differs, the decoder changed and 01 section 4.4 must be revisited.
cast call $CORE "arbitrationCost(bytes)(uint256)" 0x --rpc-url $RPC
cast call $CORE "arbitrationCost(bytes)(uint256)" \
  0x000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000001 \
  --rpc-url $RPC                                                       # expect 34500000000000000

# kit support — the General Court still supports Classic only
cast call $CORE "isSupported(uint96,uint256)(bool)" 1 1 --rpc-url $RPC   # expect true
cast call $CORE "isSupported(uint96,uint256)(bool)" 1 2 --rpc-url $RPC   # expect false
cast call $CORE "isSupported(uint96,uint256)(bool)" 1 3 --rpc-url $RPC   # expect false

# kit support is per court, and these two courts are the exception (01 section 4.2).
# A difference here is DRIFT, NOT A FAILURE: kit support is governance-controlled and
# nothing signals a change. Re-record the matrix; never widen it into a claim that
# holds deployment-wide.
cast call $CORE "isSupported(uint96,uint256)(bool)" 24 2 --rpc-url $RPC  # expect true
cast call $CORE "isSupported(uint96,uint256)(bool)" 32 3 --rpc-url $RPC  # expect true
cast call $CORE "isSupported(uint96,uint256)(bool)" 24 4 --rpc-url $RPC  # expect false — kit 4 has no court

# bounds. Both MUST revert; if courts(35) succeeds a court was added and the
# validation range in 02 section 1.1 is stale
cast call $CORE "courts(uint256)(uint96,bool,uint256,uint256,uint256,uint256,bool)" 35 --rpc-url $RPC
cast call $CORE "disputeKits(uint256)(address)" 5 --rpc-url $RPC

# the whitelist still forces the DisputeResolver path
cast call $CORE "arbitrableWhitelist(address)(bool)" $RES --rpc-url $RPC  # expect true

# the ID coincidence: while this returns the same number as KlerosCore's dispute
# count, core, local and external IDs are indistinguishable in production.
# This is why 02 section 4.2's resolution cannot be verified here at all — only
# on a seeded fork, or on the v2 testnet, where the identifiers have separated.
cast call $RES "disputes(uint256)(bytes,bool,uint256,uint256)" 215 --rpc-url $RPC
```

## 4.1 Live service checks

[06 §5](./06-attachment-upload.md) holds the commands that produced every **[service]** claim, and
is the only place in this document set that describes re-measuring something that is not a
contract. Run them when an upload starts failing, or before trusting a **[service]** row that
matters: unlike a deployment, this endpoint can change with no signal this repo can detect.

They upload real files to a real pinning service. Use inert content.

## 5. Acceptance criteria

The tool is done when all of the following hold:

1. Every rejection decidable from chain state is tested **without a network**, as a pure function
   over a facts struct.
2. The deployed ABI is fingerprinted, so an upstream regeneration fails the build rather than a
   transaction.
3. A full lifecycle runs against the **live v2 testnet**, in separate processes, asserting that no
   secret reached stdout or stderr and that nothing was written to disk.
4. The CLI surface is machine-checked against [`CONTEXT.md`](../../CONTEXT.md).
5. `--broadcast` is opt-in, and the simulate-only result says so **in words**.
6. **A deliberately wrong court ID is refused on a fork**, with no transaction sent.
7. **The value sent equals `arbitrationCost` exactly**, asserted by balance arithmetic on a fork —
   and the reason it must, that an excess is never refunded, asserted alongside it
   ([01 §3.2](./01-onchain-reference.md)).
8. **The effective court, juror count and dispute kit in the envelope match what was requested**,
   read back from chain state rather than echoed from the inputs.
9. **`upload-file` uploads nothing without `--publish`**, and the check-only result says so in
   words — the same bar as criterion 5, for the other irreversible action
   ([ADR-0012](../adr/0012-attachment-upload-is-in-scope-behind-its-own-command.md)).
10. **No command that signs opens a socket to anything but the RPC.**

## 6. Known upstream issues to guard against

- **The published Kleros documentation's `extraData` encoding is wrong** and costs money silently.
  Anyone reading the arbitrable guide instead of this specification will produce a 44-byte blob.
- **The published documentation's evidence field is `title`.** The field is `name`.
- **The published template examples name an `arbitratorAddress` that is not the deployed
  `KlerosCore`.** Use the package address.
- **The documentation says the General Court supports all four dispute kits.** It supports Classic.
- **The package's `.sol` sources disagree with the deployment** for every contract this tool
  writes to. Bind to the ABIs.
- **The pinning endpoint answers `200` when it has pinned nothing** — an empty file, or a request
  with no file part. Treating its status code as the outcome loses the file silently.
- **The pinning endpoint reassigns the uploaded file on every `data` event**, so a body arriving in
  more than one chunk would pin its last chunk alone under a valid CID. It does not fire today, for
  a reason that is incidental to the bug. This is why verification is on by default
  ([06 §4.2](./06-attachment-upload.md)).
