import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The CLI's own surface, checked against the vocabulary `CONTEXT.md` governs.
 *
 * `kleros-juror-cli` added its equivalent at commit 19 of 24 and it immediately
 * found drift into a banned term across the CLI help, the README *and* the skill
 * frontmatter — three surfaces its glossary had advised against for the whole of
 * the project's life. Advisory prose does not hold a term in place. This does.
 * Hence its position here: before the first command, not after the last.
 *
 * Offline: nothing here reads the chain, a key, or the network.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");
const skillsDir = join(repoRoot, "skills");

/**
 * Deliberately narrower than the `_Avoid_` lines in `CONTEXT.md`.
 *
 * Those lines forbid a word *in one role*. Several of them are perfectly correct
 * in another and this surface will be full of them: "answer" is the dispute
 * template's own field name, "title" is a required template field, "option" is
 * fine when qualified, "owner" is fine for a key. Only terms that are wrong in
 * **every** role a CLI description can put them in belong here. Widening this
 * list means allowlisting half the CLI; add a term only if that trade holds.
 *
 * Note what is absent. **"Ruling" is not banned here**, though it is the first
 * entry in the juror CLI's list. There it was wrong because a juror never casts
 * one; here it is the correct name for both the arbitrator's output and — as
 * "ruling option" — for what a dispute offers jurors. The same word inverts with
 * the role, which is the whole reason each repo owns its own list.
 *
 * Every term below is v1 leakage, a role Kleros v2 does not have, or a name for
 * something that exists under a different name. None has a correct use.
 */
const FORBIDDEN = [
  // Roles Kleros v2 does not have. A dispute is created by whoever pays for it,
  // and the arbitrable decides what its parties are called.
  "claimant",
  "plaintiff",
  "defendant",
  "prosecution",
  // v1 / ERC-1497. There is no evidence group in v2's EvidenceModule; the first
  // argument to `submitEvidence` is the core dispute ID. Both spellings, because
  // the Solidity parameter was `_evidenceGroupID`.
  "evidence group",
  "evidencegroup",
  // v1's name for what v2 calls the dispute template.
  "metaevidence",
  // v1's name for what v2 calls a court.
  "subcourt",
  // v1's arbitrable. The v2 `DisputeResolver` contract is a different thing.
  "arbitrableproxy",
  // The arbitrator's output is a ruling.
  "verdict",
] as const;

/** Render a view of the CLI surface as a user or an agent actually receives it. */
function render(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) reject(new Error(`${args.join(" ")} failed:\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

function assertClean(rendered: string, surface: string): void {
  for (const term of FORBIDDEN) {
    const offending = rendered
      .split("\n")
      .filter((line) => line.toLowerCase().includes(term))
      .join("\n");

    expect(
      offending,
      `"${term}" is an avoided term (see CONTEXT.md). It appears in ${surface}:\n${offending}`,
    ).toBe("");
  }
}

/**
 * Three surfaces, because no one of them covers the whole thing.
 *
 * `--help` and `--llms` carry the root description; `--llms-full` does not, at
 * any command count — verified against incur 0.4.26. `--llms-full` is the only
 * one that carries per-command and per-option descriptions, which will be the
 * largest banned-vocabulary surface once commands exist.
 */
const SURFACES = [
  ["--help", "the root description and command summaries"],
  ["--llms", "the root description and the command table an agent indexes"],
  ["--llms-full", "every command and option description"],
] as const;

describe("the CLI surface uses the vocabulary CONTEXT.md governs", () => {
  it.each(SURFACES)(
    "%s (%s) is free of avoided terms",
    async (flag, description) => {
      assertClean(await render([flag]), `${flag} — ${description}`);
    },
    60_000,
  );

  it("renders the surfaces that carry the root description", async () => {
    for (const flag of ["--help", "--llms"] as const) {
      expect((await render([flag])).length, `expected ${flag} to render something`).toBeGreaterThan(
        0,
      );
    }
  }, 60_000);

  /**
   * `--llms-full` is a per-command manifest, so it renders empty while no command
   * is registered — which would make its scan above trivially and silently green.
   * This arms it: the moment the first command lands, the manifest must be
   * non-empty, and the scan becomes real without anyone remembering to enable it.
   */
  it("keeps --llms-full non-empty once any command is registered", async () => {
    const manifest = JSON.parse(await render(["--llms-full", "--format", "json"])) as {
      commands: unknown[];
    };
    const rendered = await render(["--llms-full"]);

    if (manifest.commands.length === 0) {
      // Visible in the run output rather than silently green.
      console.warn("[vocabulary] no commands registered yet; --llms-full has nothing to scan.");
      return;
    }

    expect(
      rendered.trim().length,
      "commands are registered but --llms-full rendered nothing, so its scan is vacuous",
    ).toBeGreaterThan(0);
  }, 60_000);
});

/**
 * The agent skill ships in the npm tarball and is read by a host rather than by a
 * person, and the juror repo's skill frontmatter is one of the three surfaces its
 * guard caught drifting. It is not covered there even now. Cover it here.
 */
const skillFiles = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name === "SKILL.md")
      .map((entry) => join(entry.parentPath, entry.name))
  : [];

describe.skipIf(skillFiles.length === 0)(
  "the agent skill uses the vocabulary CONTEXT.md governs",
  () => {
    it.each(skillFiles.length > 0 ? skillFiles : ["<no skill yet>"])(
      "%s is free of avoided terms",
      (file) => {
        assertClean(readFileSync(file, "utf8"), file);
      },
    );
  },
);

if (skillFiles.length === 0) {
  // Visible in the run output rather than silently green.
  console.warn("[vocabulary] no skills/**/SKILL.md yet; the skill scan is inert.");
}
