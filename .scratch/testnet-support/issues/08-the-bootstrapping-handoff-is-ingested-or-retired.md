# 08: The bootstrapping handoff is ingested, or retired

**What to build:** No tracked document cites a file that a fresh clone does not have. Whatever in
`HANDOFF_DISPUTANT_CLI.md` is still true lives somewhere under `docs/` with an owner; whatever is
stale is gone rather than quietly cited.

**Blocked by:** nothing. It predates this feature and is independent of 05 and 07.

**Status:** done, 2026-09-10 — retired. `spec/appendix-a §3` (reframed, +§3.8, +§3.9), `spec/01 §1.0b`, `spec/02 §3.1`, `spec/README` (+`[docs]` marker), `CONTEXT.md`, `CLAUDE.md`, `README.md`, `.gitignore`, `citations.test.ts`

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

- [x] Every §10, §14 and §15 claim a tracked document depends on is either verified and given a home
      under `docs/` with an owner, or established as stale and dropped. Each disposition is recorded,
      because a claim someone already believed is worth a line even when it is wrong.
- [x] No tracked file cites `HANDOFF_DISPUTANT_CLI.md`, by filename or as "the handoff", unless the
      file is committed. If it is committed instead, that is a decision and needs a sentence saying
      why a superseded document is worth shipping.
- [x] `spec/appendix-a §3` either keeps its subject or is retired deliberately — not left as a list
      of corrections to a document nobody has.
- [x] `CLAUDE.md`'s build-order line points at something a fresh clone can read, or goes.
- [x] The repo's own rule holds tree-wide: a citation resolves in a fresh clone.

## Comments

### 2026-09-10 — retired, not ingested wholesale. The dispositions.

**The decision: retired.** The maintainer's reading held up — nothing in the document was load-bearing
in a way the tree did not already carry, once each claim was checked rather than assumed. The file is
left on disk untracked and is now named in `.gitignore`, so the `git add -A` near-miss ticket 06
recorded cannot happen. Deleting it is the maintainer's to do whenever.

**§10, the build order — spent.** Steps 1–13 are done and step 14 is ticket 05, so the table
sequences nothing that is still ahead. Its two lessons were already in-tree and were checked, not
assumed: "documentation and guards before domain logic, vocabulary guard early" is `CLAUDE.md`'s
Process section, and "ADR-0005 → ADR-0006 was a reversal, start at the end state" is
`ADR-0006:15-18`. Its commit conventions are `CLAUDE.md`'s Process section verbatim. **Dropped:** the
pointer at `b07420c` in the juror repo as the exemplar commit message — it is a commit in a
repository reached only through a gitignored symlink, so it could not resolve in a fresh clone even
if the handoff had been committed. `CLAUDE.md` states the convention in full prose instead.
`CLAUDE.md`'s "Build order: `HANDOFF §10`" line is gone.

**§14, the write surface — superseded, and mostly already rehoused.** `spec/appendix-a §3` was
verified to quote its subject rather than merely cite it: 3 of 7 rows quote verbatim, 3 restate the
claim closely enough to stand alone, and §3.5 corrects an *omission*, which cannot be quoted. So §3
survives its subject. It was reframed to say what the document was and that its `§14.x` labels are
now internal.

