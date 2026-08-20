# DSH Plugin Evaluation Platform

`@dsh-plugin-evaluation/evaluation-platform` is a local Node 20 service for
managing isolated DSH evaluation runs. It provides a small HTTP API and a
dependency-free browser console; it does not require a database or a separate
frontend build.

## Install and start

From a published package:

```sh
npm install @dsh-plugin-evaluation/evaluation-platform@0.1.5
npx dsh-evaluation
```

The default listener is `http://127.0.0.1:3000`. Set `HOST` and `PORT` to
change the bind address. Open `/` for the console, or call `/api/v1/health`
for a machine-readable readiness check. Without `PLATFORM_DSH_ROOT`, the CLI
uses a fixture host and does not execute evaluations. Set `PLATFORM_DSH_ROOT`
to a DSH checkout for live runs. The plugin registry defaults to
`~/.dsh-evaluation/registry`; override it with
`DSH_EVALUATION_REGISTRY_ROOT`.

## Release

普通 push 只运行 CI，不会发布 npm。发布新版本时，先更新
`package.json` 的版本号，再创建并推送同名 tag：

```bash
npm version patch
git push origin main --follow-tags
```

推送 `vX.Y.Z` tag 后，GitHub Actions 会先运行 `npm run verify`，确认 tag
与 `package.json` 版本一致后，再通过 npm Trusted Publishing 发布包。首次使用前，需要在 npm 包设置中将对应 GitHub 仓库和 `Publish` workflow 配置为 Trusted Publisher。

As a library, the package exports `createEvaluationServer`, `startServer`,
`ManagedDshHost`, `PluginRegistry`, `EvaluationOrchestrator`, and the
versioned API/server building blocks from `src/index.js`.

## Catalog-governed sources

The package owns catalog-governed loading of evaluation profiles and cases. It
reads the standards catalog, accepts only HTTPS GitHub sources pinned to a
plain semantic version, a `vX.Y.Z` tag, or a 40-character commit SHA, validates
the fetched JSON, and returns an immutable cached snapshot.

Each fetched JSON document is hashed with SHA-256 over its exact UTF-8 bytes.
Those hashes are part of immutable provenance and cache identity; a source
adapter may provide expected hashes, which are checked before parsing. Paths
are rejected before adapter reads, including percent-encoded, double-encoded,
backslash, separator, dot-segment, and traversal variants.

The loader treats source files as data. It never imports, evaluates, or runs
content from a source repository. Tests use a local fixture adapter keyed by a
catalog-approved GitHub repository and ref; this keeps tests offline without
weakening the catalog's HTTPS GitHub policy.

## Local HTTP API and console

The server uses only Node's built-in `http` module and serves the versioned
`/api/v1` surface:

- `GET /health`, `/status`, `/plugins`, `/sources`, `/runs`, and `/reports`
- `POST /plugins` to register a local plugin (`{"path":"/absolute/plugin"}`)
- `POST /runs` to start a single managed evaluation
- `GET /runs/:runId` and `POST /runs/:runId/cancel`
- `GET /reports/:reportId` and `GET /reports/:reportId/export`

Run requests accept registered `pluginIds` or absolute local plugin paths, plus
either a non-empty `prompt` or a versioned `scheme` containing `id`, `version`,
and `prompt`. The scheme identity is copied into report provenance. Request
bodies are capped at 64 KiB. Responses,
run output, errors, reports, and exports redact credential-like values. The
browser console is served from `/`; API traffic is kept under `/api/v1`.

## Sources, plugins, and runtime isolation

When a real DSH runtime is configured, each managed run receives its own
private `DSH_HOME` and profile directory. The host enforces bounded timeouts,
termination, concurrency limits, and redaction of credential-like values in
status, reports, and errors. Do not point it at a user's existing DSH home.

The default CLI uses a fixture host and therefore does not execute evaluations.
This makes a fresh installation safe to inspect. Configure a real runtime
through the exported host options before using it for live evaluations.

## Development and release checks

The repository has no third-party runtime dependency installation step:

```sh
npm test           # unit and HTTP/orchestration tests
npm run check      # Node syntax checks
npm run clean-room # pack, install the tarball in a fresh directory, call health
npm run verify     # all checks above plus package dry-run
```

`npm run clean-room` is local and does not publish anything. The package's
`files` allowlist includes only the CLI, browser assets, source, README, design
notes, and MIT license.
