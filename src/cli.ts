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
import {
  chainOptions,
  extraDataOptions,
  finish,
  uploadSuccessCta,
  writeOptions,
} from "./commands/shared.js";
import { runUploadFile } from "./commands/upload.js";
import { runCreateDispute, runSubmitEvidence } from "./commands/write.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const cli = Cli.create("kleros-disputant", {
  description:
    "Create Kleros v2 disputes and submit evidence. Files a case that has already been built: " +
    "the court, the ruling options and the evidence text are always inputs. Nothing is sent " +
    "without --broadcast, and --chain selects the deployment it is sent to.",
  version: pkg.version,
  format: "json",
  // `skills add` installs the skills incur generates from these command
  // definitions. The hand-written `skills/kleros-disputant/SKILL.md` is not one
  // of them and would ship in the tarball without ever being installed, so name
  // it here. The pattern is relative to the package root, which is where incur
  // resolves it from by default. **Do not pass `sync.cwd` to force that**: incur
  // uses one `cwd` for the include globs *and* for the install destination, so
  // overriding it sends `skills add --no-global` into this package's own
  // directory — inside `node_modules` for a real install — instead of the
  // caller's project. Under `--no-global` the glob misses and the caller gets
  // the generated skills only, which is the right way to lose this.
  //
  // incur parses that file's front matter and swallows any error, so a skill it
  // cannot parse is skipped in silence rather than reported. A `": "` inside an
  // unquoted YAML scalar is the easiest way to cause that, because it turns
  // `description:` into a nested mapping. Check `skills add` lists the skill;
  // that the file exists proves nothing.
  sync: { include: ["skills/kleros-disputant"] },
})
  .command("arbitration-cost", {
    description:
      "Quote what creating a dispute would cost, in wei and in ETH. Reads only, needs no signing " +
      "key, and sends nothing. It runs the same court, juror-count and dispute-kit checks as " +
      "create-dispute, because KlerosCore quotes a price for a court that does not exist rather " +
      "than refusing.",
    options: z.object({ ...chainOptions, ...extraDataOptions }),
    // incur takes aliases here, not in the zod schema, and only per command:
    // its global option mechanism is not merged into the MCP tool schemas an
    // agent calls, so a root `--chain` would be invisible to the primary
    // consumer (verified against incur 0.4.26).
    alias: { chain: "c" },
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
        chain: c.options.chain,
        rpcUrl: c.options["rpc-url"],
        court: c.options.court,
        jurors: c.options.jurors,
        kit: c.options.kit,
      });
      return finish(c, result, {
        chain: c.options.chain,
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
    alias: { chain: "c" },
    examples: [{ description: "Check where a dispute stands", options: { dispute: "215" } }],
    async run(c) {
      const result = await runStatus({
        chain: c.options.chain,
        rpcUrl: c.options["rpc-url"],
        dispute: c.options.dispute,
      });
      return finish(c, result, { chain: c.options.chain, dispute: c.options.dispute });
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
    alias: { chain: "c" },
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
        chain: c.options.chain,
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
        chain: c.options.chain,
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
          "The core dispute ID — the one Kleros Court shows for the case. Two IDs are refused, " +
            "because the submission would succeed and then be unreachable: one no dispute uses, " +
            "and one whose dispute a different arbitrable contract created. Every dispute on " +
            "arbitrum-one is reachable today, however it was filed.",
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
          "URI of an attachment, typically /ipfs/…. Recorded as given and never fetched. Get one " +
            "from upload-file, or pass a URI you pinned yourself.",
        ),
      "file-type-extension": z
        .string()
        .optional()
        .describe("File extension of the attachment, such as pdf. Read by the subgraph only."),
    }),
    alias: { chain: "c" },
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
        chain: c.options.chain,
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
      return finish(c, result, { chain: c.options.chain, dispute: c.options.dispute });
    },
  })
  .command("upload-file", {
    description:
      "Upload one local file to IPFS and print the fileURI to pass to submit-evidence. Checks " +
      "the file and stops unless --publish is passed. This is the only command that speaks " +
      "HTTP: it never signs, never reads the chain and never loads a key. Publishing content " +
      "addressed by a CID cannot be undone.",
    destructive: true,
    options: z.object({
      file: z
        .string()
        .describe(
          "Path to the file to upload. Exactly one per run, because the endpoint keeps only the " +
            "last part sent under a given field name.",
        ),
      publish: z
        .boolean()
        .default(false)
        .describe(
          "Actually upload. Without it the command reports the size, the SHA-256 and every " +
            "refusal, and stops. There is no confirmation prompt: this flag is the confirmation. " +
            "Omit it, or pass --no-publish, to keep it off: --publish false uploads, because the " +
            "word is not read as a value.",
        ),
      "upload-url": z
        .string()
        .optional()
        .describe(
          "Override the pinning endpoint, for a private deployment of the same function. It is " +
            "never read from an environment variable.",
        ),
      gateway: z
        .string()
        .optional()
        .describe("Override the IPFS gateway used to read the CID back after uploading."),
      // Named `verify`, not `no-verify`: incur reads a leading `--no-` as its own
      // boolean negation prefix, so an option *named* `no-verify` is unreachable —
      // `--no-verify` is rejected as an unknown flag and only `--no-no-verify`
      // parses, which negates it back to `false` and leaves verification on. This
      // spelling gives `--no-verify` and `--verify=false` for free. Not `--verify
      // false`: incur's boolean flags never consume a following word, so the
      // space form sets `true` and the word is discarded — see `broadcast` in
      // `commands/shared.ts` for why that matters more there than here.
      verify: z
        .boolean()
        .default(true)
        .describe(
          "Read the CID back after uploading to confirm it addresses the bytes that were sent. " +
            "On by default because the endpoint can truncate a file silently; pass --no-verify " +
            "to skip it.",
        ),
    }),
    examples: [
      {
        description: "Check a file without uploading it",
        options: { file: "./delivery-photos.pdf" },
      },
      {
        description: "Upload it and get the URI for submit-evidence",
        options: { file: "./delivery-photos.pdf", publish: true },
      },
    ],
    async run(c) {
      const result = await runUploadFile({
        file: c.options.file,
        publish: c.options.publish,
        uploadUrl: c.options["upload-url"],
        gateway: c.options.gateway,
        verify: c.options.verify,
      });
      return finish(c, result, {}, uploadSuccessCta);
    },
  });

cli.serve();
