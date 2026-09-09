# 03: `--chain` exists, with v2 Beta the only value served

**What to build:** A caller can name the deployment explicitly, and every result says which
deployment it came from. Asking for a deployment this tool does not serve gets a named refusal
before anything is contacted, instead of silence or a transport error. Behaviour for every existing
invocation is unchanged: the default is v2 Beta, and a command run without the new option does
exactly what it did before.

Only `arbitrum-one` is served by this ticket. The second deployment arrives in 04.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] A new module owns the slug-to-deployment table: a small, closed, pure structure with no
      dependency on the contracts package, mapping a slug to that package's deployment key, the
      expected chain ID, the default endpoint, and the name of the deployment's RPC override
      variable — derived by formula, never written twice.
- [ ] The deployment module stops resolving addresses and ABIs at module load and becomes a function
      of a deployment.
- [ ] `--chain`, alias `-c`, is declared **per command** on every command that touches the chain, and
      is absent from `upload-file`. It is not a root option: the framework's global mechanism reaches
      handlers but is never merged into the machine-readable tool schemas, so a root declaration
      would silently vanish from every structured call.
- [ ] The gloss pairing each slug with the name humans use for it appears **once**, in the `--chain`
      description. It is not repeated in other help strings, messages or CTAs.
- [ ] A new `CHAIN_NOT_SUPPORTED` code refuses: the devnet slug, with a message saying its write
      surface differs and is unsupported here even though the sibling read tool serves it; the
      retired bare Arbitrum Sepolia slug, naming both replacements and reusing the sibling's wording;
      and any unknown slug. It is distinct from the existing wrong-chain code, which means the
      endpoint answered an unexpected chain ID — a runtime condition, where this is an input one.
- [ ] The refusal happens before any network contact, asserted by a test showing zero round trips.
- [ ] Every envelope echoes the resolved deployment slug and the asserted chain ID, on success and on
      failure, alongside the effective court, juror count and dispute kit already reported.
- [ ] Every CTA carries `--chain`. The court-listing hint no longer hardcodes a slug — as written it
      would send a caller to look up a court on a deployment other than the one that refused.
- [ ] The chain-specific public exports are renamed: the assertion helper becomes a function of a
      deployment, and the single default-endpoint constant becomes per-deployment.
- [ ] Omitting `--chain` resolves to `arbitrum-one`. No environment variable and no configuration
      file selects the deployment.
