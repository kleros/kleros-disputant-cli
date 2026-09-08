import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // The package's `import` condition resolves to CommonJS text, so it can never be
  // an external ESM import at runtime; bundling it also spares end users a large
  // install for a handful of addresses and three ABIs. ADR-0006.
  noExternal: ["@kleros/kleros-v2-contracts"],
  esbuildOptions(options) {
    // Bundle the two leaf modules this tool uses, not the barrel — the barrel
    // `require`s the typechain factories, which `require("ethers")`. See
    // `build/kleros-deployments.mjs`.
    options.alias = {
      ...options.alias,
      "@kleros/kleros-v2-contracts/cjs/deployments": fileURLToPath(
        new URL("build/kleros-deployments.mjs", import.meta.url),
      ),
    };
  },
  dts: false,
  sourcemap: true,
  // The bundled deployment modules are CommonJS and `require("viem")`, which esbuild
  // cannot satisfy in ESM output while viem stays external — its fallback throws on
  // the first call. The banner puts a real `require` in scope of every emitted file,
  // including the shared chunk, which evaluates before the entry and so cannot be
  // fixed from there.
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
  onSuccess: "chmod +x dist/cli.js",
});
