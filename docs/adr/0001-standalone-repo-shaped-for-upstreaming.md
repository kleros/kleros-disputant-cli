# Standalone repo, shaped for upstreaming into `@kleros/agentkit`

Kleros AgentKit performs no on-chain writes, and its write path has not landed across four
milestones — it is tracked as `V2BETA-create` / `SEED-011`, its seed file is marked `dormant`, and
it is explicitly *"deferred past v1.4 per user decision 2026-08-12"*. Its wallet middleware is
documented but absent: a 23-line error-factory stub with zero callers. Meanwhile an autonomous
agent acting for a party to a dispute needs to file and to submit evidence now.

This repo is therefore a separate spike rather than a branch of AgentKit — but it mirrors
AgentKit's conventions (`incur`, a framework-free `core/` returning `KlerosResult<T>`, a thin
`commands/` layer, CTA blocks, `--format json`) so the eventual port is close to a file move rather
than a rewrite. It is the second such spike; `kleros-juror-cli` made the same argument for the
juror role and its ADR-0001 is this one's ancestor.

## This is a deliberate deviation from AgentKit's written scope

AgentKit's `docs/knowledge/scope-and-posture.md` lists *"evidence submission in future"* as
in-scope arbitrable expansion, and applies a frontend-parity test — *can you do this from
court.kleros.io / curate.kleros.io?* Creating a dispute and submitting evidence are unambiguously
yes. So this is not a gap in AgentKit's scope that a new repo fills; it is a decision AgentKit has
already written down, taken the other way. Naming that is the point of this record.

## Considered options

- **Depend on `@kleros/agentkit` as a library.** Rejected: couples an urgent path to AgentKit's
  release cadence and planning process, and its `exports` map only exposes `.` for a read-oriented
  surface — so it would buy almost nothing even if the cadence were not a problem.
- **Build the write commands directly in AgentKit.** Rejected: AgentKit serves a broad audience
  across several chains and setups, which drags in wallet middleware, multi-chain key handling and
  a general `--dry-run` story. This spike defers all of that deliberately.
- **Fully standalone with its own conventions.** Rejected: discards the spike's second purpose,
  which is to tell AgentKit how writes should work in runnable code rather than in prose.

## The cost this accepts

Two standalone write CLIs means two signers, two broadcast gates and two pre-flight disciplines to
keep in step. And this path needs *more* of AgentKit's read surface than the juror path did — a
disputant has to know which arbitrable, which court, which template, what the other side filed.

The resolution that keeps both: **treat AgentKit as a peer CLI the agent also calls**, not a
library. `kleros dispute policy` and `kleros arbitrable classify` before writing; `kleros evidence
list` to verify after. Two processes, one agent, no shared build.

## Consequences

The scope line is **filing**, not **case construction**. Turning an already-built case into a
transaction is frontend-parity work and sits inside AgentKit's scope principle; deciding whether to
bring a claim, drafting the evidence and choosing the court is higher-level analysis and stays
outside both projects. See `CONTEXT.md`.

That line is what keeps ADR-0007 true. The moment this tool starts reasoning about a case rather
than transcribing one, it needs to read the other side's material, and the opacity invariant is
gone. The scope boundary is not tidiness; it is the load-bearing half of the trust boundary.
