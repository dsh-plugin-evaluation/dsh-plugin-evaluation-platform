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

## Local HTTP API

The optional local server is exposed by `createLocalApiServer` and uses only
Node's built-in `http` module. It serves the versioned `/api/v1` surface:

- `GET /health`, `/status`, `/plugins`, `/sources`, `/runs`, and `/reports`
- `POST /runs` to start a single managed evaluation
- `GET /runs/:runId` and `POST /runs/:runId/cancel`
- `GET /reports/:reportId` and `GET /reports/:reportId/export`

Run requests accept only absolute local plugin paths, a non-empty prompt, and
an optional bounded timeout. Request bodies are capped at 64 KiB. Responses,
run output, errors, reports, and exports redact credential-like values. The API
does not serve browser assets and does not read or write `.omo` state.
