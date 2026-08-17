# Support

Integration Protocol 1.0 supports a writing-host client connecting to the
shipping Refine server on macOS as the same local OS user. Refine must already
be running. Network transports, cross-user access, sandbox workarounds,
automatic app launch, Windows, Linux, and third-party production servers are
outside the supported profile.

Refine treats reproducible conformance failures as product bugs and maintains
exact Protocol 1.0 compatibility throughout Refine 1.x. There is no additional
time-based guarantee, integration-development service, certification program,
or SLA.

Conformance is self-assessed with this repository's offline runner. There is no
approval gate or compatibility badge. Before reporting an interoperability
problem, run:

```sh
python3 runner/conformance.py verify
```

Include the artifact digest printed by the runner, the failing scenario ID,
client and Refine versions, exact local and remote protocol versions, macOS
version, and a minimal reproduction. Never include launch tokens, full source
text, provider credentials, or user documents in a public report.

The public interoperability issue tracker is the repository issue tracker. It
will become an official support surface only when this release-candidate
repository is intentionally published; no publication is implied by this local
bootstrap.
