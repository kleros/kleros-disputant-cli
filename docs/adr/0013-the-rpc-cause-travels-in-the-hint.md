# The RPC cause travels in `details.hint`, because the envelope has no other door

Status: **accepted**, 2026-09-09. Closes the second finding of an external test session run
against `dist/cli.js` on 2026-09-08; that report was not kept in-tree, so this ADR and
[04 §2.1](../spec/04-transaction-relaying.md) are the record. Constrains every `err()` call
site, so it is a rule about the error contract and not only about `RPC_ERROR`.

## The problem

`rpcError()` captured the underlying failure and attached it as `details.cause`:

```ts
return err("RPC_ERROR", message, {
  cause: cause instanceof Error ? cause.message : String(cause),
});
```

Nothing read it. Not the default payload, not `--full-output`, not `--format json`. An external
test session recovered it only by importing `simulateAndMaybeBroadcast` from `dist/index.js` and
calling it directly, at which point it named the problem in one line.

So `RPC_ERROR` — one code, exit 2 — covered an endpoint that is down, a rate limit, a malformed
`--rpc-url`, and an account that cannot pay, with nothing to separate them. For a tool whose stated
error contract is "branch on `code`" and whose consumer is a program, the one code that most needed
a second sentence was the one that had none. The information was collected and then dropped.

## Why the obvious fix is not available

The obvious fix is "render `details` under `--full-output`". It cannot be done here.

**incur's error envelope is closed.** `c.error` accepts `{code, message, exitCode?, cta?,
retryable?}`, and the object it prints is `{ok, error: {code, message, retryable?, fieldErrors?},
meta}`. There is no `details` slot to fill — not a hidden one, not a verbose one. Passing `details`
to `finish` and hoping is not a design; the value has nowhere to land.

Reimplementing incur's output to add one is ruled out by `spec/03 §1`: the CLI **MUST NOT**
reimplement anything incur supplies, and `--full-output` is one of the flags it supplies. Forking
the envelope to carry one diagnostic string would trade a small ambiguity for a large divergence,
and every future incur upgrade would pay for it.

`spec/03 §5.4` had already settled the other half of this independently: **only `details.hint`
reaches the user**, because dumping the whole object makes messages unreadable for the consuming
agent. That rule is right and is not being revisited. What was missing is that it has a corollary
nobody had written down.

## Decision

**`details.hint` is the error contract's only channel for a fact the caller needs, and `rpcError`
uses it.** The cause is summarised to one line and appended to the message:

```
Could not read the chain ID from the configured RPC endpoint. The endpoint said: fetch failed
```

Three details of the summary, each of which is a decision:

1. **viem's `details` is preferred over its `shortMessage`**, because `details` is the *node's* own
   words — `insufficient funds for transfer` — and `shortMessage` is viem's category for them.
2. **Except when `details` is body-shaped.** Pointed at a website rather than an RPC, viem puts the
   whole HTTP response body in `details`. Echoing a remote body into our own payload is noise, so a
   `details` beginning with `<`, `{` or `[` yields to `shortMessage`. This is the one place a remote
   string enters a payload, and it is never parsed, never interpolated into a call, and never acted
   on — it is a string inside a message. `ADR-0007`'s rule concerns counterparty *evidence*, and is
   untouched.
3. **Capped at 160 characters**, because `spec/03 §5.1` requires the payload stay small and viem's
   errors are several paragraphs of docs URL and version banner.

`details.cause` is kept, unsummarised, and **no test reads it**. It survives for the one consumer
that can see it: `src/index.ts` exports the core, so a caller importing `simulateAndMaybeBroadcast`
from `dist/index.js` gets the whole `KlerosResult` rather than a rendered envelope — which is
exactly how the external session recovered the cause in the first place. It remains invisible to
CLI callers, and that is now a stated property rather than an accident.

## The corollary, which is the part worth keeping

**If a caller needs a fact in order to act, it goes in `message` or in `details.hint`. There is no
third place.** Any other key on `details` is for tests only.

Twenty-three of this repo's sixty-seven `err()` call sites attach a `hint` — the two added by this
decision included. Forty-one attach detail keys that no output mode renders, and three attach no
`details` at all. A non-rendering detail key is correct wherever the `message` already embeds the
values that matter, which is the common case here: these messages are deliberately long and name
their own numbers. It is a defect only where the message does not. `rpcError` was the one that did
not.

## What this costs

`RPC_ERROR` messages get longer, and their tail is a string this repo does not control. The cap
bounds it, and the alternative — an agent that cannot tell a dead endpoint from an unfunded account
— is worse than a long sentence.

The summary depends on viem's error shape (`details`, `shortMessage`). If a viem upgrade renames
those, the fallback chain degrades to the first line of `message` rather than breaking, and
`client.test.ts` pins all three branches.
