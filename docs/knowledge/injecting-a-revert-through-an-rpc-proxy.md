# Injecting a revert, to exercise a branch no test can reach

Some failure branches cannot be reached from a test double or a fork, because the contracts in the
call stack never produce the input. `decodeRevert`'s oversized and hostile-string branches are the
example: every contract this tool can reach is Kleros-governed and emits short, fixed `require`
strings (`ADR-0017`). Verifying what the **binary** prints for a 8 KiB revert therefore needs the
revert to be manufactured.

## Why `anvil_setCode` is the wrong tool here

The obvious move — fork Arbitrum One and replace `DisputeResolver` with a stub that always reverts —
does not reach the simulate. `checkDeployment` reads `arbitrator` and `templateRegistry` **off
`DisputeResolver` on every invocation** (`src/core/client.ts`), so a stub that reverts on everything
fails the deployment check first and the run ends in `DEPLOYMENT_INCONSISTENT`. Making it work means
hand-writing dispatcher bytecode that answers those two getters and reverts only on
`createDisputeForTemplate`.

## What works instead

Put an HTTP proxy in front of a real endpoint and pass it as `--rpc-url`. Forward every request
untouched except two:

- **the one `eth_call` whose `params[0].data` starts with the target function's selector** — answer
  it with a JSON-RPC error carrying the revert `data` you want (`{code: 3, message: "execution
  reverted", data: "0x08c379a0…"}`);
- **`eth_getBalance`** — answer with enough wei, because `checkValueAffordable` runs in
  `src/commands/write.ts` *before* the simulate and would otherwise refuse first.

Everything else — `eth_chainId`, the deployment multicall, `arbitrationCost` — comes from the real
chain, so the run is genuine right up to the injected failure.

This is not a trick against the tool; it is the vector `ADR-0017` names as the only live one. The
endpoint supplies the revert bytes and `assertChain` constrains the chain ID, not the response body.

**It cannot spend money.** Pass no `--broadcast`, and the injected revert ends the path before any
send in any case. Confirm the nonce is unchanged afterwards regardless: a
count of irreversible actions is a published claim in this repo, and the chain keeps the counter.

## What it measured

`.scratch/revert-message-bounds/spec.md` has the numbers: 8 KiB of `Error(string)` produced an
8250-character `message` and 8303 bytes of stdout through `dist/cli.js`, and 218 characters after
the fix. No unit test would have shown either, because none of them renders the envelope.

Related: `docs/knowledge/fork-harness-port-8546.md` for the fork the fork tests use, and
`docs/spec/05-verification.md` for what each rung of the verification ladder is allowed to claim.
