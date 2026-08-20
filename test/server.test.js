import assert from 'node:assert/strict'
import test from 'node:test'
import { createEvaluationServer, startServer } from '../src/server.js'

async function close(server) {
  if (server.listening) await new Promise(resolve => server.close(resolve))
}

test('startup server serves the dependency-free page and health endpoint', async () => {
  const server = await startServer({ port: 0 })
  try {
    const port = server.address().port
    const page = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /DSH Evaluation API/)
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { apiVersion: 'v1', status: 'ok' })
    const status = await fetch(`http://127.0.0.1:${port}/api/v1/status`)
    assert.deepEqual((await status.json()).host, { running: false, mode: 'fixture' })
  } finally {
    await close(server)
  }
})

test('startup server does not execute fixture evaluations', async () => {
  const server = createEvaluationServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginPaths: ['/tmp/plugin'], prompt: 'do not run' }) })
    assert.equal(response.status, 202)
    const runId = (await response.json()).runId
    await new Promise(resolve => setTimeout(resolve, 1))
    const run = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/runs/${runId}`)
    assert.equal((await run.json()).status, 'failed')
  } finally {
    await close(server)
  }
})

test('rejects non-loopback binds unless explicitly enabled', async () => {
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0 }), /non-loopback/)
})
