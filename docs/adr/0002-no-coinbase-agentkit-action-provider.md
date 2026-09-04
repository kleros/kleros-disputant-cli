# No Coinbase AgentKit action provider

Shipping this tool as a `@coinbase/agentkit` `ActionProvider` was the starting assumption, as it
was for `kleros-juror-cli`. It is rejected here for the same reasons, and every finding below is a
fact about `@coinbase/agentkit` 0.11.0 rather than about the juror role — so the argument transfers
whole. Three of this tool's invariants are unreachable through the `ActionProvider` /
`ViemWalletProvider` contract.

| Invariant | Why it is unreachable |
| --- | --- |
| Simulate every state-changing call before it is sent (ADR-0004) | `ViemWalletProvider`'s `WalletClient` is `#private` with no getter. No `simulateContract`, no `writeContract`. |
| Pass `confirmations: 1`, an explicit `timeout` and `onReplaced` when waiting for a receipt | `waitForTransactionReceipt(txHash)` accepts only a hash and returns `any`. |
| Stable exit codes and structured JSON, with a `code` field on every error | `Action.invoke` returns `Promise<string>`; the in-repo convention is human-readable prose. |

Reaching them means escaping the abstraction via `getPublicClient()` / `toSigner()` for exactly the
parts that matter most, which leaves a wrapper over viem and no abstraction.

Two further disqualifiers, independent of the above:

- **Telemetry with no opt-out.** `@CreateAction` POSTs the wallet address, chain ID, action name
  and a timestamp to `cca-lite.coinbase.com` on every invocation. The transaction is already public
  on chain, so the incremental leak is IP↔address linkage — and that is **worse here than for a
  juror**. A drawn juror is pseudonymous by construction and the protocol works to keep them so; a
  party creating a dispute is a named participant with a stake in a specific outcome, often
  identifiable from the arbitrable alone. Linking that address to an IP on every invocation is a
  meaningful deanonymisation, and it cannot be disabled.
- **It can kill the process.** That analytics call is `async`, invoked with no `await` and no
  `.catch()`. Under Node's default unhandled-rejection behaviour a Coinbase outage can crash the
  process. For a juror the sharp edge was a 30-minute reveal window; here it is a crash **mid-
  `createDispute`, after `msg.value` has been committed and before the receipt is read** — which
  lands the caller in exactly the `status: "unknown"` state ADR-0004 exists to make survivable,
  except with no payload to survive it from. A blind retry then pays the arbitration cost twice.

It also carries 41 runtime dependencies with zero peer dependencies, including `ethers` v6 and
`viem` pinned to an exact version, and requires legacy `experimentalDecorators`. This repo's
runtime dependency count is two.

## Consequences

Reversal is cheap by construction, which is why deferring is safe rather than final: the core is
plain functions with no framework in the signing path, `ActionProvider` / `CreateAction` are public
exports usable from any package, and both shipped adapters (LangChain, Vercel AI) are ~20-line
`Action[] → tool()` maps. Revisit if a Vercel-AI agent actually exists.
