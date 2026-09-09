# `pnpm test:fork` can run against a fork it did not start

**Free `:8546` before running it.** A stale anvil left by an earlier run makes the harness pass its
own readiness check against the wrong process, and the suite goes green against a fork carrying
whatever state that earlier run left behind.

```bash
lsof -ti :8546 | xargs kill    # then: pnpm test:fork
```

## Why the guard does not catch it

The script starts anvil in the background and waits for it like this:

```sh
anvil --fork-url … --port 8546 --silent & ANVIL=$!
until cast chain-id --rpc-url http://127.0.0.1:8546 >/dev/null 2>&1; do
  kill -0 $ANVIL 2>/dev/null || { echo 'anvil exited before it was reachable' >&2; exit 1; }
  sleep 0.25
done
```

The liveness check runs **only when `cast` fails**. If a previous anvil still holds the port, the
new one cannot bind and exits immediately — but `cast chain-id` succeeds on the *first* iteration,
answered by the stale process, so the loop exits before `kill -0` is ever evaluated. The guard is
bypassed deterministically, not by an unlucky race. Verified 2026-09-09:

```
$ anvil --port 8599 --silent          # a second one, port already held
Error: Address already in use (os error 48)
$ cast chain-id --rpc-url http://127.0.0.1:8599
31337                                  # the first anvil is still answering
```

`kill $ANVIL` at the end then reaps the process that already exited, so the stale fork survives the
run and serves the next one too.

## Why it matters here rather than being a nuisance

The fork suite is the only place in this repo that **broadcasts**, and the only place that can seed
the state production lacks — an overpayment, and a second arbitrable (`spec/05 §2`). Each test runs
inside `evm_snapshot`/`evm_revert`, which isolates tests *within* one run and does nothing about
state an earlier run left on a surviving process. So the failure mode is a green suite that proves
less than it claims, on the tests whose whole purpose is to prove something production cannot.

Two sightings, both on 2026-09-09: a run whose wait loop spun forever because anvil had bound the
port but never answered, and a run that passed in 37 s while a stale PID had been holding the port a
minute earlier — after the fact there was no way to tell which process had served it.

**Treat a green fork run as trustworthy only if `:8546` was free when it started.**
