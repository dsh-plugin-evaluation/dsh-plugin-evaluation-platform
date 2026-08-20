# DSH Plugin Evaluation Platform

This standalone Node 20 package owns catalog-governed loading of evaluation
profiles and cases. It reads the standards catalog, accepts only HTTPS GitHub
sources pinned to a plain semantic version, `vX.Y.Z` tag, or 40-character
commit SHA, validates the fetched JSON, and returns an immutable cached
snapshot.

Each fetched JSON document is hashed with SHA-256 over its exact UTF-8 bytes.
Those hashes are part of immutable provenance and cache identity; a source
adapter may provide expected hashes, which are checked before parsing. Paths
are rejected before adapter reads, including percent-encoded, double-encoded,
backslash, separator, dot-segment, and traversal variants.

The loader treats source files as data. It never imports, evaluates, or runs
content from a source repository. Tests use a local fixture adapter keyed by a
catalog-approved GitHub repository and ref; this keeps tests offline without
weakening the catalog's HTTPS GitHub policy.
