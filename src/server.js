import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalApiServer } from './http-api.js'

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

export function createEvaluationServer({ host = createFixtureHost(), plugins = [], sources = [], catalog = null, indexPath = INDEX_PATH } = {}) {
  const apiServer = createLocalApiServer({ host, plugins, sources, catalog })
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
  const server = createEvaluationServer(options)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolvePromise)
  })
  return server
}

export { DEFAULT_HOST, DEFAULT_PORT, INDEX_PATH }
