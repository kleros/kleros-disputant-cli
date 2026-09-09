# 03: `--chain` exists, with v2 Beta the only value served

**What to build:** A caller can name the deployment explicitly, and every result says which
deployment it came from. Asking for a deployment this tool does not serve gets a named refusal
before anything is contacted, instead of silence or a transport error. Behaviour for every existing
invocation is unchanged: the default is v2 Beta, and a command run without the new option does
exactly what it did before.

Only `arbitrum-one` is served by this ticket. The second deployment arrives in 04.

**Blocked by:** 01.

**Status:** done

- [x] A new module owns the slug-to-deployment table: a small, closed, pure structure with no
      dependency on the contracts package, mapping a slug to that package's deployment key, the
      expected chain ID, the default endpoint, and the name of the deployment's RPC override
      variable — derived by formula, never written twice.
- [x] The deployment module stops resolving addresses and ABIs at module load and becomes a function
      of a deployment.
- [x] `--chain`, alias `-c`, is declared **per command** on every command that touches the chain, and
      is absent from `upload-file`. It is not a root option: the framework's global mechanism reaches
      handlers but is never merged into the machine-readable tool schemas, so a root declaration
      would silently vanish from every structured call.
- [x] The gloss pairing each slug with the name humans use for it appears **once**, in the `--chain`
      description. It is not repeated in other help strings, messages or CTAs.
- [x] A new `CHAIN_NOT_SUPPORTED` code refuses: the devnet slug, with a message saying its write
      surface differs and is unsupported here even though the sibling read tool serves it; the
      retired bare Arbitrum Sepolia slug, naming both replacements and reusing the sibling's wording;
      and any unknown slug. It is distinct from the existing wrong-chain code, which means the
      endpoint answered an unexpected chain ID — a runtime condition, where this is an input one.
- [x] The refusal happens before any network contact, asserted by a test showing zero round trips.
- [x] Every envelope echoes the resolved deployment slug and the asserted chain ID, on success and on
      failure, alongside the effective court, juror count and dispute kit already reported.
- [x] Every CTA carries `--chain`. The court-listing hint no longer hardcodes a slug — as written it
      would send a caller to look up a court on a deployment other than the one that refused.
- [x] The chain-specific public exports are renamed: the assertion helper becomes a function of a
      deployment, and the single default-endpoint constant becomes per-deployment.
- [x] Omitting `--chain` resolves to `arbitrum-one`. No environment variable and no configuration
      file selects the deployment.

## Comments

**2026-09-09** — Done. Suite 366 → 407, `pnpm test:fork` re-run and green at 12/12 against a real
Arbitrum One fork, which is what proves the refactor holds against the deployed contracts rather
than only against the doubles.

**Module split.** `deployments.ts` is the new table — pure, closed, importing neither the contracts
package nor a transport, which is what makes the refusal offline by construction. `deployment.ts`
kept its name and became `contractsFor(deployment)`, memoised per slug. The two read as
plural-table / singular-resolution; the function names are what disambiguate them at an import site.

**The table writes each chain ID down and the fingerprint test checks it against the package.**
Neither is the single source of truth, deliberately: a divergence — an upstream re-key, a typo —
fails the build rather than sending a transaction to an endpoint the assertion then waves through.

**A prototype-key hole was found and closed, and ticket 04 must not reopen it.** The slug is
operator input indexing an object literal, and a plain object answers `constructor`, `toString` and
every other `Object.prototype` key with something truthy. Before the fix, `--chain constructor`
resolved to a function, walked past the refusal and threw out of the core as an `UNKNOWN` envelope.
Both lookups now go through `Object.hasOwn`, and five prototype keys are pinned in
`deployments.test.ts`.

**`reverts.ts` spans deployments instead of taking one.** Its selector table is now built over every
served deployment's three ABIs. Decoding is a lookup, not a decision: a selector present on one
deployment and absent on another still names the same error, and naming it can only improve a
message. Threading a deployment through `broadcast.ts` — which has no other reason to know one —
would buy nothing.

**Failures carry the deployment in the `message`, because nothing else renders.** incur's error
envelope is closed to `{code, message}` and a `cta` (`ADR-0013`), so `finish` appends
`Deployment: <slug> (chain <id>).` It closes the sentence first: `rpcError` appends the node's own
words verbatim and a node does not punctuate, which ran the two together. Nothing is appended when
the slug did not resolve — `CHAIN_NOT_SUPPORTED` names what was asked for, and echoing a resolved
slug there would name one the caller did not choose.

