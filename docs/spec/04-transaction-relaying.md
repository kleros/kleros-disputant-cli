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
