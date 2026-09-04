# Arbitration fees are paid in ETH only

`KlerosCore` exposes two cost quotes: `arbitrationCost(bytes _extraData)` and
`arbitrationCost(bytes _extraData, IERC20 _feeToken)`. This tool binds only the first. There is no
`--fee-token` flag, and the ERC-20 path cannot be reached from the CLI surface at all.

## Why

The two quotes disagree by an order of magnitude, and the disagreement could not be explained from
the deployed code.

For a dispute quoted at **0.015 ETH**, `arbitrationCost(extraData, WETH)` returns **0.15 WETH** —
10×. The relevant state reads as `currencyRates(WETH) = (feePaymentAccepted: true, rateInEth: 1,
rateDecimals: 1)`, which is consistent with either reading: the rate is misconfigured on chain, or
the conversion is applied in the wrong direction. The deployed `KlerosCore` is 0.10.0 and computes
from `currencyRates` directly, while `master` delegates to a `RatesConverter` — so the formula that
is actually running could not be read from the package's sources, which are `master` (ADR-0006).

Either way, one of the two outcomes is a caller paying ten times the arbitration cost, or paying a
tenth of it and having the dispute under-funded. Both are irreversible: `msg.value` is forwarded
wholesale and never refunded, and the juror count is derived from the amount.

## Why no flag at all, rather than a flag that refuses

A `--fee-token` that always fails with a named code would document the gap in `--llms-full`, which
has real value for an agent consumer that would otherwise have to guess. It was rejected on two
grounds. It ships a flag that has never once worked, which is a documentation defect of exactly the
kind this repo has committed to not inheriting — `kleros-juror-cli` documents a `--verbose` flag
that does not exist, and that is cited in `CLAUDE.md` as a thing to fix rather than repeat. And a
flag that exists but refuses invites a `--force`; an absent flag does not.

The gap is recorded here and in `CLAUDE.md` instead, which is where a reader looking for *why*
would go.

## What would reopen this

A fork test that pins the actual conversion. Read `currencyRates` and the ERC-20 branch of
`arbitrationCost` against the **deployed** 0.10.0 bytecode — not the package sources — establish
which direction the rate is applied in, and confirm against a live ERC-20 dispute whether the core
credits `feeForJuror` correctly. Until that exists, this stays closed.

## Consequences

`arbitrationCost` in this codebase is unambiguous: one function, one argument, ETH. The balance
check compares `balanceWei` against `estimatedFeeWei + value` with no token branch. The envelope
reports value in wei and in ETH, with no currency field to get wrong.
