import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { uploadSuccessCta } from "../../commands/shared.js";
import { runUploadFile } from "../../commands/upload.js";
import {
  buildUploadRequest,
  ENCODED_BUDGET_BYTES,
  postUpload,
  readFileToUpload,
  verifyUpload,
} from "../upload.js";

/**
 * `spec/05 §1.8` — the whole upload path, offline.
 *
 * **Nothing here reaches the network.** Every `fetch` is a fake that records
 * what it was handed, and several tests assert it was never called at all. The
 * live checks are `spec/06 §5` and are run by hand, because they upload real
 * files to a real pinning service.
 */

const dir = mkdtempSync(join(tmpdir(), "kleros-upload-"));

function fixture(name: string, contents: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that answers from a script and records every call. */
function fakeFetch(responses: (() => Response)[]): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!next) throw new Error("no scripted response");
    return next();
  }) as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

const pinned = (cid: string) =>
  new Response(
    JSON.stringify({
      message: "File has been stored successfully",
      cids: [cid],
      inconsistentCids: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const failed = (result: { success: boolean; code?: string; message?: string }) => {
  if (result.success) throw new Error("expected a refusal, got a pass");
  return result as { success: false; code: string; message: string };
};

describe("local validation happens before any request — spec/06 §3", () => {
  it("refuses an unreadable path without calling fetch", async () => {
    const fetchImpl = fakeFetch([]);
    const result = await runUploadFile({
      file: join(dir, "does-not-exist.pdf"),
      publish: true,
      verify: true,
      fetchImpl,
    });
    expect(failed(result).code).toBe("FILE_UNREADABLE");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("names a directory as a directory", () => {
    expect(failed(readFileToUpload(dir)).message).toContain("is a directory");
  });

  it("refuses an empty file, because the endpoint would answer 200 and pin nothing", async () => {
    const fetchImpl = fakeFetch([]);
    const result = await runUploadFile({
      file: fixture("empty.txt", ""),
      publish: true,
      verify: true,
      fetchImpl,
    });
    const e = failed(result);
    expect(e.code).toBe("FILE_EMPTY");
    expect(e.message).toContain("200");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("derives fileTypeExtension from the path, and omits it when there is none", () => {
    const withExt = readFileToUpload(fixture("photos.PDF", "x"));
    const without = readFileToUpload(fixture("noextension", "x"));
    if (!withExt.success || !without.success) throw new Error("unexpected refusal");
    expect(withExt.data.fileTypeExtension).toBe("PDF");
    expect(without.data.fileTypeExtension).toBeUndefined();
  });

  it("hashes the bytes it read", () => {
    const file = readFileToUpload(fixture("hashed.txt", "kleros"));
    if (!file.success) throw new Error("unexpected refusal");
    expect(file.data.sha256).toBe(
      "3c3f8cb4e33b594466b6a3a1fd0f0bbf26b9223c28ca60e5f1b9b90df72799f5",
    );
  });
});

describe("the request is shaped as spec/06 §2 fixes it", () => {
  it("sends one file part, with operation present and pinToGraph false", async () => {
    const file = readFileToUpload(fixture("shape.txt", "hello"));
    if (!file.success) throw new Error("unexpected refusal");
    const request = await buildUploadRequest(file.data, "https://example.invalid/fn");
    if (!request.success) throw new Error("unexpected refusal");

    expect(request.data.url).toBe("https://example.invalid/fn?operation=evidence&pinToGraph=false");
    expect(request.data.contentType).toContain("multipart/form-data; boundary=");

    const body = Buffer.from(request.data.body).toString("utf8");
    expect(body.match(/name="file"/g)).toHaveLength(1);
    expect(body).toContain('filename="shape.txt"');
    expect(body).toContain("hello");
  });

  /**
   * The service discards `operation`'s value but `400`s when it is absent
   * **[service]**. Nothing else in this file would notice it going missing, and
   * a regression that drops it breaks every upload.
   */
  it("keeps operation in the query even though the service never reads its value", async () => {
    const file = readFileToUpload(fixture("op.txt", "x"));
    if (!file.success) throw new Error("unexpected refusal");
    const request = await buildUploadRequest(file.data, "https://example.invalid/fn");
    if (!request.success) throw new Error("unexpected refusal");
    expect(new URL(request.data.url).searchParams.get("operation")).toBe("evidence");
  });
});

describe("the size gate measures the real request — spec/06 §3.1", () => {
  const encodedLengthOf = (n: number) => Math.ceil(n / 3) * 4;

  it("accepts a file just inside the budget and refuses one just outside", async () => {
    // Work back from the budget to a file size, then step either side of it.
    const overhead = 200;
    const bodyBudget = Math.floor((ENCODED_BUDGET_BYTES / 4) * 3);
    const inside = readFileToUpload(
      fixture("inside.bin", new Uint8Array(bodyBudget - overhead - 1024)),
    );
    const outside = readFileToUpload(fixture("outside.bin", new Uint8Array(bodyBudget + 1024)));
    if (!inside.success || !outside.success) throw new Error("unexpected refusal");

    const okRequest = await buildUploadRequest(inside.data, "https://example.invalid/fn");
    expect(okRequest.success).toBe(true);
    if (okRequest.success) {
      expect(okRequest.data.encodedBytes).toBeLessThanOrEqual(ENCODED_BUDGET_BYTES);
      expect(okRequest.data.encodedBytes).toBe(encodedLengthOf(okRequest.data.body.length));
    }

    const tooBig = await buildUploadRequest(outside.data, "https://example.invalid/fn");
    const e = failed(tooBig);
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(e.message).toContain("413");
  });

  /**
   * The filename travels inside the measured body, so it moves the boundary.
   * This is the reason the check serialises the request instead of assuming a
   * constant overhead.
   */
  it("counts the filename, not just the file", async () => {
    const bytes = new Uint8Array(4096);
    const short = readFileToUpload(fixture("s.bin", bytes));
    const long = readFileToUpload(fixture(`${"n".repeat(120)}.bin`, bytes));
    if (!short.success || !long.success) throw new Error("unexpected refusal");

    const a = await buildUploadRequest(short.data, "https://example.invalid/fn");
    const b = await buildUploadRequest(long.data, "https://example.invalid/fn");
    if (!a.success || !b.success) throw new Error("unexpected refusal");
    expect(b.data.encodedBytes).toBeGreaterThan(a.data.encodedBytes);
  });
});

describe("a 2xx is not a success — spec/06 §4.1", () => {
  const request = async () => {
    const file = readFileToUpload(fixture("resp.txt", "payload"));
    if (!file.success) throw new Error("unexpected refusal");
    const built = await buildUploadRequest(file.data, "https://example.invalid/fn");
    if (!built.success) throw new Error("unexpected refusal");
    return built.data;
  };

  it("treats 200 with an empty cids array as a failure", async () => {
    const result = await postUpload(
      await request(),
      fakeFetch([() => new Response(JSON.stringify({ cids: [] }), { status: 200 })]),
    );
    const e = failed(result);
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(e.message).toContain("no CID");
  });

  it("does not parse a 413 body as JSON", async () => {
    const result = await postUpload(
      await request(),
      fakeFetch([
        () => new Response("", { status: 413, headers: { "content-type": "text/plain" } }),
      ]),
    );
    const e = failed(result);
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(e.message).toContain("413");
  });

  it("reports a transport failure without claiming anything was pinned", async () => {
    const throwing = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const e = failed(await postUpload(await request(), throwing));
    expect(e.code).toBe("UPLOAD_FAILED");
    expect(e.message).toContain("Nothing was uploaded");
  });

  it("normalises a bare CID and a prefixed one to the same fileURI", async () => {
    const bare = await postUpload(await request(), fakeFetch([() => pinned("QmAbc")]));
    const prefixed = await postUpload(await request(), fakeFetch([() => pinned("/ipfs/QmAbc")]));
    if (!bare.success || !prefixed.success) throw new Error("unexpected refusal");
    expect(bare.data.fileURI).toBe("/ipfs/QmAbc");
    expect(prefixed.data.fileURI).toBe("/ipfs/QmAbc");
    expect(prefixed.data.cid).toBe("QmAbc");
  });
});

describe("verification — spec/06 §4.2", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);

  it("passes when the gateway returns the same bytes", async () => {
    const result = await verifyUpload("/ipfs/QmAbc", bytes, {
      fetchImpl: fakeFetch([() => new Response(bytes, { status: 200 })]),
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(result.data.verified).toBe(true);
  });

  /** The truncation this check exists for: a valid CID for the wrong bytes. */
  it("refuses when the gateway returns a truncated body", async () => {
    const result = await verifyUpload("/ipfs/QmAbc", bytes, {
      fetchImpl: fakeFetch([() => new Response(bytes.slice(0, 2), { status: 200 })]),
    });
    const e = failed(result);
    expect(e.code).toBe("UPLOAD_MISMATCH");
    expect(e.message).toContain("MUST NOT be submitted");
  });

  it("refuses when the bytes differ at the same length", async () => {
    const result = await verifyUpload("/ipfs/QmAbc", bytes, {
      fetchImpl: fakeFetch([() => new Response(new Uint8Array([1, 2, 3, 9]), { status: 200 })]),
    });
    expect(failed(result).code).toBe("UPLOAD_MISMATCH");
  });

  it("warns rather than fails when the gateway never answers", async () => {
    const fetchImpl = fakeFetch([() => new Response("", { status: 504 })]);
    // retryDelayMs: 0 — there is no propagation to wait for behind a fake fetch,
    // and the production default would make this test three seconds long.
    const result = await verifyUpload("/ipfs/QmAbc", bytes, {
      fetchImpl,
      attempts: 3,
      retryDelayMs: 0,
    });
    if (!result.success) throw new Error("a silent gateway must not be a failure");
    expect(result.data.verified).toBe(false);
    expect(fetchImpl.calls).toHaveLength(3);
  });
});

describe("the command — spec/06 §1, §7", () => {
  it("uploads nothing without --publish, and says so in words", async () => {
    const fetchImpl = fakeFetch([]);
    const result = await runUploadFile({
      file: fixture("checked.txt", "some evidence"),
      publish: false,
      verify: true,
      fetchImpl,
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(fetchImpl.calls).toHaveLength(0);
    expect(result.data.status).toBe("checked");
    expect(result.data.published).toBe(false);
    expect(result.data.fileURI).toBeUndefined();
    expect(String(result.data.message)).toContain("CHECKED ONLY");
    expect(String(result.data.message)).toContain("--publish");
  });

  it("publishes, verifies, and says nothing was submitted", async () => {
    const contents = "attachment bytes";
    const fetchImpl = fakeFetch([
      () => pinned("/ipfs/QmAbc"),
      () => new Response(Buffer.from(contents), { status: 200 }),
    ]);
    const result = await runUploadFile({
      file: fixture("published.pdf", contents),
      publish: true,
      verify: true,
      fetchImpl,
    });
    if (!result.success) throw new Error("unexpected refusal");

    expect(result.data.status).toBe("published");
    expect(result.data.fileURI).toBe("/ipfs/QmAbc");
    expect(result.data.cid).toBe("QmAbc");
    expect(result.data.fileTypeExtension).toBe("pdf");
    expect(result.data.verified).toBe(true);
    expect(result.data.warnings).toEqual([]);

    // An agent holding a CID is one step from believing the evidence is filed.
    expect(String(result.data.message)).toContain("Nothing has been submitted");
    expect(fetchImpl.calls[0]?.init?.method).toBe("POST");
    expect(fetchImpl.calls[1]?.url).toContain("/ipfs/QmAbc");
  });

  it("succeeds with a warning when the gateway cannot confirm", async () => {
    const result = await runUploadFile({
      file: fixture("unconfirmed.txt", "bytes"),
      publish: true,
      verify: true,
      fetchImpl: fakeFetch([() => pinned("QmAbc"), () => new Response("", { status: 502 })]),
      retryDelayMs: 0,
    });
    if (!result.success) throw new Error("an unconfirmed upload must not be a failure");
    expect(result.data.verified).toBe(false);
    expect(String((result.data.warnings as string[])[0])).toContain("unverified");
  });

  it("warns when verification is skipped", async () => {
    const result = await runUploadFile({
      file: fixture("skipped.txt", "bytes"),
      publish: true,
      verify: false,
      fetchImpl: fakeFetch([() => pinned("QmAbc")]),
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(result.data.verified).toBe(false);
    expect(String((result.data.warnings as string[])[0])).toContain("Verification was skipped");
  });

  it("warns about a plaintext endpoint", async () => {
    const result = await runUploadFile({
      file: fixture("plain.txt", "bytes"),
      publish: false,
      verify: true,
      uploadUrl: "http://localhost:9999/fn",
      fetchImpl: fakeFetch([]),
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(String((result.data.warnings as string[])[0])).toContain("not HTTPS");
  });

  it("hands submit-evidence the two arguments it just produced", async () => {
    const result = await runUploadFile({
      file: fixture("cta.pdf", "bytes"),
      publish: true,
      verify: false,
      fetchImpl: fakeFetch([() => pinned("QmAbc")]),
    });
    if (!result.success) throw new Error("unexpected refusal");

    const cta = uploadSuccessCta(result.data);
    const command = cta?.commands[0]?.command ?? "";
    expect(command).toContain("--file-uri /ipfs/QmAbc");
    expect(command).toContain("--file-type-extension pdf");
    // The dispute and the deployment are the two things this command cannot
    // know, so both stay placeholders rather than being invented
    // (`spec/03 §5.4`). `--chain` deliberately does **not** fall back to the
    // default here: `upload-file` touches no chain, so guessing one would be
    // the silent redirection the "every CTA carries --chain" rule exists to
    // prevent (ADR-0015).
    expect(command).toContain("--dispute <id>");
    expect(command).toContain("--chain <slug>");
  });

  it("offers no CTA for a check, because nothing was published to pass on", async () => {
    const result = await runUploadFile({
      file: fixture("cta-check.pdf", "bytes"),
      publish: false,
      verify: true,
      fetchImpl: fakeFetch([]),
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(uploadSuccessCta(result.data)).toBeUndefined();
  });

  it("never returns a payload carrying the file's contents", async () => {
    const secretish = "the body of the attachment";
    const result = await runUploadFile({
      file: fixture("body.txt", secretish),
      publish: true,
      verify: false,
      fetchImpl: fakeFetch([() => pinned("QmAbc")]),
    });
    if (!result.success) throw new Error("unexpected refusal");
    expect(JSON.stringify(result.data)).not.toContain(secretish);
  });
});
