import { describe, expect, it } from "vitest";
import {
  assertArbitrumOne,
  checkDeployment,
  DEFAULT_RPC_URL,
  EXPECTED_VERSIONS,
  parseRpcUrls,
  rpcError,
  startup,
} from "../client.js";
import { ARBITRUM_ONE_CHAIN_ID, DISPUTE_TEMPLATE_REGISTRY, KLEROS_CORE } from "../deployment.js";
import { failure, fakeClient, functionNames, success } from "./fake-client.js";

/**
 * `spec/03 §7` — the startup checks, whose **ordering is a safety property**.
 *
 * No network: the client is a stand-in exposing only the three methods this
 * module calls. What is asserted here is the order and the consequences, not
 * viem's transport.
 */

const versions = () => [
  success(KLEROS_CORE.address),
  success(DISPUTE_TEMPLATE_REGISTRY.address),
  success(EXPECTED_VERSIONS.KlerosCore),
  success(EXPECTED_VERSIONS.EvidenceModule),
];

describe("parseRpcUrls", () => {
  it("falls back to the public endpoint when the option is absent or blank", () => {
    expect(parseRpcUrls(undefined)).toEqual([DEFAULT_RPC_URL]);
    expect(parseRpcUrls("")).toEqual([DEFAULT_RPC_URL]);
    expect(parseRpcUrls("  , ,")).toEqual([DEFAULT_RPC_URL]);
  });

  it("splits a comma-separated list and trims it", () => {
    expect(parseRpcUrls("https://a.example , https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});

describe("the chain assertion", () => {
  it("accepts 42161", async () => {
    const result = await assertArbitrumOne(fakeClient({ chainId: ARBITRUM_ONE_CHAIN_ID }));
    expect(result).toEqual({ success: true, data: ARBITRUM_ONE_CHAIN_ID });
  });

  it("refuses any other chain by name, and says nothing was sent", async () => {
    const result = await assertArbitrumOne(fakeClient({ chainId: 1 }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("WRONG_CHAIN");
    expect(result.message).toContain("chain 1");
    expect(result.message).toContain("Nothing was sent");
  });

  /**
   * An unreachable endpoint is `RPC_ERROR`, not `WRONG_CHAIN`: nothing was
   * judged, so nothing can be concluded about the request. The two carry
   * different exit codes for the same reason (`spec/03 §4`).
   */
  it("reports an unreachable endpoint as an RPC failure, not a wrong chain", async () => {
    const client = fakeClient({
      chainId: () => {
        throw new Error("fetch failed");
      },
    });
    const result = await assertArbitrumOne(client);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("RPC_ERROR");
  });
});

describe("the deployment's own view of itself", () => {
  it("passes when arbitrator() and templateRegistry() agree with the resolved addresses", async () => {
    const result = await checkDeployment(fakeClient({ multicall: versions }));
    expect(result).toEqual({ success: true, data: [] });
  });

  /**
   * An RPC returns lowercase and the contracts package returns a checksummed
   * literal, so a raw string comparison would fail on every healthy deployment.
   */
  it("compares addresses checksum-insensitively", async () => {
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [
          success(KLEROS_CORE.address.toLowerCase()),
          success(DISPUTE_TEMPLATE_REGISTRY.address.toLowerCase()),
          success(EXPECTED_VERSIONS.KlerosCore),
          success(EXPECTED_VERSIONS.EvidenceModule),
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("fails when the resolver arbitrates through a different core", async () => {
    const other = "0x1111111111111111111111111111111111111111";
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [
          success(other),
          success(DISPUTE_TEMPLATE_REGISTRY.address),
          success(EXPECTED_VERSIONS.KlerosCore),
          success(EXPECTED_VERSIONS.EvidenceModule),
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DEPLOYMENT_INCONSISTENT");
    expect(result.message).toContain("arbitrator()");
    expect(result.message).toContain("never quoted a fee from");
  });

  it("fails when the template registry disagrees", async () => {
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [
          success(KLEROS_CORE.address),
          success("0x2222222222222222222222222222222222222222"),
          success(EXPECTED_VERSIONS.KlerosCore),
          success(EXPECTED_VERSIONS.EvidenceModule),
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DEPLOYMENT_INCONSISTENT");
    expect(result.message).toContain("templateRegistry()");
  });

  it("fails when the resolver does not answer at all", async () => {
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [failure(), failure(), success("0.10.0"), success("0.8.0")],
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("DEPLOYMENT_INCONSISTENT");
  });

  /** `spec/03 §7` step 4: a version mismatch **warns** and never fails. */
  it("warns on a version bump and still succeeds", async () => {
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [
          success(KLEROS_CORE.address),
          success(DISPUTE_TEMPLATE_REGISTRY.address),
          success("0.11.0"),
          success(EXPECTED_VERSIONS.EvidenceModule),
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toContain("KlerosCore reports version 0.11.0");
    expect(result.data[0]).toContain(EXPECTED_VERSIONS.KlerosCore);
  });

  /**
   * Both contracts declare `version()` **[abi]**, so failing to read one already
   * means the deployed shape is not the one this tool was built against. It is
   * reported rather than passed over in silence — still a warning, per §7.
   */
  it("treats an unreadable version() as a mismatch rather than ignoring it", async () => {
    const result = await checkDeployment(
      fakeClient({
        multicall: () => [
          success(KLEROS_CORE.address),
          success(DISPUTE_TEMPLATE_REGISTRY.address),
          success(EXPECTED_VERSIONS.KlerosCore),
          failure(),
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0]).toContain("EvidenceModule reports version unreadable");
  });
});

describe("startup ordering", () => {
  /**
   * The one ordering that matters: a deployment registry lookup is scoped to a
   * deployment, so trusting it on an unverified chain reads the wrong core. On a
   * wrong chain **no contract call may be made at all**.
   */
  it("makes no contract call when the chain assertion fails", async () => {
    const client = fakeClient({ chainId: 1, multicall: versions });
    const result = await startup(client);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe("WRONG_CHAIN");
    expect(client.calls).toHaveLength(0);
  });

  it("asks the deployment about itself before anything else, in one batch", async () => {
    const client = fakeClient({ multicall: versions });
    const result = await startup(client);

    expect(result).toEqual({
      success: true,
      data: { chainId: ARBITRUM_ONE_CHAIN_ID, warnings: [] },
    });
    expect(client.calls).toHaveLength(1);
    expect(functionNames(client.calls[0])).toEqual([
      "arbitrator",
      "templateRegistry",
      "version",
      "version",
    ]);
  });
});

/**
 * `ADR-0013`. The cause was captured under `details.cause` and
 * read by nothing — not the default payload, not `--full-output`, not
 * `--format json` — so one code and one exit status covered an endpoint that is
 * down, a rate limit and an account that cannot pay. `details.hint` is the only
 * key `finish` renders (`spec/03 §5.4`), so the cause travels there.
 */
describe("an RPC failure says what the endpoint said", () => {
  const hintOf = (result: ReturnType<typeof rpcError>) => {
    if (result.success) throw new Error("expected a failure");
    return (result.details as { hint?: string }).hint;
  };

  it("prefers the node's own words over viem's wrapper", () => {
    // viem's BaseError shape: `details` is the node's message verbatim.
    const cause = Object.assign(
      new Error("Execution reverted.\n\nDocs: https://viem.sh\nVersion: 2"),
      {
        details: "insufficient funds for transfer",
        shortMessage: "An unknown error occurred.",
      },
    );

    expect(hintOf(rpcError("Failed to estimate gas or fees. Nothing was sent.", cause))).toBe(
      "The endpoint said: insufficient funds for transfer",
    );
  });

  it("falls back to the short message, then to the first line", () => {
    const short = Object.assign(new Error("long\nbody"), { shortMessage: "HTTP request failed." });
    expect(hintOf(rpcError("x", short))).toBe("The endpoint said: HTTP request failed.");

    const plain = new Error("connect ECONNREFUSED 127.0.0.1:8545\n    at TCPConnectWrap");
    expect(hintOf(rpcError("x", plain))).toBe(
      "The endpoint said: connect ECONNREFUSED 127.0.0.1:8545",
    );
  });

  it("does not echo a remote response body back into its own payload", () => {
    // `--rpc-url` pointed at a website: viem puts the whole page in `details`.
    const cause = Object.assign(new Error("HTTP request failed."), {
      details: '"<!doctype html><html lang=\\"en\\"><head><title>Example Domain</title>',
      shortMessage: "HTTP request failed. Status: 200",
    });

    expect(hintOf(rpcError("x", cause))).toBe(
      "The endpoint said: HTTP request failed. Status: 200",
    );
  });

  it("reads a JSON-RPC error body rather than discarding it as a body", () => {
    // Body-shaped, but it holds the one sentence worth surfacing.
    const cause = Object.assign(new Error("e"), {
      details: '{"code":-32000,"message":"insufficient funds for gas * price + value"}',
      shortMessage: "An unknown error occurred.",
    });

    expect(hintOf(rpcError("x", cause))).toBe(
      "The endpoint said: insufficient funds for gas * price + value",
    );
  });

  it("never echoes the endpoint back, because --rpc-url may carry an API key", () => {
    const cause = new Error("getaddrinfo ENOTFOUND https://rpc.example.com/v2/SECRETKEY");
    const hint = hintOf(rpcError("x", cause));

    expect(hint).not.toContain("SECRETKEY");
    expect(hint).not.toContain("rpc.example.com");
    expect(hint).toBe("The endpoint said: getaddrinfo ENOTFOUND <rpc-url>");
  });

  it("keeps the payload small, because the whole envelope is read by a program", () => {
    const hint = hintOf(rpcError("x", new Error("z".repeat(500))));
    // The cap, plus the "The endpoint said: " prefix.
    expect(hint?.length).toBeLessThanOrEqual(180);
    expect(hint?.endsWith("…")).toBe(true);
  });

  it("distinguishes two failures that used to be one opaque code", () => {
    const broke = rpcError(
      "x",
      Object.assign(new Error("e"), { details: "429 Too Many Requests" }),
    );
    const poor = rpcError("x", Object.assign(new Error("e"), { details: "insufficient funds" }));

    expect(hintOf(broke)).not.toBe(hintOf(poor));
  });

  it("omits the hint rather than rendering an empty one", () => {
    expect(hintOf(rpcError("x", new Error("")))).toBeUndefined();
  });
});
