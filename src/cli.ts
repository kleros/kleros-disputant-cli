#!/usr/bin/env node
/**
 * The CLI shell. No commands are registered yet — the functional core is not
 * written. This exists now because `vocabulary.test.ts` guards the surface the
 * shell renders, and a guard that cannot render anything is not a guard.
 *
 * `format: "json"` by default: the consuming agent merges stdout and stderr into
 * one buffer, so anything else on stdout breaks parsing. There is no `--json`
 * flag and no `--verbose` flag; incur supplies `--format`, `--full-output`,
 * `--llms`, `--llms-full`, `--schema`, `--filter-output`, `--token-*` and the
 * `completions` / `mcp` / `skills` groups for free. Do not reimplement any of them.
 */
import { createRequire } from "node:module";
import { Cli } from "incur";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const cli = Cli.create("kleros-disputant", {
  description:
    "Create Kleros v2 disputes and submit evidence on Arbitrum One. Files a case that has " +
    "already been built: the court, the ruling options and the evidence text are always inputs. " +
    "Nothing is sent without --broadcast.",
  version: pkg.version,
  format: "json",
});

cli.serve();
