import { createServer } from 'node:http'
import { basename, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redact } from './managed-dsh-host.js'
import { EvaluationOrchestrator } from './orchestrator.js'

const API_PREFIX = '/api/v1'
const MAX_BODY_BYTES = 64 * 1024
const MAX_PROMPT_LENGTH = 32 * 1024
const MAX_PLUGIN_PATHS = 32

function redactValue(value, key = '') {
  if (/api[_ -]?key|secret|token|password|authorization/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryValue, entryKey)]))
  }
  return value
}

function errorPayload(error) {
  const status = error?.code === 'run-in-progress' ? 409 : 400
  return { status, body: { error: { code: error?.code ?? 'bad-request', message: redact(error?.message ?? 'Request failed'), details: redactValue(error?.details ?? {}) } } }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(redactValue(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(text)
}

function validateRunInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be an object'), { code: 'invalid-body' })
  const allowed = ['pluginPaths', 'pluginIds', 'prompt', 'scheme', 'timeoutMs', 'provenance']
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error('Request body contains unsupported fields'), { code: 'invalid-body' })
  if (body.pluginPaths !== undefined && (!Array.isArray(body.pluginPaths) || body.pluginPaths.length > MAX_PLUGIN_PATHS)) throw Object.assign(new Error('pluginPaths must contain at most 32 paths'), { code: 'invalid-plugin-paths' })
  if (body.pluginIds !== undefined && (!Array.isArray(body.pluginIds) || body.pluginIds.length > MAX_PLUGIN_PATHS)) throw Object.assign(new Error('pluginIds must contain at most 32 ids'), { code: 'invalid-plugin-ids' })
  if (body.pluginIds !== undefined && body.pluginPaths !== undefined) throw Object.assign(new Error('Use either pluginIds or pluginPaths, not both'), { code: 'invalid-plugin-selector' })
  if ((body.pluginPaths === undefined || body.pluginPaths.length === 0) && (body.pluginIds === undefined || body.pluginIds.length === 0)) throw Object.assign(new Error('At least one plugin path or id is required'), { code: 'plugin-required' })
  if (body.pluginPaths?.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw Object.assign(new Error('pluginPaths must be absolute local paths'), { code: 'invalid-plugin-paths' })
  if (body.pluginIds?.some(id => typeof id !== 'string' || id.length === 0)) throw Object.assign(new Error('pluginIds must be non-empty strings'), { code: 'invalid-plugin-ids' })
  if (body.prompt !== undefined && body.scheme !== undefined) throw Object.assign(new Error('Use either prompt or scheme, not both'), { code: 'invalid-scheme' })
  if (body.scheme !== undefined && (!body.scheme || typeof body.scheme !== 'object' || Array.isArray(body.scheme) || typeof body.scheme.id !== 'string' || body.scheme.id.length === 0 || typeof body.scheme.version !== 'string' || body.scheme.version.length === 0 || typeof body.scheme.prompt !== 'string')) throw Object.assign(new Error('scheme must contain non-empty id, version, and prompt'), { code: 'invalid-scheme' })
  const prompt = body.scheme?.prompt ?? body.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_LENGTH) throw Object.assign(new Error('prompt is required and must be at most 32768 characters'), { code: 'invalid-prompt' })
  if (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 600_000)) throw Object.assign(new Error('timeoutMs must be an integer from 1 to 600000'), { code: 'invalid-timeout' })
  return {
    ...(body.pluginPaths === undefined ? {} : { pluginPaths: [...body.pluginPaths] }),
    ...(body.pluginIds === undefined ? {} : { pluginIds: [...body.pluginIds] }),
    prompt,
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...((body.provenance === undefined && body.scheme === undefined) ? {} : { provenance: { ...(body.provenance ?? {}), ...(body.scheme === undefined ? {} : { scheme: { id: body.scheme.id, version: body.scheme.version } }) } }),
  }
}

function validatePluginRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be an object'), { code: 'invalid-body' })
  const allowed = ['path', 'spec', 'cwd']
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error('Request body contains unsupported fields'), { code: 'invalid-body' })
  if ((body.path === undefined) === (body.spec === undefined)) throw Object.assign(new Error('Exactly one of path or spec is required'), { code: 'invalid-plugin-registration' })
  if (body.path !== undefined && (typeof body.path !== 'string' || body.path.length === 0)) throw Object.assign(new Error('path must be a non-empty string'), { code: 'invalid-plugin-registration' })
  if (body.spec !== undefined && (typeof body.spec !== 'string' || body.spec.length === 0)) throw Object.assign(new Error('spec must be a non-empty string'), { code: 'invalid-plugin-registration' })
  if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !isAbsolute(body.cwd))) throw Object.assign(new Error('cwd must be an absolute path'), { code: 'invalid-plugin-registration' })
  return body
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { code: 'body-too-large' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Request body must be valid JSON'), { code: 'invalid-json' }) }
}

function publicPlugin(plugin) {
  if (typeof plugin === 'string') return { id: basename(plugin), name: basename(plugin) }
  return { id: plugin.id ?? plugin.name, name: plugin.name ?? plugin.id, ...(plugin.version === undefined ? {} : { version: plugin.version }), ...(plugin.type === undefined ? {} : { type: plugin.type }) }
}

