# 08: The bootstrapping handoff is ingested, or retired

**What to build:** No tracked document cites a file that a fresh clone does not have. Whatever in
`HANDOFF_DISPUTANT_CLI.md` is still true lives somewhere under `docs/` with an owner; whatever is
stale is gone rather than quietly cited.

**Blocked by:** nothing. It predates this feature and is independent of 05 and 07.

**Status:** ready-for-agent

## Why this is a ticket and not part of 06

`HANDOFF_DISPUTANT_CLI.md` is **untracked, and was never tracked** — `git log --all --` for it is
empty, so it is not a file that was deleted but one that never landed. Five tracked documents cite
it anyway:

| File | Citations |
| --- | --- |
| `CLAUDE.md` | §14 supersession (line 17), the build-order pointer (lines 35, 198) |
| `docs/spec/appendix-a-unresolved.md` | the §3 heading and its preamble (lines 4, 100), plus `§14.8` at line 80 |
| `docs/spec/README.md` | "what `HANDOFF_DISPUTANT_CLI.md` §10 step 6 calls for" (line 13), and "that handoff" (line 14) |
| `docs/spec/01`, `docs/spec/02` | prose references to "handoff §14.1" and "handoff §14.6" |

Ticket 06 states the rule these break — *"Citations point at in-tree documents only; an untracked
file's citations die with it"* — but its checkbox names only **the root note that feature came
from**, which was `env-vars-and-testnet-support.md`. This one is older and unrelated to the testnet
work, and the fix is a content migration requiring judgment rather than a citation sweep. Folding it
into 06 would have put an editorial pass over five files into the same commit as the testnet sweep.

## What the next agent should not re-derive

- **§14's substance is already in-tree.** `spec/appendix-a §3` does not merely cite §14, it **quotes
  each superseded claim verbatim** before correcting it — §14.1 on `mainnetViem`, §14.2 on
  `DisputeResolver`'s reverts, and the rest. So the migration is smaller than the citation count
  suggests, and deleting the file risks losing little. What is genuinely open is whether §3 still
  earns its place once the thing it corrects is gone: it exists because `CLAUDE.md` and `CONTEXT.md`
  were written from §14, and that provenance is the argument for keeping it.
- **§14 is already declared superseded**, by `CLAUDE.md` and by `spec/README.md` both. Nothing should
  be *imported* from it as fact without re-verification — `CLAUDE.md` says to read it "only to
  understand where a stale belief came from".
- **The parts still load-bearing are §10 and §15**, not §14. `CLAUDE.md` leans on §10 for the build
  order (where the skill is step 12 and the README step 13) and names §15 as the vocabulary. Both are
  plausibly stale: the build order has been overtaken by this directory's ticket sequence, and
  `CONTEXT.md` superseded the vocabulary. **Verify before migrating; do not assume either is true.**
- **[maintainer]** The maintainer's reading, 2026-09-10: the handoff was the seed that let a coding
  agent initialise the project, is at best a historical record, and some of its content is *"probably
  stale already, if not outright obsolete"*. Ingestion is the goal; preserving the file is not.

## Done when

- [ ] Every §10, §14 and §15 claim a tracked document depends on is either verified and given a home
      under `docs/` with an owner, or established as stale and dropped. Each disposition is recorded,
      because a claim someone already believed is worth a line even when it is wrong.
- [ ] No tracked file cites `HANDOFF_DISPUTANT_CLI.md`, by filename or as "the handoff", unless the
      file is committed. If it is committed instead, that is a decision and needs a sentence saying
      why a superseded document is worth shipping.
- [ ] `spec/appendix-a §3` either keeps its subject or is retired deliberately — not left as a list
      of corrections to a document nobody has.
- [ ] `CLAUDE.md`'s build-order line points at something a fresh clone can read, or goes.
- [ ] The repo's own rule holds tree-wide: a citation resolves in a fresh clone.
