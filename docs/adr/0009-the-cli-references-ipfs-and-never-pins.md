# The CLI references IPFS content and never pins it

`kleros-juror-cli` is pure RPC: no subgraph, no HTTP services, no off-chain writes. That simplicity
is load-bearing — it is why the tool has no credentials beyond a signing key, why no service outage
can wedge it, and why every failure mode is on chain. Dispute templates and evidence attachments
are addressed by IPFS CID, so inheriting that property looked like the thing dispute creation would
break.

It does not. **This tool takes already-pinned URIs as inputs and never pins anything.**

## The research that made this easy

The threat was structural: if the tool *had* to produce a CID before it could send a transaction,
an HTTP client and a pinning credential would sit in the signing path by necessity. Two findings
remove the necessity.

- On the `createDisputeForTemplate` path, **the template body travels inline in calldata** as a
  `string` argument. It is not uploaded and it has no CID.
- `EvidenceModule.submitEvidence` takes **inline JSON**, not a URI. A bare `/ipfs/…` string in that
  argument parse-fails in the subgraph and indexes as an unnamed blob.

So the happy path touches IPFS for exactly two things, both of them *inputs the caller supplies*:

| Operation | Needs IPFS? |
| --- | --- |
| `submit-evidence`, text only | **No** |
| `submit-evidence` with an attachment | Yes, for `fileURI` |
| `create-dispute` with an inline template | Only for `policyURI` |
| `create-dispute` by template URI | Yes, for the template itself |

That is the same shape as the juror CLI taking its choice as an input rather than deciding it, and
the same shape as ADR-0007's opacity rule: the tool records a URI and never dereferences it.

## Two layers that are easy to conflate

`policyURI` is **required by the dispute-template schema** and **not enforced by the contract**.
Those are statements about different layers and they have different consequences.

- The contract does not look at it. A dispute created without a `policyURI` succeeds on chain,
  jurors are drawn, and the ruling is delivered normally.
- Off-chain consumers do — the canonical zod schema and the Court UI's `isTemplateValid`. A
  template that fails them renders degraded in Court.
- The schema wants a **multiaddr** (`/ipfs/…` or `ipfs://…/…`). A plain `https://` URL fails the
  refinement, so accepting one and passing it through would produce a dispute that is valid on
  chain and broken in the interface.

The tool therefore validates the *shape* of the URI it is handed (ADR-0010) and refuses a plain
HTTPS URL, while never fetching what it points at.

## If pinning is ever brought in scope

Behind its own ADR and its own **separate, non-signing subcommand** — never in the same process
invocation as a broadcast. The options, worst fit last:

- The **Netlify function** at `kleros-api.netlify.app/.netlify/functions/upload-to-ipfs`
  (`kleros/court-functions`, `functions/upload-to-ipfs.ts`), unauthenticated. This is the endpoint
  Kleros's own code reaches for — `kleros/reputation-oracle`'s `web/src/lib/ipfs.ts` uses it, and
  it is the one to prefer over Atlas when reading the Court UI's `SubmitEvidenceModal.tsx`
  **[maintainer]**. It needs no credential, no second chain and no second token, which is what
  makes it a better fit here than either of the next two. **Not verified from this repo**: nothing
  in it has been called, and it is a service rather than a contract, so its availability and its
  terms are somebody else's to change.
- `cdn.kleros.link/add`, unauthenticated per its OpenAPI spec. **Untested**, and the Court UI
  reaches IPFS through SIWE-gated Atlas, which is documented as internal-only. Verify before
  designing around it.
- The `kleros-ipfs-upload` gateway: x402-paywalled at $0.01 USDC **on Base**. A second chain, a
  second token and a second key, in a tool whose whole premise is one chain and one key.
- Bring-your-own pinner, configured by the operator.

Kleros's own documentation advises pinning independently regardless, which is a further argument
that this belongs upstream with whoever authored the content.

## Consequences

The credential surface stays at exactly one signing key. There is no partial-failure state where
content is pinned but not submitted, or submitted pointing at content that never pinned. No service
outage can wedge a write. And `--template-uri`, `--policy-uri` and `--file-uri` are ordinary string
arguments the caller is responsible for — which is the honest division of labour, because the party
that authored the content is the party that should be keeping it available.
