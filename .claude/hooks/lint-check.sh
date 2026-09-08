#!/usr/bin/env bash
# Stop hook: run `pnpm lint` at end-of-turn and block the stop (feeding the errors
# back to the model) if Biome exits non-zero. Silent on success.
#
# CI already runs typecheck, lint and test on every push and PR, so this is not the
# gate — it is the same gate moved earlier. A finding that surfaces here is fixed by
# the turn that caused it, while that turn still has the context; the same finding on
# CI arrives after the context is gone. Lint only: it is the fast half, and the
# 30s timeout is not a budget for `tsc`.
#
# Mirrors ai-juror-dashboard/.claude/hooks/lint-check.sh; that repo is on yarn.

set -u

INPUT=$(cat)

# Prevent an infinite retry loop: if Claude Code already invoked us and the model is
# trying to stop again after acting on our feedback, let it through.
if printf '%s' "$INPUT" | grep -q '"stop_hook_active":[[:space:]]*true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# Skip if there is no lint script, so the hook stays harmless if copied elsewhere.
if ! grep -q '"lint"[[:space:]]*:' package.json 2>/dev/null; then
  exit 0
fi

# Skip rather than fail if pnpm is unreachable (a shell without Volta on PATH). A
# missing package manager is an environment problem, not a lint finding, and blocking
# the turn over it would be noise the model cannot act on.
if ! command -v pnpm >/dev/null 2>&1; then
  exit 0
fi

LINT_OUTPUT=$(pnpm lint 2>&1)
LINT_EXIT=$?

if [ "$LINT_EXIT" -eq 0 ]; then
  exit 0
fi

# Non-zero: emit to stderr and exit 2, which blocks the stop and feeds the output back.
{
  echo "pnpm lint failed (exit $LINT_EXIT). Fix these errors before ending the turn:"
  echo
  echo "$LINT_OUTPUT"
} >&2
exit 2
