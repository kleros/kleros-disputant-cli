import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEPLOYMENTS } from "../core/deployments.js";

/**
 * `--chain` as a caller actually meets it — `spec/03 §3.1`, `ADR-0015`.
 *
 * Rendered through the CLI's own surfaces rather than read out of `cli.ts`,
 * because every requirement here is about what reaches the caller: an option
 * declared but not rendered, or a gloss that drifted into a second help string,
 * is invisible to a test that inspects the definition object.
 *
 * Offline: nothing here reads the chain, a key, or the network.
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliEntry = join(repoRoot, "src", "cli.ts");

/** The commands that touch a chain. `upload-file` is deliberately absent. */
const CHAIN_COMMANDS = ["arbitration-cost", "status", "create-dispute", "submit-evidence"] as const;

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

describe("--chain on the rendered surface", () => {
  /**
   * **Per command, never as a root option.** incur's global mechanism reaches
   * handlers but is not merged into the per-command tool schemas it generates
   * for MCP, so a root declaration would be invisible to exactly the caller this
   * CLI is built for. Rendering each command's own help is what proves the
   * declaration is where it has to be.
   */
  it.each(CHAIN_COMMANDS)(
    "%s declares --chain with its -c alias and the default",
    async (command) => {
      const help = await render([command, "--help"]);
      expect(help).toContain("--chain, -c");
      expect(help).toContain("(default: arbitrum-one)");
    },
    60_000,
  );

  /**
   * The one command with no chain in it stays that way: `upload-file` signs
   * nothing, reads no chain and loads no key (`spec/06 §1`).
   */
  it("upload-file takes no --chain", async () => {
    const help = await render(["upload-file", "--help"]);
    expect(help).not.toContain("--chain");
  }, 60_000);

  /**
   * **The gloss lives in one authored place: the `--chain` description.**
   *
   * Pairing each slug with its prose name is what lets an agent map "v2 Beta" in
   * prose onto a flag value; repeating it across other help strings, messages
   * and CTAs would be several places for it to drift (ADR-0015). The rendered
   * surface shows it once per command that declares the option — the option is
   * declared per command on purpose — so what is asserted is that **every line
   * carrying the gloss is a `--chain` row**, and that there are exactly as many
   * as there are commands taking the flag. A gloss that leaked into a command
   * description, a court hint or the root blurb fails on both counts.
   */
  it("keeps the gloss inside the --chain description and nowhere else", async () => {
    const surface = await render(["--llms-full"]);

    for (const deployment of Object.values(DEPLOYMENTS)) {
      const gloss = `${deployment.slug} (${deployment.name})`;
      const carrying = surface.split("\n").filter((line) => line.includes(gloss));

      expect(carrying, `"${gloss}" should appear once per chain-taking command`).toHaveLength(
        CHAIN_COMMANDS.length,
      );
      for (const line of carrying) {
        expect(line, `"${gloss}" reached a surface that is not the --chain row`).toContain(
          "--chain",
        );
      }
    }
  }, 60_000);

  /**
   * "mainnet" is the contracts package's own key for Arbitrum One and an
   * implementation detail. To an agent that also reads `@kleros/agentkit`, it
   * names Ethereum, so it MUST NOT reach any surface a caller sees (ADR-0015).
   */
  it("never says mainnet anywhere a caller can read it", async () => {
    for (const flag of ["--help", "--llms", "--llms-full"] as const) {
      const surface = await render([flag]);
      expect(surface.toLowerCase(), `${flag} names the package's own key`).not.toContain("mainnet");
    }
  }, 60_000);
});
