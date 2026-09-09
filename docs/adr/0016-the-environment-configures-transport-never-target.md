# ADR-0016: The environment configures transport, never target

**Status:** accepted, 2026-09-09
**Supersedes:** nothing. **Amends:** [ADR-0015](./0015-a-deployment-is-not-a-chain.md), which
established that `--chain` selects a deployment and left the override variables named but unread.

## Context

Serving a second deployment gave the per-deployment RPC endpoint its first caller. Each deployment
now carries a default endpoint and the name of an override variable, derived by
`@kleros/agentkit`'s own formula — `KLEROS_RPC_URL_ARBITRUM_ONE`,
`KLEROS_RPC_URL_ARBITRUM_SEPOLIA_TESTNET` — so one exported value serves both tools.

`@kleros/agentkit` resolves a chain through a **four-level precedence** that includes an environment
variable and a configuration file. Following it here would have been the consistent choice, and it
is the one this ADR rejects.

The tension is real and worth stating rather than waving at. This repo has refused ambient
configuration twice already: the signing key is never read from the environment or the command line
([spec/03 §6](../spec/03-cli-surface.md)), and `--rpc-url` deliberately had **no** variable at all
until this change. Reading anything from the environment is a step back from that posture, and the
question is which step.

## Decision

**The environment may change how a deployment is reached. It may never change which deployment is
acted on.**

Concretely:

- `--chain` is the **only** thing that selects a deployment. No environment variable, no
  configuration file, no inference from the endpoint's answer.
- Each deployment's endpoint resolves in three levels: `--rpc-url`, then **that deployment's own**
  override variable, then its default endpoint. The flag outranks the variable, so an ambient value
  can never overrule what the invocation said.
- There is **no** variable whose value applies to whichever deployment happens to be selected. The
  name is derived per deployment, which is what makes the rule structural rather than a promise: a
  value exported for one deployment is not read when another is selected.
- The signing key is untouched by this. It is still refused from the environment entirely.

## Why this line and not agentkit's

**agentkit reads; this tool signs.** An ambient value that redirects which deployment a transaction
is sent to is exactly the invisible input the "fail loudly, never quietly" posture exists to
prevent: a `create-dispute` that spends money on the wrong deployment, from a command line that
looks correct in the transcript and in the logs, is unrecoverable and undiagnosable from what the
caller can see. An ambient value that redirects the *endpoint* is neither. The worst it can do is
point at a node that is down, rate-limited, or serving a different chain — and the last of those is
caught by name, because `assertChain` runs against whatever the endpoint turns out to be before any
contract call is made.

That asymmetry is the whole argument. The two levels look alike from a configuration standpoint and
are not alike at all in what a mistake costs.

**The primary consumer is an autonomous agent**, and this matters twice over. An agent that composes
a command from a transcript cannot see the environment it inherits, so a variable that changed the
target would make the transcript an incomplete record of what was done. Reading the transcript back
is how a caller — human or agent — reconstructs a paid, permanent action.

**Divergence from agentkit is a cost, and it is accepted.** An operator who has configured the read
plane through a config file will find the write plane ignores it. That is the intended surprise: the
failure mode of being surprised is a refusal naming the served slugs, and the failure mode of the
alternative is a dispute in the wrong place.

## Consequences

- The override variables are **named in `--rpc-url`'s own description**, rendered from the
  deployment table rather than written out, because a formula an agent is only told about is one it
  cannot apply and a hand-written list is one that goes stale.
- `parseRpcUrls` takes the deployment, and `client.test.ts` pins the precedence in both directions:
  the variable is read when the flag is absent, and loses to it when it is not. A third test pins
  that neither deployment's variable answers for the other.
- Registering a further deployment adds a variable by formula, with nothing to remember.
- If a future command ever needs a *global* endpoint — one not tied to a deployment — it does not
  get one from this mechanism, and should not invent one that sidesteps it.
