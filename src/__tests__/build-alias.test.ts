import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_SLUGS, DEPLOYMENTS } from "../core/deployments.js";

/**
 * The bundler alias — `build/kleros-deployments.mjs`, `tsup.config.ts`, ADR-0006.
 *
 * **This file exists because the test run cannot reach that shim.** Vitest
 * resolves `@kleros/kleros-v2-contracts/cjs/deployments` to the package's real
 * barrel; only `pnpm build` swaps in the alias. So every name `deployment.ts`
 * imports is exercised twice with one of the two paths unchecked, and an
 * omission in the shim fails **nothing but the build** — which is what happened
 * when the v2 testnet was registered: `testnetViem` reached `deployment.ts` and
 * never reached the alias, `pnpm test` and `pnpm typecheck` both stayed green,
 * and `pnpm build` broke for anyone who ran the README's Install steps.
 *
 * Registering a deployment therefore means adding a line to that shim, and this
 * is what says so before the build does.
 */

const SUBPATH = "@kleros/kleros-v2-contracts/cjs/deployments";
const ALIAS_PATH = fileURLToPath(new URL("../../build/kleros-deployments.mjs", import.meta.url));
const DEPLOYMENT_TS = fileURLToPath(new URL("../core/deployment.ts", import.meta.url));

/**
 * The names `deployment.ts` asks the subpath for, read from its source rather
 * than from a list kept here — a list would be a third place to update, and the
 * defect this guards against is exactly a place someone forgot to update.
 *
 * Aliased imports (`getAddress as getDeployedAddress`) are recorded under the
 * name the *package* exports, which is the one the shim has to provide.
 */
function importedNames(): string[] {
  const source = readFileSync(DEPLOYMENT_TS, "utf8");
  const clause = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*["']${SUBPATH}["']`).exec(
    source,
  );
  if (clause === null) throw new Error(`No import from ${SUBPATH} found in deployment.ts`);

  return (clause[1] as string)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.split(/\s+as\s+/)[0] as string).trim());
}

describe("the build-time alias", () => {
  it("exports every name deployment.ts imports from the subpath", async () => {
    const alias = await import(ALIAS_PATH);
    const names = importedNames();

    // Guards the guard: a regex that quietly matched nothing would assert
    // nothing, and pass.
    expect(names.length).toBeGreaterThan(1);
    expect(Object.keys(alias)).toEqual(expect.arrayContaining(names));
  });

  /**
   * The forward-looking half. `deployment.ts` reaches a deployment's addresses
   * and ABIs through `<packageKey>Viem`, so serving a new deployment needs a new
   * leaf module in the alias — and the build is a poor place to find that out.
   */
  it("carries one viem namespace per served deployment", async () => {
    const alias = await import(ALIAS_PATH);

    for (const slug of DEPLOYMENT_SLUGS) {
      const namespace = `${DEPLOYMENTS[slug].packageKey}Viem`;
      expect(alias, `${slug} needs ${namespace} in build/kleros-deployments.mjs`).toHaveProperty(
        namespace,
      );
      expect(alias[namespace].klerosCoreAbi).toBeDefined();
    }
  });
});
