# 02: Evidence reaches an addressable identifier

**What to build:** Evidence submitted through this tool lands under the identifier the Kleros Court
client resolves, instead of under one that happens to match only on Arbitrum One. A caller still
passes the core dispute ID and never learns a second identifier. Where this tool cannot address a
dispute at all, it refuses and says who owns it, rather than filing evidence nothing can read.

This is a defect on the current deployment, not preparation for a second one. The equality it relies
on holds on Arbitrum One only because the dispute resolver created every dispute in existence there,
and expires the first time another arbitrable files.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `submit-evidence` resolves the core dispute ID to the arbitrable's local dispute ID and submits
      the local one.
- [ ] The dispute's arbitrable is checked **before** the mapping is trusted. The core-to-local
      mapping returns zero for a dispute belonging to another arbitrable — a default value, not a
      mapping — so used alone it would silently resolve a foreign dispute to local ID zero.
- [ ] A new refusal, `DISPUTE_NOT_ADDRESSABLE`, covers a dispute that exists but was created by a
      different arbitrable. The message names the owning arbitrable so the caller can see the case is
      real and this tool is the limitation, and is distinct from the existing not-found refusal so a
      caller does not retry an identifier that will never work.
- [ ] No additional round trip. The dispute record is already fetched in the first multicall and
      carries the arbitrable; the mapping takes only the core dispute ID, so it joins that same call.
- [ ] Tests use the measured divergence — a dispute record naming a foreign arbitrable, and a mapping
      returning 33 for core dispute 58 — and are written against the **v2 Beta** double, because the
      defect is reachable there.
- [ ] At least one path reaches the new refusal through the JSON-RPC double, so the HTTP client
      builds the real request, as the verification specification requires.
- [ ] A new ADR records the resolution, the measurements behind it, and that this is a Beta defect the
      testnet exposed rather than testnet scope.
- [ ] The read-scope ADR is amended: reads may determine **what** to sign, not only **whether** to
      sign, where the alternative is a write that cannot be read back.
- [ ] The evidence-policy ADR gains a line for the second hard refusal. Its "warns and never refuses"
      policy is unchanged in substance — the exception has always been unreachability.
- [ ] The payload-construction section of the specification records which identifier is submitted and
      why, replacing the claim that the core dispute ID is what the evidence module takes.
