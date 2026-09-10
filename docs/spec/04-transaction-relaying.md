# 04. Transaction relaying

How a validated payload becomes a transaction. Inherited wholesale from `kleros-juror-cli`'s
`broadcast.ts`, with three changes that exist because **this tool's transactions carry money**.

## 1. The path

```
build payload  →  pre-flight (01 section 8)  →  quote  →  simulateContract
                                                              │
                                                    --broadcast?
                                                  no ──────────┴────────── yes
                                            status: "simulated"      estimateContractGas
                                                                            │
                                                                     balance check
                                                                            │
                                                                      writeContract
                                                                            │
                                                                       waitBounded
                                                          ┌─────────────────┼─────────────────┐
                                                    status: "mined"  status: "reverted"  status: "unknown"
```

The CLI **MUST** simulate every state-changing call. It **MUST NOT** broadcast without
`--broadcast`. [ADR-0004](../adr/0004-broadcast-is-opt-in-no-human-gate.md)

> Simulation is **not** a safety net for `extraData`. Every silent-default case simulates cleanly
> ([01 §4.4](./01-onchain-reference.md)). Simulation catches an unsupported kit, an underpayment
> and a malformed template argument — nothing else on the create path.

## 2. The three changes from the juror CLI

`simulateAndMaybeBroadcast` currently hard-codes the dispute kit ABI and takes
`disputeKit: Address`. This tool hits two different contracts with two different ABIs, and one of
the calls is payable. Three edits, at bootstrap, before anything depends on the old shape:

1. Replace `disputeKit: Address` and the fixed ABI with `target: { address: Address; abi: Abi }`.
2. Add `value?: bigint`, threaded into `simulateContract`, `estimateContractGas` **and**
   `writeContract`. Threading it into two of the three is the bug that will not show up until
   broadcast.
3. **Fold `value` into the balance check.** `balanceWei < estimatedFeeWei` **MUST** become
   `balanceWei < estimatedFeeWei + value`, or `INSUFFICIENT_BALANCE` under-reports on every
   dispute creation and the shortfall surfaces at broadcast time instead of pre-flight.

Kept verbatim: `FeePlan`, the `150/100` gas buffer, `MAX_FEE_MULTIPLIER = 3n`,
`maxPriorityFeePerGas: 0n`, and `waitBounded`.

### 2.1 The gas estimate MUST pass the account as a bare address

Change 3 is not sufficient on its own, because the node runs the same arithmetic first and wins.

**[live]** Measured on Arbitrum One on 2026-09-09, with `eth_estimateGas` against one funded and
one zero-balance address: the node applies a balance precheck to **every** estimate, and the
formula depends on what the caller sent.

| `value` | fee fields | outcome |
| --- | --- | --- |
| `balance / 2` | absent or present | succeeds |
| `balance` | absent | **succeeds** |
| `balance` | present | fails, `insufficient funds for transfer` |
| `balance * 2` | absent | fails, `insufficient funds for gas * price + value: …have…want…` |
| `balance * 2` | present | fails, `insufficient funds for transfer` |

So the precheck is `gas * maxFeePerGas + value <= balance`, and the `gas * maxFeePerGas` term is
present only when the caller populated the fee fields. It is **not** true that a bare address makes
the node skip the check; the check reduces to `value <= balance`.

viem populates those fields whenever it is handed an `Account` object. The gate is *not* whether
`prepareTransactionRequest` runs — it runs for both shapes — but which parameters it is told to
fill: a local account gets viem's full default set (`fees`, `nonce`, `gas`, `chainId`, `type`,
`blobVersionedHashes`), while a bare address is scoped to `blobVersionedHashes` alone and therefore
fills nothing. So an `Account` object here **throws**
for any account that cannot cover the transaction, `checkBalance` never runs, and the caller gets
`RPC_ERROR` — exit 2, "the chain or the RPC failed" — for what is a local refusal that should be
`INSUFFICIENT_BALANCE` at exit 1.

The estimate therefore **MUST** pass `account` as a bare address. `value` still travels to all
three calls, which is what the reduced precheck weighs.

The other two keep the full account, for different reasons. `writeContract` **requires** it: the
wallet client signs locally, and a bare address would route to `eth_sendTransaction` on a node that
holds no key. `simulateContract` does **not** require it — viem's `account` there accepts an
`Address` — so passing the full object is a deliberate choice, not a constraint: simulation is the
one call whose job is to answer "would this exact sender's call succeed", and narrowing it to an
address for symmetry with the estimate would be a change with no benefit.

The reduced precheck is then `value <= balance`. On the paying path `checkValueAffordable`
(`cost.ts`, called from `create-dispute` **before** `simulateAndMaybeBroadcast` is entered) has
already guaranteed exactly that — note this is *not* change 3's `checkBalance` from §2, which runs
after the estimate and so cannot be what guarantees it. `submit-evidence` does not call
`checkValueAffordable` at all and does not need to: it sends no `value`, so the reduced precheck is
`0 <= balance`.

**The gas number is unchanged by this.** The obvious objection is that Nitro folds the L1 calldata
cost into the returned gas as roughly `posterCost / gasPrice`, so dropping the named price should
inflate the L1 component. **[live]** Measured on Arbitrum One on 2026-09-09, `submitEvidence` at
four calldata sizes against three fee caps:

