# 01: Deployment vocabulary and the model documents

**What to build:** The word **deployment** becomes a term this repo defines, so that every later
ticket can say "deployment" and mean one thing. A reader who asks "why is the flag named for a chain
when it selects a deployment?" finds an answer, and the startup-ordering rule says what it actually
protects rather than a proxy for it. Documentation only: no file under `src/` changes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `CONTEXT.md` defines **Deployment**: one address set of the Kleros v2 contracts; a chain may
      host several, so a chain ID does not name one. Includes an `_Avoid_` line.
- [ ] **Neo** is sharpened to a technical codename that appears in code comments and is explicitly
      not user-facing.
- [ ] The **Arbitrable** entry is rescoped. The arbitrable whitelist is a v2 Beta property —
      measured absent on the v2 testnet, where the selector reverts bare while the same calldata
      returns false on Beta — so it is recorded as how the constraint was discovered, not as the
      justification for routing every dispute through the dispute resolver. The routing decision
      stands on uniformity: one write path, one payload builder, one set of test vectors.
- [ ] The court-range figure names the deployment it was counted on rather than reading as universal.
- [ ] A new ADR records the deployment model: that `--chain` keeps the sibling CLI's name for
      consistency across the two tools an agent calls, while naming a deployment underneath; that at
      least three deployments share one chain ID on Arbitrum Sepolia, so a chain ID cannot identify
      one; and that the startup ordering therefore inverts.
- [ ] The startup-checks section of the specification is restated. The invariant becomes **"no
      contract call before the chain assertion"**, replacing "no deployment registry lookup before
      it". The recorded order is: slug, deployment, expected chain ID, chain assertion, first
      contract call. The section explains that the old rule was a proxy — resolving addresses is a
      local act, using them on an unverified chain is the hazard — and that nothing is weakened,
      because the caller now names the deployment instead of it being inferred from the chain.
- [ ] `CLAUDE.md`'s chain-only invariant is replaced by one describing the deployment model, in one
      line with a pointer, per that file's own rule about being an index.
- [ ] No file under `src/` is modified. The existing suite passes unchanged.