export function createLocalApiServer({ host, registry, plugins = [], sources = [], catalog = null, now = () => Date.now() } = {}) {
  if (!host || typeof host.start !== 'function' || typeof host.status !== 'function' || typeof host.terminate !== 'function') throw new TypeError('host must provide start, status, and terminate')
  const orchestrator = new EvaluationOrchestrator({ host, now })

  const listPlugins = async () => {
    const registered = registry === undefined ? [] : await registry.list()
    return [...plugins.map(publicPlugin), ...registered.map(record => ({ id: record.id, name: record.packageName, version: record.packageVersion, sourceKind: record.sourceKind, contentHash: record.contentHash, packageManifestHash: record.packageManifestHash }))]
  }
  const resolvePluginPaths = async input => {
    if (input.pluginIds === undefined) return input.pluginPaths
    if (registry === undefined) throw Object.assign(new Error('Plugin registry is not configured'), { code: 'registry-unavailable' })
    const registered = await registry.list()
    const byId = new Map(registered.map(record => [record.id, record]))
    const records = input.pluginIds.map(id => byId.get(id))
    const paths = records.map(record => record?.installedPath)
    if (paths.some(path => path === undefined)) throw Object.assign(new Error('One or more registered plugins were not found'), { code: 'plugin-not-found' })
    return { paths, records }
  }
  const listSources = () => Array.isArray(sources) && sources.length > 0 ? sources.map(source => redactValue(source)) : catalog?.profiles?.map(profile => ({ id: profile.id, version: profile.version, repository: profile.source?.repository, ref: profile.source?.ref, profilePath: profile.source?.profilePath })) ?? []
  const route = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) return json(res, 404, { error: { code: 'not-found', message: 'Route not found' } })
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, { apiVersion: 'v1', status: 'ok' })
      if (req.method === 'GET' && path === '/status') return json(res, 200, { apiVersion: 'v1', ...orchestrator.status() })
      if (req.method === 'GET' && path === '/plugins') return json(res, 200, { plugins: await listPlugins() })
      if (req.method === 'POST' && path === '/plugins') {
        if (registry === undefined) throw Object.assign(new Error('Plugin registry is not configured'), { code: 'registry-unavailable' })
        const input = validatePluginRegistration(await readBody(req))
        const record = input.path === undefined ? await registry.installPackage(input.spec) : await registry.installLocal(input.path, { cwd: input.cwd })
        return json(res, 201, { plugin: record })
      }
      if (req.method === 'GET' && path === '/sources') return json(res, 200, { sources: listSources() })
      if (req.method === 'GET' && path === '/runs') return json(res, 200, { runs: orchestrator.listRuns() })

      const runMatch = /^\/runs\/([^/]+)$/.exec(path)
      const cancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path)
      const reportMatch = /^\/reports\/([^/]+)$/.exec(path)
      const exportMatch = /^(?:\/reports\/([^/]+)\/export|\/export\/([^/]+))$/.exec(path)
      if (req.method === 'POST' && path === '/runs') {
        const input = validateRunInput(await readBody(req))
        const resolved = await resolvePluginPaths(input)
        return json(res, 202, orchestrator.start({ ...input, pluginPaths: resolved.paths ?? resolved, ...(resolved.records === undefined ? {} : { pluginRecords: resolved.records }) }))
      }
      if (req.method === 'GET' && runMatch) {
        const run = orchestrator.getRun(runMatch[1])
        return run ? json(res, 200, run) : json(res, 404, { error: { code: 'run-not-found', message: 'Run not found' } })
      }
      if ((req.method === 'POST' || req.method === 'DELETE') && cancelMatch) {
        const run = orchestrator.getRun(cancelMatch[1])
        if (!run) return json(res, 404, { error: { code: 'run-not-found', message: 'Run not found' } })
        const result = orchestrator.cancel(cancelMatch[1])
        if (!result.accepted) return json(res, 409, { error: { code: result.code, message: result.code === 'run-not-running' ? 'Run is not running' : 'Run cannot be cancelled' } })
        return json(res, 202, result.run)
      }
      if (req.method === 'GET' && path === '/reports') return json(res, 200, { reports: orchestrator.listReports() })
      if (req.method === 'GET' && reportMatch) {
        const report = orchestrator.getReport(reportMatch[1])
        return report ? json(res, 200, report) : json(res, 404, { error: { code: 'report-not-found', message: 'Report not found' } })
      }
      if (req.method === 'GET' && exportMatch) {
        const report = orchestrator.getReport(exportMatch[1] ?? exportMatch[2])
        if (!report) return json(res, 404, { error: { code: 'report-not-found', message: 'Report not found' } })
        return json(res, 200, report, { 'content-disposition': `attachment; filename="report-${report.runId}.json"` })
      }
      return json(res, 404, { error: { code: 'not-found', message: 'Route not found' } })
    } catch (error) {
      const payload = errorPayload(error)
      return json(res, payload.status, payload.body)
    }
  }
  return createServer((req, res) => { route(req, res).catch(error => json(res, 500, { error: { code: 'internal-error', message: 'Internal server error', details: redactValue(error?.message) } })) })
}

export { MAX_BODY_BYTES }
