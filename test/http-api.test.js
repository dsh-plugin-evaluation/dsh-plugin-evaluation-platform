import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalApiServer } from '../src/index.js'

async function withServer(host, callback) {
  const server = createLocalApiServer({ host, plugins: [{ id: 'plugin-a', name: 'Plugin A', secret: 'do-not-return' }], catalog: { profiles: [{ id: 'profile-a', version: '1.0.0', source: { repository: 'https://github.com/acme/standards', ref: 'v1.0.0', profilePath: 'profiles/a.json' } }] } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await callback(`http://127.0.0.1:${server.address().port}`) } finally { await new Promise(resolve => server.close(resolve)) }
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  return { response, body: await response.json() }
}

test('serves versioned health, status, plugin, and source views without secrets', async () => {
  const host = { status: () => ({ running: false }), terminate: () => false, start: async () => ({}) }
  await withServer(host, async base => {
    const health = await request(base, '/api/v1/health')
    assert.equal(health.response.status, 200)
    assert.deepEqual(health.body, { apiVersion: 'v1', status: 'ok' })
    const plugins = await request(base, '/api/v1/plugins')
    assert.deepEqual(plugins.body.plugins, [{ id: 'plugin-a', name: 'Plugin A' }])
    const sources = await request(base, '/api/v1/sources')
    assert.equal(sources.body.sources[0].repository, 'https://github.com/acme/standards')
    assert.equal((await request(base, '/api/v1/status')).body.host.running, false)
  })
})

test('validates run input and redacts completed report/export output', async () => {
  const host = { status: () => ({ running: false }), terminate: () => false, start: async input => ({ runId: 'host-run', stdout: `token: secret-value for ${input.prompt}`, stderr: '' }) }
  await withServer(host, async base => {
    const invalid = await request(base, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginPaths: ['relative'], prompt: 'x' }) })
    assert.equal(invalid.response.status, 400)
    assert.equal(invalid.body.error.code, 'invalid-plugin-paths')
    const created = await request(base, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginPaths: ['/tmp/plugin'], prompt: 'hello' }) })
    assert.equal(created.response.status, 202)
    let run
    for (let attempt = 0; attempt < 20; attempt += 1) {
      run = await request(base, `/api/v1/runs/${created.body.runId}`)
      if (run.body.status === 'completed') break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.equal(run.body.status, 'completed')
    assert.doesNotMatch(JSON.stringify(run.body), /secret-value/)
    const report = await request(base, `/api/v1/reports/${created.body.runId}`)
    assert.equal(report.response.status, 200)
    assert.doesNotMatch(JSON.stringify(report.body), /secret-value/)
    const exported = await request(base, `/api/v1/reports/${created.body.runId}/export`)
    assert.equal(exported.response.headers.get('content-disposition'), `attachment; filename="report-${created.body.runId}.json"`)
    assert.doesNotMatch(JSON.stringify(exported.body), /secret-value/)
  })
})

test('supports cancellation and rejects unknown routes', async () => {
  let terminateCalls = 0
  const host = { status: () => ({ running: true }), terminate: () => { terminateCalls += 1; return true }, start: () => new Promise(() => {}) }
  await withServer(host, async base => {
    const created = await request(base, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginPaths: ['/tmp/plugin'], prompt: 'hang' }) })
    const cancelled = await request(base, `/api/v1/runs/${created.body.runId}/cancel`, { method: 'POST' })
    assert.equal(cancelled.response.status, 202)
    assert.equal(terminateCalls, 1)
    const missing = await request(base, '/api/v1/nope')
    assert.equal(missing.response.status, 404)
  })
})

test('rejects malformed and oversized JSON bodies before starting a run', async () => {
  const host = { status: () => ({ running: false }), terminate: () => false, start: async () => ({}) }
  await withServer(host, async base => {
    const malformed = await request(base, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    assert.equal(malformed.response.status, 400)
    assert.equal(malformed.body.error.code, 'invalid-json')
    const oversized = await request(base, '/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x'.repeat(65 * 1024) }) })
    assert.equal(oversized.response.status, 400)
    assert.equal(oversized.body.error.code, 'body-too-large')
  })
})
