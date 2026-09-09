# Never expand an elided address — resolve it from the package

The docs in this repo write addresses elided: `0xb5526D…4323` in
[`spec/01 §3.1`](../spec/01-onchain-reference.md), `0x991d2df1…` in commit bodies, and so on. They
are for reading, not for pasting into a call.

**Reconstructing one from its visible ends produces a syntactically valid address that is not the
contract.** An `eth_call` against it does not error — it returns the zero-value answer for whatever
you asked, and that answer looks exactly like a real measurement.

Seen 2026-09-09 while verifying `ADR-0015`: `arbitrableWhitelist(0xb5526D3B5B8Ae2e18b1Ffa1e2e19D0Fe9B4e4323)`
returned `false`, apparently contradicting `spec/01 §3.1`'s **[live]** claim that the dispute
resolver is whitelisted. The address was invented — the real one is
`0xb5526D022962A1fFf6eD32C93e8b714c901F4323`, and it returns `true`. A `false` from a mapping getter
for an address nobody ever whitelisted is the *correct* answer to the wrong question, and nothing in
the transport says so.

Always read the address from the deployment artifact instead:

```bash
node -e "const d=require('@kleros/kleros-v2-contracts/cjs/deployments').arbitrum.default;
         console.log(d.contracts.DisputeResolver.address)"
```

The general shape: **a getter that cannot revert cannot tell you that you asked about the wrong
subject.** The same trap is why `arbitratorDisputeIDToLocalID` needs the arbitrable checked first —
it returns `0` for a dispute it has never seen, and `0` is a real local dispute ID
([`ADR-0014`](../adr/0014-evidence-is-filed-under-the-local-dispute-id.md)). Two instances of one
mistake, in the same week, on the same deployment.
