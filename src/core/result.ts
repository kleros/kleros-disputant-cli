/**
 * The core/commands seam, mirroring `@kleros/agentkit` so a port upstream stays
 * mechanical (ADR-0001, `spec/03 §8`). Core modules return `KlerosResult`; only
 * the command layer knows about incur, exit codes or CTA blocks. **Core never
 * throws.**
 */

/**
 * Every failure code this CLI can produce. A closed union, not `string`:
 * `spec/03 §4` requires the exit-code map to be a `Record<ErrorCode, number>`,
 * so adding a code here is a compile error until the map covers it. The juror
 * CLI has two codes that fall through a `?? 1` default; nothing is broken by it
 * today, which is exactly why it went unnoticed.
 *
 * The codes fixed by `spec/03 §5.5` MUST NOT be renamed — they are the machine
 * contract, and the consuming agent branches on them.
 */
export type ErrorCode =
  // Startup — `spec/03 §7`
  | "WRONG_CHAIN"
  // `extraData` pre-flight — `spec/02 §1.1`. None of these has an on-chain
  // backstop: the decoder substitutes defaults and never reverts (`spec/01 §4.4`).
  | "COURT_OUT_OF_RANGE"
  | "COURT_DISABLED"
  | "JURORS_INVALID"
  | "DISPUTE_KIT_OUT_OF_RANGE"
  | "DISPUTE_KIT_NOT_SUPPORTED"
  | "DISPUTE_KIT_REFUSED"
  // Payload authoring — `spec/02 §3`, `§4`
  | "TEMPLATE_INVALID"
  | "RULING_OPTIONS_INVALID"
  | "POLICY_URI_INVALID"
  | "EVIDENCE_INVALID"
  // Money — `spec/02 §2`, `spec/04 §2`
  | "COST_CEILING_EXCEEDED"
  | "INSUFFICIENT_BALANCE"
  // Evidence path — `spec/02 §4.2`
  | "DISPUTE_NOT_FOUND"
  // Post-send — `spec/02 §1.2`, `spec/01 §5`
  | "EFFECTIVE_MISMATCH"
  | "SIMULATION_REVERTED"
  // Option parsing. Every numeric option is `z.string()` and parsed here, so a
  // bad number fails with a stable code rather than incur's validation error
  // (`spec/03 §3.1`). Not in `§5.5`'s list, which that section says is not
  // exhaustive.
  | "NUMBER_INVALID";

export type KlerosResult<T> =
  | { success: true; data: T }
  | { success: false; code: ErrorCode; message: string; details?: unknown };

export function ok<T>(data: T): KlerosResult<T> {
  return { success: true, data };
}

export function err<T = never>(
  code: ErrorCode,
  message: string,
  details?: unknown,
): KlerosResult<T> {
  return details === undefined
    ? { success: false, code, message }
    : { success: false, code, message, details };
}
