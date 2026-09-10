import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every citation in a document a reader follows resolves in a fresh clone.
 *
 * **This file exists because a citation can outlive its target in silence.**
 * `HANDOFF_DISPUTANT_CLI.md` was never tracked, yet six tracked documents
 * pointed at it — `CLAUDE.md` for the build order and the vocabulary,
 * `spec/README.md` for the document set's own reason to exist, `appendix-a §3`
 * for the claims it corrects, and `spec/01` and `spec/02` in prose. A fresh
 * clone had none of it and nothing failed, because prose is not compiled: a
 * dangling pointer costs a reader an afternoon and costs CI nothing.
 *
 * A fresh clone has exactly the git index. Not the untracked root notes a
 * bootstrapping session leaves behind, not the gitignored `reference/`
 * symlinks, not `node_modules`. So the index is what a citation is checked
 * against.
 *
 * **Scope: the documents a reader follows.** `docs/`, `skills/` and the four
 * root markdown files. `.scratch/` is deliberately excluded — the issue tracker
 * is a record of work, and a closed ticket naming a file that has since been
 * retired is reporting history accurately. Forcing that record to cite only
 * live files would mean editing the past to fit the present, which is the
 * opposite of what a record is for. Git history carries the same names for the
 * same reason and is equally out of scope.
 *
 * Two rules, both of them shapes this repo's citations actually take:
 *
 *   1. **Markdown links** — `[…](./x)`, `[…](../x)`, `[…](docs/spec/)`. A link
 *      is unambiguously a pointer at a file, and it resolves from the citing
 *      file's own directory, so a moved file breaks it two ways. A target
 *      ending in `/` is a directory and resolves if anything tracked is under
 *      it.
 *   2. **Backticked markdown filenames** — `` `CONTEXT.md` ``,
 *      `` `HANDOFF_DISPUTANT_CLI.md` ``, `` `docs/knowledge/…md` ``. This is the
 *      shape the retired handoff was cited in, and the shape a future one would
 *      take. A bare filename means "the file called that", so it resolves
 *      against any tracked file with that basename, at any depth; a **prefixed**
 *      one names a path and is checked as one. Both forms are live in this tree,
 *      and an earlier draft of this file matched only the bare one — which left
 *      seven citations unchecked and would have let `` `docs/HANDOFF….md` ``
 *      past a rule `CLAUDE.md` promises is absolute.
 *
 * Bare backticked *source* filenames (`` `reverts.ts` ``, `` `deployment.ts` ``)
 * are **not** checked. They name a module rather than a path, and several
 * resolve to more than one file in the tree or to a file in a different repo —
 * the SDK's `lib/src/…/disputeDetailsSchema.js`, the subgraph's
 * `EvidenceModule.ts`. Widening this test to them means teaching it which repo
 * each backtick means, which is a bigger lie than the gap it closes. Read this
 * comment before widening.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Documents a reader follows. `.scratch/` is excluded — see the note above. */
const READER_FACING = (path: string): boolean =>
  path.startsWith("docs/") ||
  path.startsWith("skills/") ||
  ["CLAUDE.md", "CONTEXT.md", "README.md", "CHANGELOG.md"].includes(path);

/**
 * Citations that are not pointers at a file in this repository. Each carries its
 * reason, because an allowlist without one is the test turned off.
 *
 * A key is either a bare target — exempt wherever it appears, for a name that
 * belongs to another repository and is cited from several documents — or
 * `citing/file.md::target`, exempt in that one document only.
 *
 * **Prefer the scoped form.** A bare key exempts the name tree-wide, which is
 * right for a foreign repository's file and wrong for everything else: a
 * retired document that one section names in order to retire it, or a path
 * template that reads like a citation. A bare key for either would let the same
 * name be written anywhere and turn off the rule this file exists to hold.
 */
const NOT_A_CITATION: ReadonlyMap<string, string> = new Map([
  [
    "docs/spec/appendix-a-unresolved.md::HANDOFF_DISPUTANT_CLI.md",
    "Appendix A §3 retires the bootstrapping handoff and corrects its claims, so it " +
      "names the document once to say what it was. Identification, not a pointer — the " +
      "section quotes every claim it overturns and sends the reader nowhere.",
  ],
  [
    "evidence-format.md",
    'Cited as "the contracts\' own `evidence-format.md`" — the evidence specification in ' +
      "the kleros-v2 contracts repository, named as an external authority and qualified " +
      "as such at each of the three points it is cited from. Bare, for that reason.",
  ],
  [
    "contracts/specifications/evidence-format.md",
    "The same foreign file, written with its path inside the kleros-v2 contracts " +
      "repository. Bare like the basename above, and for the same reason: it is cited " +
      "from two documents, and `contracts/` is not a directory this repo has.",
  ],
  [
    "docs/adr/0001-standalone-repo-shaped-for-upstreaming.md::docs/knowledge/scope-and-posture.md",
    "ADR-0001 cites it as **AgentKit's** `docs/knowledge/scope-and-posture.md`, in the " +
      "sibling repo reached through the gitignored `reference/agentkit` symlink. Scoped, " +
      "because this repo has its own `docs/knowledge/` and an unscoped key would hide a " +
      "genuine dangling pointer under a path shape we use ourselves.",
  ],
  [
    "docs/agents/domain.md::CONTEXT-MAP.md",
    "domain.md describes it as 'at the repo root **if it exists**' — a convention whose " +
      "paths are templates, not citations. This repo is single-context and deliberately " +
      "has none. Scoped: anywhere else the name would be a real dangling pointer.",
  ],
  [
    "docs/agents/issue-tracker.md::map.md",
    "issue-tracker.md names `.scratch/<effort>/map.md` as the wayfinder convention's map " +
      "file — a path template for a file a future effort creates, not a pointer at one " +
      "that exists. Scoped for the same reason as the entry above.",
  ],
]);

