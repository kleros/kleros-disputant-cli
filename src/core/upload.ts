import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { err, type KlerosResult, ok } from "./result.js";

/**
 * Attachment upload — `spec/06`.
 *
 * The one plane in this tool that is not the chain, and the only module that
 * opens a socket to anything but the RPC. It exists because an agent handed a
 * PDF has no other way to produce a `fileURI`; ADR-0012 reverses ADR-0009 and
 * records what survived the reversal.
 *
 * **Nothing here signs, reads the chain or loads a key**, so none of
 * `spec/03 §7`'s startup checks apply: there is no chain call for them to
 * protect. Keeping that true is what keeps the HTTP client out of the signing
 * path, which was ADR-0009's actual load-bearing property.
 *
 * Every claim about the endpoint below is marked **[service]** and was measured
 * on 2026-09-09. A service is not a contract — there is no bytecode to read and
 * no deployment to fingerprint — so `spec/06 §5` records how to re-measure it,
 * and `appendix-a §2.1` records what measurement cannot settle.
 *
 * Core never throws (ADR-0001): every boundary here converts to `err(...)`.
 */

/**
 * ADR-0009 ranked the options and this is the first: unauthenticated, no second
 * chain, no second token, and the endpoint Kleros's own code reaches for.
 */
export const DEFAULT_UPLOAD_URL =
  "https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs";

/** Where a CID is read back from for the round-trip check (`spec/06 §4.2`). */
export const DEFAULT_GATEWAY = "https://cdn.kleros.link";

/**
 * The platform caps the **base64-encoded function event** at 6 MiB, and the
 * encoded body is only its dominant term — headers and the query string are
 * inside the same budget (`spec/06 §3.1`).
 *
 * Measured by bisection: an encoded body of 6,284,972 bytes was accepted and one
 * of 6,285,020 was rejected, so roughly 6.4 KB of the 6 MiB goes on everything
 * else. That residue is **not** constant, which is why no fixed maximum file
 * size would be correct and why the check below measures the real body. The
 * 64 KiB reserved here is deliberate headroom over the 6.4 KB observed.
 */
export const ENCODED_BUDGET_BYTES = 6 * 1024 * 1024 - 64 * 1024;

/** Netlify's `413` arrives from the edge with an empty `text/plain` body. */
const MULTIPART_FIELD = "file";

export type FileToUpload = {
  path: string;
  /** The basename, which travels in the multipart part and moves the size boundary. */
  filename: string;
  bytes: Uint8Array;
  sha256: string;
  /** Derived from the path, omitted when there is none. Never guessed. */
  fileTypeExtension?: string;
};

/**
 * Read the file and derive everything decidable without a network.
 *
 * `statSync` before `readFileSync` so a directory is refused as a directory
 * rather than as an unreadable file — an agent pointed at `./evidence/` gets a
 * message that names the mistake.
 */
export function readFileToUpload(path: string): KlerosResult<FileToUpload> {
  let size: number;
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return err("FILE_UNREADABLE", `${path} is a directory, not a file. Nothing was uploaded.`, {
        hint: "--file takes one file. This endpoint pins exactly one file per request.",
      });
    }
    if (!stat.isFile()) {
      return err("FILE_UNREADABLE", `${path} is not a regular file. Nothing was uploaded.`);
    }
    size = stat.size;
  } catch {
    return err("FILE_UNREADABLE", `Could not read ${path}. Nothing was uploaded.`, {
      hint: "--file takes a path to a local file.",
    });
  }

  // Refused before the request, because the endpoint answers `200` with an
  // empty `cids` array for an empty part — a success status and no CID
  // (`spec/06 §4.1`). Catching it here is what turns that into a real message.
  if (size === 0) {
    return err(
      "FILE_EMPTY",
      `${path} is empty. The pinning endpoint accepts an empty file with a 200 and pins ` +
        "nothing, so this is refused here instead. Nothing was uploaded.",
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return err("FILE_UNREADABLE", `Could not read ${path}. Nothing was uploaded.`);
  }

  const filename = basename(path);
  // `.pdf` -> `pdf`. A path with no extension, or one ending in a bare dot,
  // yields nothing rather than an empty string the subgraph would index.
  const extension = extname(filename).replace(/^\./, "");

  return ok({
    path,
    filename,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(extension === "" ? {} : { fileTypeExtension: extension }),
  });
}

