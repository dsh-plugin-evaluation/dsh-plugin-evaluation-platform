import { createServer } from 'node:http'
import { basename, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { redact } from './managed-dsh-host.js'

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
  const allowed = ['pluginPaths', 'prompt', 'timeoutMs']
  if (Object.keys(body).some(key => !allowed.includes(key))) throw Object.assign(new Error('Request body contains unsupported fields'), { code: 'invalid-body' })
  if (!Array.isArray(body.pluginPaths) || body.pluginPaths.length === 0 || body.pluginPaths.length > MAX_PLUGIN_PATHS) throw Object.assign(new Error('pluginPaths must contain 1 to 32 paths'), { code: 'invalid-plugin-paths' })
  if (body.pluginPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))) throw Object.assign(new Error('pluginPaths must be absolute local paths'), { code: 'invalid-plugin-paths' })
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '' || body.prompt.length > MAX_PROMPT_LENGTH) throw Object.assign(new Error('prompt is required and must be at most 32768 characters'), { code: 'invalid-prompt' })
  if (body.timeoutMs !== undefined && (!Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > 600_000)) throw Object.assign(new Error('timeoutMs must be an integer from 1 to 600000'), { code: 'invalid-timeout' })
  return { pluginPaths: [...body.pluginPaths], prompt: body.prompt, ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }) }
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

export function createLocalApiServer({ host, plugins = [], sources = [], catalog = null, now = () => Date.now() } = {}) {
  if (!host || typeof host.start !== 'function' || typeof host.status !== 'function' || typeof host.terminate !== 'function') throw new TypeError('host must provide start, status, and terminate')
  const runs = new Map()
  const reports = new Map()

  const listSources = () => Array.isArray(sources) && sources.length > 0 ? sources.map(source => redactValue(source)) : catalog?.profiles?.map(profile => ({ id: profile.id, version: profile.version, repository: profile.source?.repository, ref: profile.source?.ref, profilePath: profile.source?.profilePath })) ?? []
  const route = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) return json(res, 404, { error: { code: 'not-found', message: 'Route not found' } })
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, { apiVersion: 'v1', status: 'ok' })
      if (req.method === 'GET' && path === '/status') return json(res, 200, { apiVersion: 'v1', host: host.status(), runs: runs.size, reports: reports.size })
      if (req.method === 'GET' && path === '/plugins') return json(res, 200, { plugins: plugins.map(publicPlugin) })
      if (req.method === 'GET' && path === '/sources') return json(res, 200, { sources: listSources() })
      if (req.method === 'GET' && path === '/runs') return json(res, 200, { runs: [...runs.values()].map(run => redactValue(run)) })

      const runMatch = /^\/runs\/([^/]+)$/.exec(path)
      const cancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path)
      const reportMatch = /^\/reports\/([^/]+)$/.exec(path)
      const exportMatch = /^(?:\/reports\/([^/]+)\/export|\/export\/([^/]+))$/.exec(path)
      if (req.method === 'POST' && path === '/runs') {
        const input = validateRunInput(await readBody(req))
        const runId = randomUUID()
        const run = { runId, status: 'running', startedAt: now() }
        runs.set(runId, run)
        Promise.resolve().then(() => host.start(input)).then(result => {
          const completed = { ...run, status: 'completed', finishedAt: now(), result: redactValue(result) }
          runs.set(runId, completed)
          reports.set(runId, { reportId: runId, runId, createdAt: completed.finishedAt, status: completed.status, result: completed.result })
        }).catch(error => {
          const failure = { ...run, status: error?.code === 'terminated' ? 'cancelled' : 'failed', finishedAt: now(), error: errorPayload(error).body.error }
          runs.set(runId, failure)
          reports.set(runId, { reportId: runId, runId, createdAt: failure.finishedAt, status: failure.status, error: failure.error })
        })
        return json(res, 202, run)
      }
      if (req.method === 'GET' && runMatch) {
        const run = runs.get(runMatch[1])
        return run ? json(res, 200, run) : json(res, 404, { error: { code: 'run-not-found', message: 'Run not found' } })
      }
      if ((req.method === 'POST' || req.method === 'DELETE') && cancelMatch) {
        const run = runs.get(cancelMatch[1])
        if (!run) return json(res, 404, { error: { code: 'run-not-found', message: 'Run not found' } })
        if (run.status !== 'running') return json(res, 409, { error: { code: 'run-not-running', message: 'Run is not running' } })
        if (!host.terminate()) return json(res, 409, { error: { code: 'run-not-cancellable', message: 'Run cannot be cancelled before process start' } })
        run.status = 'cancelling'
        return json(res, 202, run)
      }
      if (req.method === 'GET' && path === '/reports') return json(res, 200, { reports: [...reports.values()].map(report => redactValue(report)) })
      if (req.method === 'GET' && reportMatch) {
        const report = reports.get(reportMatch[1])
        return report ? json(res, 200, report) : json(res, 404, { error: { code: 'report-not-found', message: 'Report not found' } })
      }
      if (req.method === 'GET' && exportMatch) {
        const report = reports.get(exportMatch[1] ?? exportMatch[2])
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