/** The tracked set — what a fresh clone gets, and nothing else. */
function trackedFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  return new Set(out.split("\0").filter((entry) => entry.length > 0));
}

interface Citation {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  /** A repo-relative POSIX path, or a bare basename when `kind` is `basename`. */
  readonly target: string;
  readonly kind: "path" | "basename";
}

/** `[…](x)`, ignoring a title string. */
const LINK = /\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;

/**
 * A markdown filename in backticks, with or without a leading path:
 * `` `CONTEXT.md` ``, `` `docs/knowledge/fork-harness-port-8546.md` ``. A
 * prefixed one names a path and is checked as one; a bare one names a file and
 * is resolved by basename at any depth.
 */
const FILENAME = /`((?:[A-Za-z0-9_.-]+\/)*[A-Za-z][A-Za-z0-9_.-]*\.md)`/g;

/**
 * Anything that is not a path inside this repository. Any URI scheme counts, not
 * just `http` and `mailto`: an unrecognised one silently became a relative path
 * and failed as a missing file, which is a wrong answer rather than a finding.
 * A root-absolute href is out of scope for the same reason — this repo writes
 * none, and joining one onto the citing directory invents a path nobody wrote.
 */
const isExternal = (href: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//") || href.startsWith("/");

function collect(files: readonly string[]): Citation[] {
  const citations: Citation[] = [];

  for (const file of files) {
    // Enumerated from the index but read from the working tree, so a file
    // deleted without `git rm` would otherwise take the suite down with an
    // ENOENT that says nothing about citations.
    const path = resolve(REPO_ROOT, file);
    if (!existsSync(path)) continue;

    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, index) => {
        const line = index + 1;

        for (const match of text.matchAll(LINK)) {
          const href = (match[1] as string).split("#")[0] as string;
          if (href.length === 0 || href.startsWith("#") || isExternal(href)) continue;

          const target = posix.normalize(posix.join(posix.dirname(file), href));
          citations.push({ file, line, raw: match[0], target, kind: "path" });
        }

        for (const match of text.matchAll(FILENAME)) {
          const name = match[1] as string;
          citations.push({
            file,
            line,
            raw: match[0],
            target: name,
            kind: name.includes("/") ? "path" : "basename",
          });
        }
      });
  }

  return citations;
}

function resolves(citation: Citation, tracked: Set<string>, basenames: Set<string>): boolean {
  if (citation.kind === "basename") return basenames.has(citation.target);
  if (tracked.has(citation.target)) return true;

  // A directory, written with or without its trailing slash.
  const prefix = citation.target.endsWith("/") ? citation.target : `${citation.target}/`;
  return [...tracked].some((path) => path.startsWith(prefix));
}

const describeFailure = ({ file, line, raw, target }: Citation): string =>
  `${file}:${line} cites ${raw} → ${target}, which a fresh clone does not have`;

describe("citations in reader-facing documents", () => {
  const tracked = trackedFiles();
  const basenames = new Set([...tracked].map((path) => posix.basename(path)));
  const markdown = [...tracked]
    .filter((path) => path.endsWith(".md") && READER_FACING(path))
    .sort();
  const citations = collect(markdown);

  // Guards the guard. A regex that quietly matched nothing would assert nothing
  // and pass, which is the failure mode of every extraction-based test.
  it("finds citations of every shape it claims to check", () => {
    const links = citations.filter((citation) => citation.raw.startsWith("]"));
    const backticked = citations.filter((citation) => citation.raw.startsWith("`"));

    expect(markdown.length).toBeGreaterThan(20);
    expect(links.length).toBeGreaterThan(30);
    expect(backticked.length).toBeGreaterThan(30);

    // Both backtick forms, because matching only the bare one is the defect this
    // test shipped with and had to be corrected for.
    expect(backticked.some((citation) => citation.kind === "basename")).toBe(true);
    expect(backticked.some((citation) => citation.kind === "path")).toBe(true);
    expect(citations.map((citation) => citation.target)).toContain("CONTEXT.md");
  });

  const exemption = (citation: Citation): string | undefined =>
    NOT_A_CITATION.get(`${citation.file}::${citation.target}`) ??
    NOT_A_CITATION.get(citation.target);

  it("resolves every one of them to a tracked file", () => {
    const dangling = citations
      .filter((citation) => !resolves(citation, tracked, basenames))
      .filter((citation) => exemption(citation) === undefined);

    expect(dangling.map(describeFailure)).toEqual([]);
  });

  /**
   * The allowlist decays the moment one of its entries becomes tracked, or its
   * citation is dropped — and a stale exemption is worse than none, because it
   * reads as a considered decision.
   */
  it("keeps no allowlist entry that is tracked, or no longer cited", () => {
    const cited = new Set(
      citations.flatMap((citation) => [citation.target, `${citation.file}::${citation.target}`]),
    );

    for (const [key, reason] of NOT_A_CITATION) {
      const target = key.includes("::") ? (key.split("::")[1] as string) : key;

      expect(basenames.has(target), `${target} is tracked now; drop it from NOT_A_CITATION`).toBe(
        false,
      );
      expect(cited.has(key), `nothing cites ${key}; drop it from NOT_A_CITATION`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
