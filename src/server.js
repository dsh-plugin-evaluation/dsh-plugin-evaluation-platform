import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createLocalApiServer } from './http-api.js'
import { ManagedDshHost } from './managed-dsh-host.js'
import { PluginRegistry } from './plugin-registry.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_PATH = resolve(ROOT, 'public/index.html')
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000

export function createFixtureHost() {
  return {
    status: () => ({ running: false, mode: 'fixture' }),
    terminate: () => false,
    start: async () => { throw Object.assign(new Error('Fixture host does not execute evaluations'), { code: 'fixture-host-disabled' }) },
  }
}

export function createConfiguredHost(env = process.env) {
  if (typeof env.PLATFORM_DSH_ROOT !== 'string' || env.PLATFORM_DSH_ROOT.length === 0) return createFixtureHost()
  return new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: env.PLATFORM_DSH_ROOT } } })
}

export function createConfiguredRegistry(env = process.env) {
  const root = env.DSH_EVALUATION_REGISTRY_ROOT ?? resolve(env.DSH_EVALUATION_DATA_ROOT ?? resolve(homedir(), '.dsh-evaluation'), 'registry')
  return new PluginRegistry({ root })
}

export function createEvaluationServer({ host = createConfiguredHost(), registry = createConfiguredRegistry(), plugins = [], sources = [], catalog = null, indexPath = INDEX_PATH } = {}) {
  const apiServer = createLocalApiServer({ host, registry, plugins, sources, catalog })
  const indexPromise = readFile(indexPath)
  return createHttpServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && requestUrl.pathname === '/') {
      const index = await indexPromise
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(index)
      return
    }
    if (req.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (requestUrl.pathname.startsWith('/api/v1')) {
      apiServer.emit('request', req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: { code: 'not-found', message: 'Route not found' } }))
  })
}

export async function startServer({ port = Number(process.env.PORT ?? DEFAULT_PORT), host = process.env.HOST ?? DEFAULT_HOST, ...options } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('port must be an integer from 0 to 65535')
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost' && process.env.DSH_EVALUATION_ALLOW_INSECURE_NETWORK !== '1') throw new Error('Refusing non-loopback host without DSH_EVALUATION_ALLOW_INSECURE_NETWORK=1')
  const server = createEvaluationServer(options)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolvePromise)
  })
  return server
}

export { DEFAULT_HOST, DEFAULT_PORT, INDEX_PATH }
