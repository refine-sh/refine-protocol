# TypeScript transport-session reference

This dependency-free source demonstrates the intentionally small public seam:

- connect from an endpoint descriptor;
- authenticate and negotiate exact Protocol 1.0;
- validate the descriptor directory, sibling `owner.lock`, descriptor, socket,
  descriptor PID, and welcome/rejection union;
- expose `serverEpoch` and `runResumed`;
- decode every base handshake, command, event, nested union, identifier, limit,
  range, presentation, explanation, and Apply invariant before use;
- send validated, contiguous command envelopes and close at client-sequence
  exhaustion;
- consume validated, contiguous, epoch-bound event envelopes;
- close on malformed frames or events and require close after fatal faults or
  server-sequence exhaustion; and
- close the session.

It does not implement `WritingHost`, editor observation, presentation,
coalescing, reconnect policy, or Apply mutation. Those belong to a higher-level
runtime or host adapter.

Node.js 22.18 or newer can execute these erasable TypeScript sources directly.
This repository does not publish or support an npm package for Protocol 1.0.
If TypeScript and the Node type declarations are already available, `tsc -p
reference/typescript/tsconfig.json` provides an optional static check; neither
is required to execute the reference CLI.

```sh
python3 runner/conformance.py socket --scenario golden-writing-session \
  --client node reference/typescript/cli.ts
```

The CLI is the language-neutral scenario-adapter contract's TypeScript example
and supports every socket-runnable state vector listed in
[`runner/README.md`](../../runner/README.md). Its only success output is
`{"status":"ok","scenario":"SCENARIO_ID"}` on standard output; diagnostics go
to standard error.

The decoder applies the global portable JSON profile to unknown members before
ignoring them. The source remains nonnormative; the schemas and specification
are authoritative.
