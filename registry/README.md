# Capability registry

[`capabilities.json`](capabilities.json) is the immutable registry snapshot for
the Protocol 1.0 base artifact. It is empty: an activated capability set of
`[]` is the complete base protocol.

Future entries are append-only, immutable, versioned identifiers in a
publisher-controlled reverse-domain namespace, ending in `.vN`; Refine-owned
entries use `com.runjuu.refine.<feature>.vN`. Every ID occurs at most once in a
registry snapshot and has a separately published, digest-bound specification.
The registry itself has no 64-entry limit; that limit applies to each
connection's negotiation arrays. An implementation activates only capabilities
in the exact registry snapshot it vendors and implements. Unknown or private
offers are ignored and never echoed.
