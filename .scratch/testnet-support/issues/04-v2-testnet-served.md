# 04: v2 testnet served

**What to build:** `--chain arbitrum-sepolia-testnet` works. A caller can quote an arbitration cost,
plan a dispute and simulate it against the v2 testnet, with the same mechanics as v2 Beta and no path
that exists on one deployment only.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] `arbitrum-sepolia-testnet` joins the table and resolves end to end for reads and simulation.
- [ ] ABIs are bound per deployment. They are not interchangeable: the dispute resolver and evidence
      module ABIs are byte-identical across the two, but the arbitrator's differ — 123 entries against
      115 — with the whitelist and juror-NFT functions and four errors present only on Beta.
- [ ] Each deployment carries its own default endpoint, and both RPC override variables are honoured.
      Their names are derived by the same formula the sibling CLI uses, so one exported variable
      serves both tools.
- [ ] The fingerprint test covers both deployments and records the ABI difference, so an upstream
      regeneration breaks the build rather than a transaction. **Accepted cost:** a testnet
      redeployment will fail this test. That is intended — a redeployment silently changes where
      transactions are sent — and is the only ongoing maintenance this feature adds.
- [ ] The in-process JSON-RPC double takes a deployment and answers as either one, from the real ABIs.
      The seam stays the endpoint option: nothing injected, no module mocked.
- [ ] A **differential test** runs the same inputs against both deployments and asserts the envelopes
      are structurally identical apart from the deployment fields and the addresses. This is what
      catches a future branch on the deployment — a ceiling skipped on the testnet, a gate added
      there — and turns "identical mechanics" into a pinned property.
- [ ] The startup-ordering test runs at the testnet chain ID, proving the expected value is read from
      the selected deployment rather than a constant, and that no contract call precedes the assertion.
- [ ] The suite is **not** run as a matrix. The second deployment appears only in the differential
      test, the startup-ordering test and the unsupported-slug refusals; mechanics are identical by
      design, so running every test twice would execute the same lines against different constants.
- [ ] Court validation is confirmed to need no per-deployment table: court existence is already probed
      live, so the testnet's court set is discovered rather than written down.
