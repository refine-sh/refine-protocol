# Compatibility claims

The layers below are independent:

1. The MIT license permits commercial and noncommercial implementations.
2. Technical conformance measures only the wire contract using the released
   schemas, vectors, and runner.
3. Refine supports conforming writing-host clients within the profile in
   [SUPPORT.md](SUPPORT.md), without an integration-development SLA.
4. The public statement **“Compatible with Refine Protocol 1.0”** has the
   additional conditions below.

An integration making that compatibility statement must:

- pass the Protocol 1.0 conformance suite for every advertised release;
- accurately disclose that complete source flows to Refine and may flow to the
  user's configured provider;
- separately disclose that Report goes to Refine's feedback service, not the
  writing-check provider, and may include original/revised snippets plus
  language, provider, model, custom-instruction, Refine-version, and
  macOS-version context;
- submit Report only after an explicit user gesture; and
- disclose its own telemetry, logging, and retention behavior.

Conformance is self-assessed. There is no approval gate, certification badge,
or implied endorsement. “Refine for …”, Refine logos, and wording that implies
official recognition or endorsement are reserved. Failure to meet the claim
conditions affects the claim and official support, not MIT permission, socket
admission, or wire conformance.

This release-candidate repository does not yet authorize a final Protocol 1.0
claim. The claim becomes available only for the content-identical artifact
tagged `v1.0.0` after the coordinated release gate.
