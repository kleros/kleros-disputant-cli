# 01: Deployment vocabulary and the model documents

**What to build:** The word **deployment** becomes a term this repo defines, so that every later
ticket can say "deployment" and mean one thing. A reader who asks "why is the flag named for a chain
when it selects a deployment?" finds an answer, and the startup-ordering rule says what it actually
protects rather than a proxy for it. Documentation only: no file under `src/` changes.

**Blocked by:** None (can start immediately).

**Status:** done, 2026-09-09 — `ADR-0015`, `spec/03 §7`, `CONTEXT.md`

- [x] `CONTEXT.md` defines **Deployment**: one address set of the Kleros v2 contracts; a chain may
      host several, so a chain ID does not name one. Includes an `_Avoid_` line.
- [x] **Neo** is sharpened to a technical codename that appears in code comments and is explicitly
      not user-facing.
- [x] The **Arbitrable** entry is rescoped. The arbitrable whitelist is a v2 Beta property —
      measured absent on the v2 testnet, where the selector reverts bare while the same calldata
      returns false on Beta — so it is recorded as how the constraint was discovered, not as the
      justification for routing every dispute through the dispute resolver. The routing decision
      stands on uniformity: one write path, one payload builder, one set of test vectors.
- [x] The court-range figure names the deployment it was counted on rather than reading as universal.
- [x] A new ADR records the deployment model: that `--chain` keeps the sibling CLI's name for
      consistency across the two tools an agent calls, while naming a deployment underneath; that at
      least three deployments share one chain ID on Arbitrum Sepolia, so a chain ID cannot identify
      one; and that the startup ordering therefore inverts.
- [x] The startup-checks section of the specification is restated. The invariant becomes **"no
      contract call before the chain assertion"**, replacing "no deployment registry lookup before
      it". The recorded order is: slug, deployment, expected chain ID, chain assertion, first
      contract call. The section explains that the old rule was a proxy — resolving addresses is a
      local act, using them on an unverified chain is the hazard — and that nothing is weakened,
      because the caller now names the deployment instead of it being inferred from the chain.
- [x] `CLAUDE.md`'s chain-only invariant is replaced by one describing the deployment model, in one
      line with a pointer, per that file's own rule about being an index.
- [x] No file under `src/` is modified. The existing suite passes unchanged.

## Comments

**2026-09-09** — Done in `cba7442`. Two notes for the tickets that follow.

**Restating `spec/03 §7` exposed three sites still carrying the retired rule**, all fixed in the
same commit: `spec/00`'s Normative summary stated it as a **MUST**, `spec/01`'s read-surface table
said the assertion "runs before every registry lookup", and `spec/03`'s own error table defined
`WRONG_CHAIN` as `eth_chainId != 42161`. The `[live]` marker's definition in `spec/README.md` also
admitted only a later block on Arbitrum One, so this ADR's and `ADR-0014`'s testnet measurements sat
outside their own legend; it now admits a cited deployment and block.

**A safety claim was drafted and removed, and ticket 03 should not re-derive it.** The arbitrable
self-assertion does **not** catch an endpoint serving a sibling deployment on the same chain: the
endpoint does not choose the contracts, the address resolution does, and every deployment on a chain
is reachable from any endpoint serving that chain. A mis-pointed endpoint can only be wrong about
the chain, which the assertion catches. Step 4 catches a stale registry entry or an upstream
redeployment.

**Left for the tickets that own them.** `README.md:286` and `skills/kleros-disputant/SKILL.md:41`
still state the retired proxy rule — true of today's code, and ticket 06's. The comments in
`src/core/client.ts:19-22,69`, `src/commands/shared.ts:439-445` and
`src/core/__tests__/client.test.ts:191` restate it too, and `client.ts:69`'s "`spec/03 §7` step 1"
now points at the wrong step: the chain assertion is step 3 and command pre-flight is step 6.
Ticket 03 rewrites that code.