| calldata | no fee fields | `3 ×` base fee | `0.1` gwei |
| --- | --- | --- | --- |
| 260 B | 33 268 | 33 268 | 33 266 |
| 4 132 B | 128 798 | 128 799 | 128 797 |
| 20 132 B | 524 484 | 524 486 | 524 484 |
| 60 132 B | 1 519 592 | 1 519 592 | 1 519 591 |

Across a 230× range of calldata and a 30× range of named price, the estimates agree to within two
gas. The L1 component does not scale with the price the caller names, so `estimatedFeeWei`
(`gas * maxFeePerGas`, computed from `estimateFeesPerGas` either way) is unaffected and no account
is refused that could previously have paid.

What the bare address *does* drop besides the fee fields is `nonce`, which `prepareTransactionRequest`
would have filled. Estimation does not check nonces, and the measurements above are taken with it
absent.

Two consequences worth stating, because both were believed otherwise:

- The precheck **always counts `value`**, so `create-dispute` was affected exactly as
  `submit-evidence` was. The external test session that found this could not measure it and
  recorded it as inferred; it is now
  measured.
- There are **two** distinct node messages for this one condition, so classifying the failure by
  sniffing the cause string is not sound. The ordering fix is the one that holds.

A test double for the estimate **MUST** model this precheck — see [05 §1.5](./05-verification.md).
Without it, a suite asserting `INSUFFICIENT_BALANCE` passes while exercising a path a real node
makes unreachable, which is what happened.

`waitBounded` is subtle and hard-won. `waitForTransactionReceipt` has open reports of never
settling when a hash is never found, and of polling handles outliving a timeout, so it is raced
against an independent, **`unref`'d** timer — which is what lets the process exit. `confirmations: 1`
is required, not incidental: one confirmation is the right notion of done on an L2 with immediate
soft finality, and `onReplaced` does not fire above 1.

## 3. The result union

```ts
export type BroadcastResult =
  | ({ status: "simulated"; broadcast: false } & FeePlan)
  | ({ status: "mined";     broadcast: true; txHash: Hex; blockNumber: string; gasUsed: string;
       effectiveGasPrice: string } & FeePlan)
  | ({ status: "reverted";  broadcast: true; txHash: Hex; blockNumber: string; gasUsed: string } & FeePlan)
  | ({ status: "unknown";   broadcast: true; txHash: Hex } & FeePlan);
```

### `unknown` is a success, not a failure

The tool stopped watching. The transaction may still land. **Retrying is the dangerous action**, so
`unknown` **MUST NOT** present as a failure that invites a retry: it **MUST** exit `0`, and its
prose **MUST** say what a blind re-send would cost.

This matters more here than in the juror CLI. A re-sent `castVote` is idempotent-ish; a re-sent
`createDispute` **pays the arbitration cost a second time and creates a second dispute**.

Normative:

- On `status: "unknown"` for `create-dispute`, the `message` **MUST** state that the transaction
  may still be mined, that the dispute may already exist, and that re-running with `--broadcast`
  would pay the arbitration cost again. It **MUST** name the transaction hash so the caller can
  check.
- The CLI **MUST NOT** retry automatically, at any status, ever.
- On `status: "reverted"`, the CLI **MUST** report the decoded reason where §5 of
  [01](./01-onchain-reference.md) allows one, and the raw selector where it does not.

## 4. Value discipline

- `value` **MUST** equal `arbitrationCost(extraData)` exactly, quoted in the same invocation with
  the byte-identical blob.
- The quote **MUST** happen after pre-flight passes and before `simulateContract`, so a refusal
  never costs an RPC round trip that implies the call is going to happen.
- The cost ceiling **MUST** be enforced **before** simulating, not after.
- `balance < value` **MUST** be refused before simulating, as `INSUFFICIENT_BALANCE`. **[live]** The
  Arbitrum One public endpoint enforces balance inside `eth_call`, so an unfunded account otherwise
  fails simulation and is reported as `SIMULATION_REVERTED` — exit 3, "the chain rejected the call"
  — when the answer is "fund the account", exit 1. A consuming agent branches on the code, and
  those two ask for different things. It is a **lower bound**, knowable with no gas estimate, which
  is exactly what lets it run this early; §2's `balance < fee + value` still runs afterwards and is
  the one that includes gas. **[inferred]** on `arbitrum-sepolia-testnet`: the precheck was measured
  on the Arbitrum One public endpoint and nothing here has measured it on Arbitrum Sepolia. The
  **MUST** holds regardless — refusing early is right either way — but if that endpoint does *not*
  precheck, an unfunded account there reaches simulation instead, and this is the paragraph to
  revisit. [05 §3](./05-verification.md) is what would settle it.
- The value **MUST** be stated in the envelope for every outcome, including `simulated` — the
  simulate-only envelope is the one an agent reads to decide whether to broadcast.

## 5. What is deliberately not here

- **No fee escalation loop and no replacement transactions.** Dispute creation is untimed: the
  operator chooses when to file, so there is no deadline to race and no justification for
  automatic re-pricing. Fail loudly and let the caller decide.
- **No nonce management beyond viem's default.**
- **No batching.** One command, one transaction.
- **No retry on RPC failure.** A failed read is a failure; a silent retry hides an RPC that is
  lying about chain state, which is the one condition pre-flight cannot survive.
