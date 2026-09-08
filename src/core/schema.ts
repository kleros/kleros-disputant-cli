import type { z } from "incur";

/**
 * Turning a zod failure into one line an agent can act on.
 *
 * `z` is imported from `incur`, never from `zod` — one zod instance
 * (`spec/03 §3.1`). `@kleros/kleros-sdk` is not a runtime dependency: its parser
 * is deliberately lenient and an authoring schema must be strict, which is the
 * exact inverse (ADR-0010).
 */

/**
 * The first issue, named. Only one is reported: the payload is kept small
 * (`spec/03 §5.1`), and an operator fixes template errors one at a time anyway.
 *
 * An unrecognised key is reported by name rather than by path, because rejecting
 * unknown keys instead of silently stripping them is the whole point of the
 * strict schema (`spec/02 §3.2`) and a bare path of `""` would bury it.
 */
export function describeZodIssues(issues: readonly z.core.$ZodIssue[]): string {
  const issue = issues[0];
  if (issue === undefined) return "the document did not match the schema";
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((k) => JSON.stringify(k)).join(", ");
    return `unknown field ${keys} — unknown fields are rejected, not ignored`;
  }
  const path = issue.path.join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}