**The `rpcUrlVariable` field is derived but not yet read.** Ticket 03 asks the table to carry it;
ticket 04 owns honouring it, where a second default endpoint first gives it a caller. The formula
matches agentkit's `rpcEnvVarName` and is pinned per slug in `deployment.test.ts`.

**Three message strings were de-scoped from Arbitrum One** so they do not become false when 04
lands: the `INSUFFICIENT_BALANCE` funding hint, the kit-support refusal, and the `--kit`
description. Comments carrying a `[live]` marker keep their attribution — a measurement names where
it was taken.

**Left for the tickets that own them.** `README.md:286` and `skills/kleros-disputant/SKILL.md:41`
and `:204` still state the chain-42161 rule, as do `spec/01 §1`'s heading and `spec/README.md`'s
Network row — ticket 06's. `spec/03 §3.1`, `§4`, `§5.5` and `§7` are updated here.

**One thing neither 03 nor 04 owned — now ticket 07.** A dispute template carries
`arbitratorChainID` and `arbitratorAddress` as **operator-supplied** fields (`template.ts`), and
nothing checks them against the selected deployment. This note originally called that invisible on
one deployment, which was **wrong**: `spec/05 §6` already records that the published Kleros
documentation's template examples name an `arbitratorAddress` that is not the deployed
`KlerosCore`, so it is reachable on `arbitrum-one` today. Ticket 07 has the measurements, including
that both fields are inert in `@kleros/kleros-sdk@2.4.0` and in AgentKit — so the harm is
provenance, not misrouting.

**Code review, six findings — four acted on, one already decided, one is the note above.**

1. **`upload-file` failures claimed a deployment.** `deploymentSuffix` resolved an absent `--chain`
   to the default, so the one command with no chain in it appended
   `Deployment: arbitrum-one (chain 42161).` to every refusal — contradicting `spec/03 §3.4` and
   the diff's own reasoning in `uploadSuccessCta`. An absent `chain` in the CTA context now means
   *this command has no deployment*, never *the default applied*; the two cannot be confused at the
   CLI boundary because `--chain` carries a zod default, and `finish` is not exported from
   `index.ts`, so that boundary is the only one.

2. **`arbitrum-sepolia-testnet` fell through to the typo wording.** The retired-slug guidance sends
   a caller to that slug, which then answered `Unsupported chain: "arbitrum-sepolia-testnet"` — the
   same sentence `arbitrum-sepolio` gets. An agent following the tool's own correction landed on
   what read like a second mistake. It has its own `UNSERVED` entry saying the deployment is real
   and unserved here. **Ticket 04 deletes that entry**; `deployments.test.ts` fails until it does.

3. **`broadcast.ts` still hardcoded `chain: arbitrum` — the one real latent bug.** The signing path
   took `client` and `rpcUrls` but no deployment, so viem put chain ID 42161 into the EIP-155
   signature whatever `--chain` selected. On the testnet that would pass the chain assertion, the
   quote and the balance check and only then be rejected as `BROADCAST_FAILED`, after a full
   pre-flight. `BroadcastParams` now carries the deployment. `pnpm test:fork` re-run after the
   change: 12/12, which is the only way to exercise a signed transaction.

4. **The README examples were stale.** The `arbitration-cost` payload lacked `deployment` and
   `chainId`, the error payload lacked the new sentence, the CTA lacked `--chain`, and the
   safety bullet still stated the retired proxy rule inverted. All four fixed — that is `CLAUDE.md`'s
   rule that a change to the envelope is a change to the README. **The rest of the README stays
   ticket 06's**: the Arbitrum One framing, the badge, and `skills/kleros-disputant/SKILL.md`.

5. **`EXPECTED_VERSIONS` staying deployment-independent is not a defect.** It was measured:
   `.scratch/testnet-support/spec.md` records that both deployments report the same versions for the
   two contracts exposing one, so no per-deployment table is needed. Left as is, deliberately.

6. **The slug is now resolved before every other local check**, in all four commands. `prepareLocal`
   already argued this for the key file — a caller who named an unserved deployment should be told
   that, not that their key is unreadable — and the same reasoning applies one layer up, where
   `create-dispute --chain bogus --template-file /missing.json` reported `TEMPLATE_INVALID` and made
   the caller fix the template before learning the real problem.