Migrated, each re-verified rather than imported:
- **The published docs' template examples name an arbitrator that is not `KlerosCore`** → `spec/02
  §3.1`, as a warning. Re-verified on **2026-09-10** by reading `docs.kleros.io` directly, which
  upgraded it from an inherited claim to a measured one and produced the full address — so the
  elided form in the handoff never had to be expanded by hand. This one serves **ticket 07** and was
  the sharpest thing in §14 that existed nowhere else.
- **`ArbitrableExample` is in `testnetViem` and `devnetViem` and absent from `mainnetViem`;
  `ModeratedEvidenceModule` is in none** → `spec/01 §1.0b`. Re-verified **[abi]** against the
  installed package. It belongs there because it is a second instance of the section's own point:
  the namespaces differ in which *contracts* they carry, not only in one contract's entries.
- **A `[docs]` verification marker** → `spec/README`. The published documentation was a source with
  no marker, and the row above is a claim about it. Weakest marker in the table, and the entry says
  so.

Dropped, with the reason, rather than imported unverified:
- **The Gated / GatedShutter kit-data encoding** (`uint88`/`bool`/`address` packed into a `bytes32`
  with a `tokenId`). Unverified in the handoff, and for kits this CLI does not support — `spec/02 §2`
  keeps the fact that the blob is 160 bytes, which is what a reader needs to refuse one.
- **`DisputeKitClassic.fundAppeal` as "a plausible slice 2, not researched".** Speculation about
  scope, not a fact, and `ADR-0001` owns scope.
- **Selector `0xb2995659` for `arbitrableWhitelistEnabled()`.** A reproduction detail; the fact that
  the accessor is absent from the deployed core is at `spec/01 §2` and `spec/05`.
- **The §14 preamble's provenance** — verified 2026-09-04, re-run by a second agent. Superseded by
  the spec's own 2026-09-08/09 pinning, which is stronger and reproducible.
- **§14.3's "ship slice 1 as pure RPC"** — already reversed by `ADR-0012`. Stale by design.

**§15, the vocabulary — superseded by `CONTEXT.md`, with one gap.** Every avoided term with a real
reason is in `CONTEXT.md`, in `vocabulary.test.ts`'s `FORBIDDEN`, or both. **Ingested:** avoid
*owner* of these contracts — the deployed ones expose `governor()`. It was the one §15 rule in
neither, and it is now on `CONTEXT.md`'s **Arbitrable** entry, deliberately not in `FORBIDDEN`
because *owner* is correct for a key. **Three §15 rulings did not survive and are now corrected by
name in `spec/appendix-a §3.9`** — §3 previously covered §14 only, so they were corrected nowhere.

**One §14 claim was corrected nowhere and now is: `spec/appendix-a §3.8`.** §14.5's headline said the
first argument to `submitEvidence` is the KlerosCore dispute ID. That is the single §14 sentence this
CLI acted on wrongly, until `ADR-0014`; §3.3 corrected the *subgraph* half of the same bullet and
left the headline standing. Retiring the document without adding this row would have deleted the
provenance of the repo's most expensive belief.

### The rule is now machine-checked — `src/__tests__/citations.test.ts`

A sweep closes today's breach; it does not stop tomorrow's, and this breach survived a sweep in
ticket 06. The test asserts that every citation in a reader-facing document resolves in a **fresh
clone**, checked against `git ls-files`. Two rules: markdown links (resolved from the citing file's
own directory, directories included), and backticked `.md` filenames (resolved by basename at any
depth). **Falsified before trusted** — at `HEAD` it failed on exactly the five reader-facing
citations of the handoff and nothing else, and re-adding one to `CLAUDE.md` fails it again.

Two scope decisions, both stated in the test's own docstring:
- **`.scratch/` is excluded.** The issue tracker is a record of work, and this file — which names the
  handoff seven times — is reporting history accurately. Making the record cite only live files would
  mean editing the past to fit the present. Git history is out of scope for the same reason. This is
  the "Done when" checkbox's *unless committed* clause answered deliberately rather than evaded.
- **Bare source filenames (`reverts.ts`) are not checked.** Several resolve to more than one file or
  to a file in another repo. Widening means teaching the test which repository each backtick means.

`NOT_A_CITATION` holds three external or template names, and one **file-scoped** entry letting
`appendix-a` name the retired document once. Scoped, because a bare entry would exempt the name
everywhere and turn off the rule.

### Found on the way, not fixed here

- **This ticket's own inventory had drifted.** It gave `CLAUDE.md`'s build-order pointer at lines
  35/198; it was at 39/202. And the true citation count was higher than the table said — `CLAUDE.md`
  ×3 and `appendix-a` ×3, plus 17 bare `§14.x` back-references. Ticket 06's note understated it too.
  A citation inventory written by hand goes stale exactly like the citations it inventories, which is
  the argument for the test above.
- **`spec/00 §8` does not exist** — `docs/spec/00-overview.md` has no numbered sections at all, and
  seven headings. Cited in ticket 06's own Status line. Left alone: `.scratch/` is a record.
- **`ADR-0010 §28`**, cited by ticket 07, is a line number written as a section marker.
- **`spec/05 §2.6` and `§2.7`**, cited from `spec/01:436` and from ticket 05, address numbered list
  items rather than headings. Resolvable, but by an undocumented convention.
- **Ticket 07 cites `reference/agentkit/node_modules`** without the absence caveat that `CLAUDE.md`'s
  Reference material table carries — the only `reference/` citation in the tree lacking it.

### Reviewing this ticket's own work found eight defects in it

Two reviews — a code review and an adversarial fact-check — ran over the finished diff. Both found
real defects, and **two of them were claims this ticket had just called "re-verified"**. That is the
sharper lesson: re-verification reproduced the source's imprecision instead of catching it.

**Falsified, in the migration itself:**
- **"v2 Beta ships no second arbitrable in the package at all"** — false. `mainnetViem` exports
  `disputeResolverRuler*`, whose ABI carries `rule`, `disputes` and `arbitratorDisputeIDToLocalID`,
  and it is in `spec/01 §1`'s own address table 70 lines above. The handoff's original wording was
  *qualified*; the migration dropped the qualifier and hardened it. Now split into what is true —
  no `ArbitrableExample` **deployed** on beta — plus **[live]** `DisputeResolverRuler.arbitrator()`
  is `KlerosCoreRuler`, measured here, not relayed.
- **"`ModeratedEvidenceModule` exists in the package's Solidity only"** — false. Its `__factory` has
  a 30-entry ABI and ~7.8 KB of deploy bytecode. The accurate claim is that it has no address in any
  viem namespace. Doubly embarrassing because the paragraph links to `spec/01 §2`, which is the
  section about not reading deployment claims off a `__factory`.

**Incomplete or under-identified:**
- **The warning covered `arbitrum-one` only**, on the day this repo serves two deployments. The same
  docs page pairs `"421614"` with `0xD08Ab994…`, which is neither the testnet core nor the devnet's.
  An operator on `--chain arbitrum-sepolia-testnet` would have read a warning that did not apply.
- **"a different contract" was too weak.** **[abi]** it is `xKlerosLiquidAddress` for chain `100` —
  Kleros **v1** on **Gnosis**. The example is wrong in both fields at once. A warning whose whole
  purpose is recognition has to say what the thing is.
- **The docs do not merely carry it, they assert it** — `/developers/arbitrable-apps/
  arbitrable-production` annotates that address `// ✓ KlerosCore on Arbitrum One`, on the same page
  as its own "`arbitratorAddress` matches deployment" checklist item. Follow the checklist against
  the example and you pass.
