import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { createEvaluationServer } from '../src/index.js'
import { ManagedDshHost } from '../src/managed-dsh-host.js'
import { PluginRegistry } from '../src/plugin-registry.js'

async function createRuntime() {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-phase1-runtime-'))
  const cli = resolve(root, 'apps/cli/lib/bin.js')
  const bundle = resolve(root, 'packages/bundle/headless')
  await mkdir(resolve(cli, '..'), { recursive: true })
  await mkdir(bundle, { recursive: true })
  await writeFile(resolve(bundle, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-headless', version: '1.0.0' }))
  await writeFile(cli, `import { mkdirSync, writeFileSync } from 'node:fs'
if (process.argv.includes('add')) {
  const profile = process.argv[process.argv.indexOf('--profile') + 1]
  mkdirSync(process.env.DSH_HOME + '/profiles/' + profile, { recursive: true })
  writeFileSync(process.env.DSH_HOME + '/profiles/' + profile + '/package.json', JSON.stringify({ dependencies: { 'phase1-plugin': 'link:phase1-plugin', '@deepseek-ai/dsh-headless': 'link:headless' }, dsh: { profile: { bundles: ['phase1-plugin', '@deepseek-ai/dsh-headless'] } } }))
} else {
  const prompt = process.argv.at(-1)
  if (prompt === 'hang') setInterval(() => {}, 1_000)
  else if (prompt === 'fail') { process.stderr.write('evaluation failed'); process.exit(7) }
  else process.stdout.write(JSON.stringify({ ok: true, prompt }))
}
`)
  await chmod(cli, 0o755)
  return { root, cli }
}

async function createPlugin() {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-phase1-plugin-'))
  const patch = '[]\n'
  const checksum = createHash('sha256').update(patch).digest('hex')
  await writeFile(resolve(root, 'cordis.patch.yml'), patch)
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'phase1-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml', sha256: checksum } } }))
  return root
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options)
  return { response, body: await response.json() }
}

async function waitForRun(base, runId) {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const run = await request(base, `/runs/${runId}`)
    if (['completed', 'failed', 'cancelled'].includes(run.body.status)) return run.body
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error(`run ${runId} did not finish`)
}

test('runs one registered plugin through the real HTTP Phase 1 flow', async () => {
  const runtime = await createRuntime()
  const plugin = await createPlugin()
  const registryRoot = await mkdtemp(resolve(tmpdir(), 'dsh-phase1-registry-'))
  const registry = new PluginRegistry({ root: registryRoot })
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  const server = createEvaluationServer({ host, registry })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1`
    const registered = await request(base, '/plugins', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: plugin }) })
    assert.equal(registered.response.status, 201)
    assert.equal(registered.body.plugin.packageName, 'phase1-plugin')
    assert.equal(registered.body.plugin.contentHash.length, 64)

    const started = await request(base, '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginIds: [registered.body.plugin.id], scheme: { id: 'phase1-basic', version: '1.0.0', prompt: 'scheme-case-1' }, provenance: { model: { id: 'fixture-model' } } }) })
    assert.equal(started.response.status, 202)
    const run = await waitForRun(base, started.body.runId)
    assert.equal(run.status, 'completed')
    const report = await request(base, `/reports/${started.body.runId}`)
    assert.equal(report.response.status, 200)
    assert.equal(report.body.reportSchemaVersion, 1)
    assert.equal(report.body.summary.status, 'passed')
    assert.equal(report.body.provenance.scheme.id, 'phase1-basic')
    assert.equal(report.body.provenance.plugin[0].name, 'phase1-plugin')
    assert.equal(report.body.provenance.plugin[0].contentHash.length, 64)
    assert.equal(report.body.provenance.plugin[0].registry.id, registered.body.plugin.id)
    assert.match(report.body.result.stdout, /scheme-case-1/)
    assert.equal(report.body.result.activation.names.includes('phase1-plugin'), true)
    assert.equal((await readFile(resolve(registryRoot, 'registry.json'), 'utf8')).includes(registered.body.plugin.id), true)
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise))
    await rm(runtime.root, { recursive: true, force: true })
    await rm(plugin, { recursive: true, force: true })
    await rm(registryRoot, { recursive: true, force: true })
  }
})

test('returns terminal reports for timeout, cancellation, and nonzero failure', async () => {
  const runtime = await createRuntime()
  const plugin = await createPlugin()
  const registryRoot = await mkdtemp(resolve(tmpdir(), 'dsh-phase1-registry-'))
  const registry = new PluginRegistry({ root: registryRoot })
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, timeoutMs: 5_000 })
  const record = await registry.installLocal(plugin)
  const server = createEvaluationServer({ host, registry })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/v1`
    const failed = await request(base, '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginIds: [record.id], scheme: { id: 'failure', version: '1.0.0', prompt: 'fail' } }) })
    const failedRun = await waitForRun(base, failed.body.runId)
    assert.equal(failedRun.error.code, 'nonzero-exit')
    assert.equal(failedRun.error.details.exitCode, 7)
    assert.match(failedRun.error.details.stderr, /evaluation failed/)

    const timedOut = await request(base, '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginIds: [record.id], scheme: { id: 'timeout', version: '1.0.0', prompt: 'hang' }, timeoutMs: 100 }) })
    assert.equal((await waitForRun(base, timedOut.body.runId)).error.code, 'timeout')

    const cancellable = await request(base, '/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pluginIds: [record.id], scheme: { id: 'cancel', version: '1.0.0', prompt: 'hang' }, timeoutMs: 5_000 }) })
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const status = await request(base, '/status')
      if (status.body.host.spawned === true) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    }
    const cancelled = await request(base, `/runs/${cancellable.body.runId}/cancel`, { method: 'POST' })
    assert.equal(cancelled.response.status, 202)
    assert.equal((await waitForRun(base, cancellable.body.runId)).status, 'cancelled')
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise))
    await rm(runtime.root, { recursive: true, force: true })
    await rm(plugin, { recursive: true, force: true })
    await rm(registryRoot, { recursive: true, force: true })
  }
})