export type UploadRequest = {
  url: string;
  body: Uint8Array;
  contentType: string;
  /** Base64 length of `body`, which is what the platform budget is spent on. */
  encodedBytes: number;
};

/**
 * Serialise the exact request, so its size is measured rather than estimated.
 *
 * The body is built through `FormData` and then **realised with `Request`**,
 * which is the only way to know the boundary and the framing before sending. A
 * long filename really does move the ceiling, and an estimate would either
 * refuse valid files or let an opaque `413` through.
 *
 * `operation` is present and non-empty because the handler checks it for
 * presence — **its value is discarded** (`operation=banana` returns `200`), but
 * omitting it returns `400` on every upload **[service]**. `pinToGraph=false`
 * keeps a second service and a second way to half-succeed out of the path.
 */
export async function buildUploadRequest(
  file: FileToUpload,
  endpoint: string,
): Promise<KlerosResult<UploadRequest>> {
  const url = `${endpoint}?operation=evidence&pinToGraph=false`;

  const form = new FormData();
  form.append(MULTIPART_FIELD, new Blob([file.bytes]), file.filename);

  let body: Uint8Array;
  let contentType: string | null;
  try {
    const realised = new Request("https://boundary.invalid/", { method: "POST", body: form });
    contentType = realised.headers.get("content-type");
    body = new Uint8Array(await realised.arrayBuffer());
  } catch {
    return err("UPLOAD_FAILED", "Could not assemble the upload request. Nothing was uploaded.");
  }

  if (contentType === null) {
    return err("UPLOAD_FAILED", "Could not assemble the upload request. Nothing was uploaded.");
  }

  const encodedBytes = Math.ceil(body.length / 3) * 4;
  if (encodedBytes > ENCODED_BUDGET_BYTES) {
    return err(
      "FILE_TOO_LARGE",
      `${file.path} is ${file.bytes.length} bytes, which does not fit the upload endpoint's ` +
        `limit. The platform caps the base64-encoded request at 6 MiB and this one would be ` +
        `${encodedBytes} bytes; the practical ceiling is around 4.6 MB of file. Over the limit ` +
        "the endpoint returns an empty 413 that explains nothing, so this is refused here " +
        "instead. Nothing was uploaded.",
      { hint: "Split the attachment, or compress it, and submit one document per file." },
    );
  }

  return ok({ url, body, contentType, encodedBytes });
}

export type UploadOutcome = {
  cid: string;
  /** Always `/ipfs/<cid>`, whichever form came back. */
  fileURI: string;
};

/**
 * `POST` the request and read one CID out of the response.
 *
 * Three of the four rules here exist because **a `2xx` is not a success**
 * (`spec/06 §4.1`): the endpoint returns `200` with an empty `cids` array for an
 * empty file or a request with no file part. A non-`2xx` body is never
 * JSON-parsed — the `413` is empty `text/plain`.
 */