- **`spec/02 §3.1`'s `arbitratorChainID` row still said `"42161"`** one row above the
  `arbitratorAddress` row this ticket had just generalised — the table contradicted itself, making
  exactly the pairing mistake the warning attacks.

**Overstated, in the corrections:**
- **`CONTEXT.md`'s new `owner` rule generalised past its evidence.** "the deployed ones expose
  `governor()`" is false of the devnet, whose core has `owner()` and no `governor()` —
  `spec/01 §7.1` records it. Scoped to the two served deployments, with the devnet named.
- **§3.9 misquoted §15 on *answer*.** §15 listed *ruling option* **and** *answer* in one
  slash-group; the row implied it preferred *answer* and was reversed. It was narrowed, not
  reversed — and *answers* is still the template field's name, which is why the word is not in
  `FORBIDDEN`.
- **§3.9's "wrong twice over" was wrong once.** No ABI in any namespace uses *evidence group*, so
  the parameter name corroborates §15's literal claim rather than refuting it. Only the second half
  — "the first arg is the dispute ID" — is wrong, and §3.8 already carries that.

**And in the guard test:**
- **The filename rule matched only bare names**, so seven live path-prefixed citations went
  unchecked and `` `docs/HANDOFF_DISPUTANT_CLI.md` `` would have passed — while `CLAUDE.md` had just
  been made to promise the rule is absolute. Widened to both forms, which immediately found the two
  foreign-repo paths now in `NOT_A_CITATION`. Re-falsified against all three shapes.
