import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A one-file JSON-RPC endpoint, so the **write** path can be tested without a
 * fork.
 *
 * `simulateAndMaybeBroadcast` builds its wallet client internally — deliberately,
 * so a caller cannot hand it a transport pointed somewhere else — which leaves no
 * seam to inject a stub through. Pointing `rpcUrls[0]` at this server is the
 * seam, and it is a better one: what arrives here is the **signed transaction**,
 * so a test can decode it and assert what was actually going to be sent rather
 * than what a mock was told.
 *
 * That is the only way to close `spec/04 §2`'s second change without a chain:
 * `value` threaded into the simulation and the estimate but not into the send is
 * a bug no assertion on the *inputs* can see.
 */
export type RpcServer = {
  url: string;
  /** Every request received, in order. */
  calls: { method: string; params: unknown[] }[];
  /** The raw signed transactions handed to `eth_sendRawTransaction`. */
  sent: `0x${string}`[];
  close: () => Promise<void>;
};

export async function startRpcServer(responses: Record<string, unknown> = {}): Promise<RpcServer> {
  const calls: { method: string; params: unknown[] }[] = [];
  const sent: `0x${string}`[] = [];

  const canned: Record<string, unknown> = {
    eth_chainId: "0xa4b1",
    eth_getTransactionCount: "0x0",
    eth_maxPriorityFeePerGas: "0x0",
    eth_gasPrice: "0x5f5e100",
    eth_sendRawTransaction: `0x${"11".repeat(32)}`,
    ...responses,
  };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      const params = payload.params ?? [];
      calls.push({ method: payload.method, params });
      if (payload.method === "eth_sendRawTransaction") {
        sent.push(params[0] as `0x${string}`);
      }

      const result = canned[payload.method];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: payload.method } }
            : { jsonrpc: "2.0", id: payload.id, result },
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