export async function postUpload(
  request: UploadRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<KlerosResult<UploadOutcome>> {
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: "POST",
      headers: { "content-type": request.contentType },
      body: request.body,
    });
  } catch (cause) {
    return err(
      "UPLOAD_FAILED",
      `Could not reach the upload endpoint: ${cause instanceof Error ? cause.message : "unknown"}. ` +
        "Nothing was uploaded.",
      { hint: "--upload-url points this at a different deployment of the same function." },
    );
  }

  if (!response.ok) {
    // Deliberately not parsed as JSON: the 413 is an empty text/plain body from
    // the edge, and a parse failure here would mask the status that explains it.
    const detail =
      response.status === 413
        ? " The request exceeded the platform's size limit, which this tool normally catches locally."
        : response.status === 400
          ? " The endpoint rejected the query parameters."
          : "";
    return err(
      "UPLOAD_FAILED",
      `The upload endpoint returned ${response.status}.${detail} Nothing was uploaded.`,
      { status: response.status },
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return err(
      "UPLOAD_FAILED",
      "The upload endpoint returned a success status with a body that is not JSON. Nothing can " +
        "be concluded about whether the file was pinned.",
    );
  }

  const cids = (parsed as { cids?: unknown })?.cids;
  const first = Array.isArray(cids) ? cids[0] : undefined;

  if (typeof first !== "string" || first.trim() === "") {
    return err(
      "UPLOAD_FAILED",
      "The upload endpoint returned a success status and no CID, which is what it does when it " +
        "has pinned nothing. Nothing was uploaded.",
      { hint: "This normally means the file part was empty or missing." },
    );
  }

  // The endpoint already prefixes `/ipfs/`; the client Kleros ships re-prefixes
  // defensively, so both forms are accepted and normalised to the multiaddr.
  const cid = first.startsWith("/ipfs/") ? first.slice("/ipfs/".length) : first;
  return ok({ cid, fileURI: `/ipfs/${cid}` });
}

export type VerifyOutcome =
  | { verified: true }
  /** The gateway never answered. A warning, never a failure — the pin probably landed. */
  | { verified: false; reason: string };

/**
 * Fetch the CID back and compare it to what was sent (`spec/06 §4.2`).
 *
 * This is the only check that catches a **silent truncation**. The deployed
 * handler reassigns the file on every `data` event, so a body arriving in more
 * than one chunk would pin its last chunk alone, under a CID that is perfectly
 * valid for the truncated bytes. It does not fire today, for a reason
 * incidental to the bug — the handler feeds busboy the whole body in one
 * `write()` — and "does not fire today" is not something to depend on in
 * silence.
 *
 * Reading these bytes back is **not** an ADR-0007 breach: the tool already holds
 * them, compares them, and discards the response. Nothing read reaches a payload
 * or changes which call is made. A URI the *operator* supplies is still never
 * dereferenced.
 *
 * The two outcomes are deliberately asymmetric. Bytes that **differ** are a hard
 * failure — the CID does not address the file. A gateway that does not
 * **answer** is a warning, because the pin most likely succeeded and refusing
 * would misreport what happened.
 */
export async function verifyUpload(
  fileURI: string,
  expected: Uint8Array,
  options: {
    gateway?: string;
    attempts?: number;
    /** Backoff between attempts. Zero in the tests, which have no propagation to wait for. */
    retryDelayMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<KlerosResult<VerifyOutcome>> {
  const gateway = options.gateway ?? DEFAULT_GATEWAY;
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${gateway}${fileURI}`;

  let lastReason = "the gateway was not reached";

  for (let attempt = 0; attempt < attempts; attempt++) {
    // A gateway that has not seen the CID yet answers 404 rather than waiting
    // for it, so the retries need spacing to mean anything. Only between
    // attempts: the first read is immediate, and it is the one that normally
    // succeeds.
    if (attempt > 0 && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }

    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET" });
    } catch (cause) {
      lastReason = cause instanceof Error ? cause.message : "the gateway was not reached";
      continue;
    }

    if (!response.ok) {
      lastReason = `the gateway returned ${response.status}`;
      continue;
    }

    let got: Uint8Array;
    try {
      got = new Uint8Array(await response.arrayBuffer());
    } catch {
      lastReason = "the gateway response could not be read";
      continue;
    }

    if (got.length !== expected.length || !equalBytes(got, expected)) {
      return err(
        "UPLOAD_MISMATCH",
        `The upload endpoint returned ${fileURI}, but that CID resolves to ${got.length} bytes ` +
          `where ${expected.length} were uploaded. The CID does not address this file, so it ` +
          "MUST NOT be submitted as evidence. Nothing was submitted to any dispute.",
        { hint: "Re-run the upload. If it recurs, the endpoint is truncating and is unsafe." },
      );
    }

    return ok({ verified: true });
  }

  return ok({ verified: false, reason: lastReason });
}

/** Constant-time is not needed; this compares public content, not a secret. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
