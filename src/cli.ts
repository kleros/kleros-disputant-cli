#!/usr/bin/env node
/**
 * The CLI shell — `spec/03 §1`, `§2`.
 *
 * `format: "json"` by default: the consuming agent merges stdout and stderr into
 * one buffer, so anything else on stdout breaks parsing. There is no `--json`
 * flag and no `--verbose` flag; incur supplies `--format`, `--full-output`,
 * `--llms`, `--llms-full`, `--schema`, `--filter-output`, `--token-*` and the
 * `completions` / `mcp` / `skills` groups for free. Do not reimplement any of
 * them.
 *
 * **Options only, never positional arguments.** An agent passes flags, and
 * positional arguments invite ordering mistakes that this tool pays for
 * irreversibly.
 *
 * Every `run` here contains no logic: it maps options to one core call and hands
 * the `KlerosResult` to `finish`, which is the entire core→incur seam
 * (`spec/03 §8`).
 */
import { createRequire } from "node:module";
import { Cli, z } from "incur";
import { runArbitrationCost, runStatus } from "./commands/read.js";
import { chainOptions, extraDataOptions, finish, writeOptions } from "./commands/shared.js";
import { runCreateDispute, runSubmitEvidence } from "./commands/write.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const cli = Cli.create("kleros-disputant", {
  description:
    "Create Kleros v2 disputes and submit evidence on Arbitrum One. Files a case that has " +
    "already been built: the court, the ruling options and the evidence text are always inputs. " +
    "Nothing is sent without --broadcast.",
  version: pkg.version,
  format: "json",
})
  .command("arbitration-cost", {
    description:
      "Quote what creating a dispute would cost, in wei and in ETH. Reads only, needs no signing " +
      "key, and sends nothing. It runs the same court, juror-count and dispute-kit checks as " +
      "create-dispute, because KlerosCore quotes a price for a court that does not exist rather " +
      "than refusing.",
    options: z.object({ ...chainOptions, ...extraDataOptions }),
    examples: [
      {
        description: "Price three jurors in the General Court",
        options: { court: "1", jurors: "3" },
      },
      {
        description: "Price seven jurors in a specialised court",
        options: { court: "29", jurors: "7", kit: "1" },
      },
    ],
    async run(c) {
      const result = await runArbitrationCost({
        rpcUrl: c.options["rpc-url"],
        court: c.options.court,
        jurors: c.options.jurors,
        kit: c.options.kit,
      });
      return finish(c, result, {
        court: c.options.court,
        jurors: c.options.jurors,
        kit: c.options.kit,
      });
    },
  })
  .command("status", {
    description:
      "Show which period a dispute is in, how much of it is left and whether it has been ruled, " +
      "so a caller can tell whether evidence submitted now can still reach jurors. Reads only " +
      "and needs no signing key.",
    options: z.object({
      ...chainOptions,
      dispute: z
        .string()
        .describe("The core dispute ID — the one Kleros Court shows for the case."),
    }),
    examples: [{ description: "Check where a dispute stands", options: { dispute: "215" } }],
    async run(c) {
      const result = await runStatus({ rpcUrl: c.options["rpc-url"], dispute: c.options.dispute });
      return finish(c, result, { dispute: c.options.dispute });
    },
  })
  .command("create-dispute", {
    description:
      "Create a dispute and register its template, paying the arbitration fee. Simulates and " +
      "stops unless --broadcast is passed. The fee is paid on creation and cannot be recovered, " +
      "and a wrong court ID does not revert — it creates a paid dispute in the General Court — " +
      "so the court, juror count and dispute kit are refused locally rather than by the chain.",
    destructive: true,
    options: z.object({
      ...chainOptions,
      ...extraDataOptions,
      ...writeOptions,
      "template-file": z
        .string()
        .describe(
          "Path to the dispute template JSON: the question, the ruling options and the policy " +
            "URI. Validated strictly — an unknown field is rejected, not ignored. The number of " +
            "ruling options is derived from its answers array and is not a separate option.",
        ),
      "max-cost-eth": z
        .string()
        .describe(
          "Refuse if the arbitration fee exceeds this many ETH. Checked the moment the quote " +
            "arrives, before anything is simulated or sent.",
        ),
    }),
    examples: [
      {
        description: "Check what would happen, sending nothing",
        options: {
          court: "1",
          jurors: "3",
          "template-file": "./dispute.json",
          "max-cost-eth": "0.02",
        },
      },
      {
        description: "Actually create the dispute and pay the fee",
        options: {
          court: "1",
          jurors: "3",
          "template-file": "./dispute.json",
          "max-cost-eth": "0.02",
          "key-file": "./disputant.key",
          broadcast: true,
        },
      },
    ],
    async run(c) {
      const result = await runCreateDispute({
        rpcUrl: c.options["rpc-url"],
        keyFile: c.options["key-file"],
        requireSigner: true,
        court: c.options.court,
        jurors: c.options.jurors,
        kit: c.options.kit,
        templateFile: c.options["template-file"],
        maxCostEth: c.options["max-cost-eth"],
        broadcast: c.options.broadcast,
        maxFeeGwei: c.options["max-fee-gwei"],
      });
      return finish(c, result, {
        court: c.options.court,
        jurors: c.options.jurors,
        kit: c.options.kit,
      });
    },
  })
  .command("submit-evidence", {
    description:
      "Submit one evidence document against an existing dispute. Costs gas only, with no " +
      "arbitration fee. Simulates and stops unless --broadcast is passed. The text is sent " +
      "exactly as given: it is never read, interpreted or summarised, and no URI in it is ever " +
      "fetched.",
    destructive: true,
    options: z.object({
      ...chainOptions,
      ...writeOptions,
      dispute: z
        .string()
        .describe(
          "The core dispute ID — the one Kleros Court shows for the case. An ID no dispute uses " +
            "is refused: the submission would succeed and then be unreachable.",
        ),
      name: z
        .string()
        .describe(
          "Short name for the document. A literal string, @path to read a file, or - to read " +
            "stdin. The field is name, not title.",
        ),
      description: z
        .string()
        .describe(
          "The body of the evidence. A literal string, @path to read a file, or - to read " +
            "stdin. Keeping long text off the command line keeps it out of the process table.",
        ),
      "file-uri": z
        .string()
        .optional()
        .describe(
          "URI of an attachment, typically /ipfs/…. Recorded as given and never fetched. This " +
            "tool does not upload or pin anything.",
        ),
      "file-type-extension": z
        .string()
        .optional()
        .describe("File extension of the attachment, such as pdf. Read by the subgraph only."),
    }),
    examples: [
      {
        description: "Check what would be submitted, sending nothing",
        options: {
          dispute: "215",
          name: "Delivery photographs",
          description: "@statement.txt",
        },
      },
      {
        description: "Submit with an attachment already on IPFS",
        options: {
          dispute: "215",
          name: "Delivery photographs",
          description: "@statement.txt",
          "file-uri": "/ipfs/QmWQV5ZFFhEJiW8Lm7ay2zLxC2XS4wx1b2W7FfdrLMyQQc",
          "file-type-extension": "pdf",
          "key-file": "./disputant.key",
          broadcast: true,
        },
      },
    ],
    async run(c) {
      const result = await runSubmitEvidence({
        rpcUrl: c.options["rpc-url"],
        keyFile: c.options["key-file"],
        requireSigner: true,
        dispute: c.options.dispute,
        name: c.options.name,
        description: c.options.description,
        fileUri: c.options["file-uri"],
        fileTypeExtension: c.options["file-type-extension"],
        broadcast: c.options.broadcast,
        maxFeeGwei: c.options["max-fee-gwei"],
      });
      return finish(c, result, { dispute: c.options.dispute });
    },
  });

cli.serve();
