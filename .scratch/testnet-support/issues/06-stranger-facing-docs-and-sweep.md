# 06: Stranger-facing docs and sweep

**What to build:** Someone arriving at this repo without the context of this work finds a `README.md`
that matches the tool, and an agent reading the skill finds the deployment vocabulary it needs. The
root note that started this feature is gone, and no document still claims the tool serves one chain.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `README.md` reflects the changed command surface, the new option, the envelope's deployment
      fields and the new error codes. It keeps restating few surfaces on purpose — options point at
      the help output, addresses at the ADR that owns them.
- [ ] The agent skill carries the deployment vocabulary and the two slugs, and says which deployment
      is the live one, so an agent does not answer a question about real activity with test data.
- [ ] The remaining specification sections that make single-deployment claims are updated: the chain
      facts, and the verification section covering the acceptance test.
- [ ] The root note this feature came from is deleted, and nothing in the tree cites it. Citations
      point at in-tree documents only — an untracked file's citations die with it.
- [ ] The README's Roadmap still names nothing its Status table lists.
- [ ] The vocabulary guard passes: the rendered help and machine-readable surfaces use the glossary's
      terms in every role a description can put them in.
