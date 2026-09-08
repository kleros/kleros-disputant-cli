import { type KlerosResult, ok } from "../core/result.js";
import {
  buildUploadRequest,
  DEFAULT_GATEWAY,
  DEFAULT_UPLOAD_URL,
  postUpload,
  readFileToUpload,
  verifyUpload,
} from "../core/upload.js";

/**
 * `upload-file` — `spec/06`, ADR-0012.
 *
 * The only command that speaks HTTP, and the only one with no chain in it: no
 * `prepare()`, no `eth_chainId` assertion, no deployment lookup, no key. That is
 * not an omission — there is no chain call here for `spec/03 §7`'s startup
 * checks to protect, and keeping the signing path free of an HTTP client was the
 * load-bearing half of ADR-0009 that ADR-0012 preserved.
 *
 * The default is check → report → stop, for the same reason `--broadcast` is
 * opt-in: content published under a CID cannot be withdrawn, and an agent
 * pointed at the wrong path would leak a document permanently. `--publish` is
 * the confirmation, and it is deliberately **not** `--broadcast` — nothing here
 * is broadcast to a chain.
 */

export type UploadFileOptions = {
  file: string;
  publish: boolean;
  uploadUrl?: string | undefined;
  gateway?: string | undefined;
  verify: boolean;
  /** Injected by the tests. Production passes nothing and gets global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
  /** Injected by the tests, which have no gateway propagation to wait out. */
  retryDelayMs?: number | undefined;
};

export async function runUploadFile(
  options: UploadFileOptions,
): Promise<KlerosResult<Record<string, unknown>>> {
  const endpoint = options.uploadUrl ?? DEFAULT_UPLOAD_URL;
  const warnings: string[] = [];

  // Local first, always: an unreadable path, an empty file and an oversized
  // request are all decided before a socket is opened, so a check-only run
  // reports exactly the refusals a publishing run would hit (`spec/06 §3`).
  const file = readFileToUpload(options.file);
  if (!file.success) return file;

  const request = await buildUploadRequest(file.data, endpoint);
  if (!request.success) return request;

  if (!endpoint.startsWith("https://")) {
    warnings.push(
      `The upload endpoint ${endpoint} is not HTTPS, so the file and its CID travel in the clear.`,
    );
  }

  const describeFile = {
    path: file.data.path,
    bytes: String(file.data.bytes.length),
    sha256: file.data.sha256,
  };
  const extension = file.data.fileTypeExtension;
  const extensionField = extension === undefined ? {} : { fileTypeExtension: extension };

  if (!options.publish) {
    return ok({
      ok: true,
      command: "upload-file",
      status: "checked",
      published: false,
      file: describeFile,
      ...extensionField,
      endpoint,
      encodedRequestBytes: String(request.data.encodedBytes),
      warnings,
      message:
        `CHECKED ONLY — nothing was uploaded and no CID exists yet. ${file.data.filename} is ` +
        `${file.data.bytes.length} bytes and fits the endpoint's limit. Re-run with --publish ` +
        "to upload it. Publishing puts the file on a public network permanently and cannot be " +
        "undone.",
    });
  }

  const uploaded = await postUpload(request.data, options.fetchImpl ?? fetch);
  if (!uploaded.success) return uploaded;

  let verified = false;
  if (options.verify) {
    const check = await verifyUpload(uploaded.data.fileURI, file.data.bytes, {
      ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    });
    // A mismatch is a refusal; a gateway that never answered is a warning. The
    // pin most likely landed, and failing here would misreport what happened
    // (`spec/06 §4.2`).
    if (!check.success) return check;
    verified = check.data.verified;
    if (!check.data.verified) {
      warnings.push(
        `The CID could not be read back from ${options.gateway ?? DEFAULT_GATEWAY} ` +
          `(${check.data.reason}), so the upload is unverified. The file was almost certainly ` +
          "pinned; this check only proves it when the gateway answers.",
      );
    }
  } else {
    warnings.push(
      "Verification was skipped, so nothing has confirmed that the CID addresses these exact " +
        "bytes.",
    );
  }

  return ok({
    ok: true,
    command: "upload-file",
    status: "published",
    published: true,
    fileURI: uploaded.data.fileURI,
    cid: uploaded.data.cid,
    ...extensionField,
    file: describeFile,
    verified,
    endpoint,
    warnings,
    message:
      `Uploaded ${file.data.filename} to ${uploaded.data.fileURI}` +
      (verified ? ", and confirmed that CID resolves to these exact bytes" : "") +
      ". The file is public and permanent. **Nothing has been submitted to any dispute** — " +
      "pass this URI to submit-evidence as --file-uri" +
      (extension === undefined ? "" : `, with --file-type-extension ${extension}`) +
      ".",
  });
}
