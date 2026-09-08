/**
 * Build-time stand-in for `@kleros/kleros-v2-contracts/cjs/deployments`.
 *
 * The subpath's barrel `require`s `./contractsEthers`, which pulls in the typechain
 * factories; those `require("ethers")` at module scope — a dependency the package
 * never declares, satisfied only by a hoisted copy. CommonJS is not tree-shakeable,
 * so bundling the barrel drags all of it into `dist/` along with an `ethers` this
 * tool never calls.
 *
 * Everything this CLI uses sits in two leaf modules whose require graph is viem and
 * nothing else. `./cjs/deployments` **is** a declared subpath — that part is fine —
 * but paths *below* it are not, so the leaves can only be reached by relative path,
 * which is why this is a bundler alias (see `tsup.config.ts`) rather than an import
 * `deployment.ts` could write directly. `spec/01 §1.1`, ADR-0006.
 */
export { deployments, getAddress } from "../node_modules/@kleros/kleros-v2-contracts/cjs/deployments/utils.js";
export * as mainnetViem from "../node_modules/@kleros/kleros-v2-contracts/cjs/deployments/mainnet.viem.js";
