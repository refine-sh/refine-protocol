# Refine Integration Protocol

This repository is the release-candidate source of truth for **Integration
Protocol 1.0**, the supported interface used by writing-host clients to connect
to Refine over a local macOS Unix-domain socket.

The package is self-contained and can be vendored without a network checkout.
It contains:

- the [normative protocol specification](spec/protocol.md);
- normative JSON Schemas in [`schema/`](schema/);
- an immutable [base capability registry](registry/capabilities.json);
- positive, negative, framed-byte, and state-machine vectors in `vectors/`;
- a dependency-free conformance runner and fake Refine peer in `runner/`; and
- a nonnormative TypeScript transport-session client in `reference/typescript/`.

This is an **unreleased release candidate**. It is not Protocol 1.0.0 and must
not be represented as the frozen final contract until the coordinated Refine
app and first-party client conformance gate passes.

## Verify the artifact

Python 3.9 or newer and Node.js 22.18 or newer are sufficient; no package
installation or network access is required.

```sh
python3 runner/conformance.py verify
python3 runner/conformance.py socket --client node reference/typescript/cli.ts
python3 runner/conformance.py server --scenario base-handshake \
  --adapter /absolute/path/to/server-adapter
python3 -m unittest discover -s tests
```

`verify` checks every manifest digest, strict JSON lexical rules, schemas,
semantic rules, framed-byte vectors, and state transcripts. `socket` starts a
fake Refine peer on a temporary real `AF_UNIX` socket and exercises the supplied
client command through the documented transport-session seam. `server` gives a
self-driving production-server test adapter a private descriptor directory and
one scenario, then verifies its lifecycle and machine-readable result.

The manifest reports an `artifactDigest` over every shipped regular file except
`manifest.json` itself. Only `.git`, Python bytecode/cache files, and
`.DS_Store` are outside that digest scope; tests and nonnormative reference
source are included. Verification rejects an unlisted shipped file as well as
a missing or modified listed file. `baseArtifactDigest` covers the normative
specification, schemas, and vectors, while `capabilityRegistryDigest` covers the
registry snapshot. Consumer pins should record all three so package bytes,
base protocol bytes, and the append-only registry do not become conflated
version axes.

Manifest artifact paths are relative POSIX paths in lexical order. Both
aggregate digests are SHA-256 over the UTF-8 concatenation of
`path + NUL + lowercase-file-sha256 + LF` for each included entry in that
order; `baseArtifactDigest` filters the same ordered entries to kinds `schema`,
`spec`, and `vectors`.

The manifest also carries exact, ordered inventories of every positive JSON,
negative JSON, frame, and state-scenario ID. The manifest updater preserves
those inventories instead of deriving away removed coverage; verification
compares them with the shipped vector contents.

## Normative authority

Schemas govern parsed JSON shape, required members, primitive constraints, and
discriminated unions. The prose specification governs framing, lexical JSON
validity, state, ordering, semantics, recovery, security, and limits. Vectors
test those rules but do not override them. A disagreement is a specification
defect, not permission to silently change a tagged artifact.

See [SUPPORT.md](SUPPORT.md), [SECURITY.md](SECURITY.md), and
[COMPATIBILITY-CLAIMS.md](COMPATIBILITY-CLAIMS.md) before shipping an
integration.

## License

The specification, schemas, vectors, runner, and reference source are available
under the [MIT License](LICENSE).