- Two allowlist entries broke the key policy the file's own docblock states — `CONTEXT-MAP.md` and
  `map.md` are this repo's path templates and were registered bare, exempting them tree-wide. Now
  scoped. `docs/knowledge/scope-and-posture.md` is scoped for a sharper reason: `docs/knowledge/` is
  a directory we have, so a bare key would hide a genuine dangling pointer under a path shape of
  our own.
- `isExternal` mishandled root-absolute hrefs and unknown URI schemes; files were enumerated from
  the index but read from the working tree, so a delete without `git rm` would have taken the suite
  down with an ENOENT saying nothing about citations. Both fixed, neither reachable today.
- `.gitignore`'s pattern was unanchored, matching at any depth while its comment said "root note".

### `dev` or `master`? — raised as out of scope, then settled by the maintainer

The fact-check surfaced a pre-existing contradiction: `spec/01 §2` said the package's `.sol` sources
and its `*__factory` exports "track upstream **dev**", while `ADR-0006`, `CLAUDE.md`'s Stack
blockquote and `spec/README`'s all said they are "compiled from **master**". Five sites, directly
opposed, and two of them cited by sections this ticket had just edited.

**[maintainer]**, 2026-09-10, asked rather than measured harder: *"the package solidity contracts do
track the dev branch. But the v2 beta and testnet viem deployment artifacts are not impacted by
contract changes in dev. They accurately track the live version of the contracts for those
deployments."*

So `spec/01 §2` was right and four documents were wrong, and the second sentence is a **stronger
claim than the repo made anywhere**. Every site now says `dev`, and `spec/01 §2` is rewritten as the
canonical statement of both halves:

- the `.sol` sources and the `*__factory` exports compiled from them track `dev`;
- the `*Viem` **deployment artifacts** track the live contracts of *their own* deployment and are
  unaffected by `dev`.

That second half is what makes `ADR-0006`'s import safe rather than merely convenient, and it is
why **[abi]** is a claim about a deployment rather than about a branch — so `ADR-0006` and
`spec/README`'s marker blockquote now say it too.

**A consequential knock-on: the fingerprint test's stated purpose was wrong.** `spec/01 §1`,
`spec/05 §1.6` and `ADR-0006` all justified it as catching "an upstream regeneration from
`master`" — but if the artifacts track live deployments, a regeneration is not the risk. What the
fingerprint actually guards is a release that swapped a deployment artifact for something compiled
from the package's Solidity. Same test, and now the reason given for it is the reason it holds.

`spec/01 §7.1`'s remaining `master` claim was reframed rather than deleted, and then **corrected a
second time**. The first attempt concluded "**`dev` is not deployed**" — wrong, and the maintainer
said so: *"it is deployed on arbitrum-sepolia-devnet, but this deployment is out-of-scope for our
project here."* `dev` is live; it is simply live on a deployment `--chain` refuses.

**That turned out to explain the trap `spec/01 §2` documents.** The `*__factory` exports are not a
vague reading of an unreleased branch — **[abi]**, verified row by row, they match `devnetViem`
*exactly* on all five known divergences (`owner()`/no `governor()`, one create function, 3-argument
`DisputeRequest`, five custom errors, `arbitrableWhitelistEnabled` present), and both served
deployments differ from them identically. The factory reads like the devnet because it is compiled
for the devnet.

So §2's "Known divergences" table is not source-versus-artifact. It is **one deployment generation
against another**, and what disqualifies a `__factory` reading here is **scope, not provenance**:
the claim is `[abi]` about `arbitrum-sepolia-devnet` and `[inferred]` about anything else. That is
why the mistake survives scrutiny — nothing about the reading looks wrong, because nothing about it
*is* wrong. It answers a question nobody here asked. §2 now says that, and its offline repro block
carries the `devnetViem` row next to the factory's so the match is visible rather than asserted.
