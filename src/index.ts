/**
 * The library entry point.
 *
 * `package.json` advertises `main`, `exports` and `types`, so the package must
 * resolve as a library as well as a `bin` — a manifest pointing at a file tsup
 * never built would break `import` for anyone who installed it.
 *
 * What is exported is the **framework-free core** and nothing else: pure
 * functions returning `KlerosResult`, the payload builders, and the resolved
 * deployment. The command layer is deliberately absent — it owns incur, exit
 * codes and CTA blocks, none of which mean anything to an importer, and keeping
 * it out is what lets `src/core/` move to `@kleros/agentkit` as close to a file
 * move as possible (ADR-0001, `spec/03 §8`).
 */

export type {
  BroadcastParams,
  BroadcastResult,
  FeePlan,
  WriteCall,
} from "./core/broadcast.js";
export { simulateAndMaybeBroadcast } from "./core/broadcast.js";
export type { MulticallEntry, Outcome, StartupFacts } from "./core/client.js";
export {
  assertArbitrumOne,
  checkDeployment,
  createKlerosClient,
  DEFAULT_RPC_URL,
  EXPECTED_VERSIONS,
  multicall,
  parseRpcUrls,
  startup,
} from "./core/client.js";
export type { QuoteAssessment } from "./core/cost.js";
export {
  checkBalance,
  checkCostCeiling,
  checkValueAffordable,
  LARGE_QUOTE_WEI,
  quoteWarnings,
} from "./core/cost.js";
export {
  ARBITRUM_ONE_CHAIN_ID,
  DISPUTE_RESOLVER,
  DISPUTE_RESOLVER_ABI,
  DISPUTE_RESOLVER_RULER,
  DISPUTE_TEMPLATE_REGISTRY,
  EVIDENCE_MODULE,
  EVIDENCE_MODULE_ABI,
  KLEROS_CORE,
  KLEROS_CORE_ABI,
} from "./core/deployment.js";
export type { EvidenceDocument, EvidencePayload } from "./core/evidence.js";
export { buildEvidence, parseEvidenceDocument, serialiseEvidence } from "./core/evidence.js";
export type { ExtraDataWords } from "./core/extra-data.js";
export { EXTRA_DATA_BYTES, encodeExtraData } from "./core/extra-data.js";
export {
  formatWeiAsEth,
  parseBigInt,
  parseEthToWei,
  parseGweiToWei,
} from "./core/numbers.js";
export type {
  ChainFacts,
  EffectiveDispute,
  EvidenceAssessment,
  EvidenceChainFacts,
  ExtraDataFacts,
  ExtraDataResult,
  Period,
  PreflightFacts,
  PreflightResult,
  RequestedDispute,
  RequestedExtraData,
} from "./core/preflight.js";
export {
  checkEffective,
  checkEvidencePreflight,
  checkExtraData,
  checkPreflight,
  EVIDENCE_PRESSURE_DENOMINATOR,
  EVIDENCE_PRESSURE_NUMERATOR,
  PERIODS,
} from "./core/preflight.js";
export type {
  CurrentRuling,
  ReadCreateDisputeParams,
  ReadEvidenceParams,
} from "./core/read-preflight.js";
export {
  quoteArbitrationCost,
  readBalance,
  readCreateDisputeFacts,
  readCreatedDisputeID,
  readCurrentRuling,
  readEffectiveDispute,
  readEvidenceFacts,
} from "./core/read-preflight.js";
export type { ErrorCode, KlerosResult } from "./core/result.js";
export { err, ok } from "./core/result.js";
export type { DecodedRevert } from "./core/reverts.js";
export { decodeRevert, ERROR_SELECTORS } from "./core/reverts.js";
export type { LoadSignerOptions } from "./core/signer.js";
export { loadSigner } from "./core/signer.js";
export type { DisputeTemplate, TemplateAnswer, TemplatePayload } from "./core/template.js";
export {
  buildTemplate,
  NO_DATA_MAPPINGS,
  parseTemplate,
  serialiseTemplate,
} from "./core/template.js";
export type {
  FileToUpload,
  UploadOutcome,
  UploadRequest,
  VerifyOutcome,
} from "./core/upload.js";
export {
  buildUploadRequest,
  DEFAULT_GATEWAY,
  DEFAULT_UPLOAD_URL,
  ENCODED_BUDGET_BYTES,
  postUpload,
  readFileToUpload,
  verifyUpload,
} from "./core/upload.js";
