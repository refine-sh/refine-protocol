# Security policy

Do not report vulnerabilities in a public issue. Email
[support@refine.sh](mailto:support@refine.sh) with a subject beginning
`SECURITY:`. The eventual public repository must also enable GitHub private
vulnerability reporting before Protocol 1.0.0 is tagged.

## Security boundary

Protocol 1.0 is local to macOS and one OS user. The endpoint directory is mode
`0700`; the descriptor, sibling `owner.lock`, and socket are mode `0600`; the
socket lives in a random mode-`0700` runtime directory; the server verifies the peer
UID with `getpeereid`; and a per-launch random token authenticates the
handshake. The peer UID and token are validated before any typed diagnostic.

This prevents access by other OS users and nonlocal peers. It deliberately does
not defend against another process already running as the same user, because
that process can read the endpoint descriptor and use the user's configured
Refine providers. Client, host, and frontend identifiers are self-reported
labels, not principals. Recognition of a Refine-owned label is product metadata
and never authorization.

Never log or publish launch tokens, socket paths, source content, Apply text,
provider credentials, or diagnostic payloads containing those values.

## Privacy boundary

Clients send complete source snapshots to Refine. A configured cloud provider
may receive source under the user's Refine configuration. Report is a distinct,
explicit user action that may send original and revised snippets and language,
provider, model, custom-instruction, Refine-version, and macOS-version context
to Refine's feedback service. The writing-check provider and Refine's feedback
service are distinct destinations and both MUST be disclosed accurately.
Clients own disclosure, telemetry, logging, and retention for processing
outside Refine.
