# 06: Stranger-facing docs and sweep

**What to build:** Someone arriving at this repo without the context of this work finds a `README.md`
that matches the tool, and an agent reading the skill finds the deployment vocabulary it needs. The
root note that started this feature is gone, and no document still claims the tool serves one chain.

**Blocked by:** 04.

**Status:** done, 2026-09-10 — `SKILL.md` 1.1.0, `spec/README.md`, `spec/00 §8`, `spec/01` preamble, `spec/05 §3`

- [x] `README.md` reflects the changed command surface, the new option, the envelope's deployment
      fields and the new error codes. It keeps restating few surfaces on purpose — options point at
      the help output, addresses at the ADR that owns them.
- [x] The agent skill carries the deployment vocabulary and the two slugs, and says which deployment
      is the live one, so an agent does not answer a question about real activity with test data.
- [x] The remaining specification sections that make single-deployment claims are updated: the chain
      facts, and the verification section covering the acceptance test.
- [x] The root note this feature came from is deleted, and nothing in the tree cites it. Citations
      point at in-tree documents only — an untracked file's citations die with it.
- [x] The README's Roadmap still names nothing its Status table lists.
- [x] The vocabulary guard passes: the rendered help and machine-readable surfaces use the glossary's
      terms in every role a description can put them in.

## What this closed, and what it did not

**A broken build, found on the way in.** `pnpm build` failed at `HEAD`: ticket 04 added `testnetViem`
to `src/core/deployment.ts` and never to the bundler alias `build/kleros-deployments.mjs`, which only
`pnpm build` resolves. `pnpm test` and `pnpm typecheck` both stayed green because vitest resolves the
real package subpath. A stranger following this README's Install steps hit it immediately, which is
what made it this ticket's business. `src/__tests__/build-alias.test.ts` now asserts the alias exports
every name `deployment.ts` imports, plus one `*Viem` namespace per served deployment — falsified by
removing the fix, which fails it by name.

**A review of this ticket's own fresh work found six defects in it, all fixed.** Two were claims the
prose invented rather than inherited: `spec/01 §3.1` had grown a template-registration rationale for
routing through `DisputeResolver` that nothing in the tree supports — `CONTEXT.md`'s uniformity
argument is the real one — and `spec/01 §5` asserted that an EOA-to-core call reverts bare on the
testnet, which **nothing has measured**. The other four: the skill told agents to read `deployment`
and `chainId` on failure envelopes, where incur's closed envelope means neither field exists
(`ADR-0013`) — `deploymentEcho`'s own docstring said "success or failure" and is what the skill was
written from, so that comment is corrected too; the skill claimed both unserved-slug refusals name a
replacement, and the devnet one does not; `spec/05 §4` said "two checks" have no testnet counterpart
when it is most of the block; and `README.md` and `spec/README.md` both still carried "an EOA
**cannot** call `KlerosCore.createDispute`" unqualified, which this ticket's own `§3.1` edit had just
contradicted.

**Deliberately not done: `HANDOFF_DISPUTANT_CLI.md`.** It is untracked and was never tracked, yet
four tracked documents cite it — `CLAUDE.md` ×2, `spec/appendix-a` ×2, `spec/README.md` ×1 — so this
ticket's own rule about citations is broken tree-wide by a note that predates the feature. It is not
"the root note this feature came from" and the fix is a content migration needing judgment about
what in §10, §14 and §15 is still true, so it is ticket 08 rather than scope here. Worth knowing
before that ticket starts: `spec/appendix-a §3` already quotes each superseded §14 claim verbatim
before correcting it, so §14's substance is in-tree already and only the pointer dangles.

**`package.json`'s `test:acceptance` was repointed** from `acceptance.fork.test.ts` to
`acceptance.testnet.test.ts` and lost its `KLEROS_ARCHIVE_RPC` plumbing, to match the rewritten
`spec/05 §3`. Both names point at a file that does not exist and fail identically; ticket 05 writes
it.
