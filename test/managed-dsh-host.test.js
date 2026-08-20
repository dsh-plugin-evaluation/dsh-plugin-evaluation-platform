import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { DshHostBusyError, DshRunError, ManagedDshHost, redact } from '../src/index.js'

async function fixture(script, { includeBundle = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-host-test-'))
  const cli = resolve(root, 'apps/cli/lib/bin.js')
  const bundle = resolve(root, 'packages/bundle/headless')
  await mkdir(resolve(cli, '..'), { recursive: true })
  if (includeBundle) await mkdir(bundle, { recursive: true })
  if (includeBundle) await writeFile(resolve(bundle, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-headless' }))
  const setup = `import { mkdirSync, writeFileSync } from 'node:fs'; if (process.argv.includes('add')) { mkdirSync(process.env.DSH_HOME + '/profiles/' + process.argv[process.argv.indexOf('--profile') + 1], { recursive: true }); writeFileSync(process.env.DSH_HOME + '/profiles/' + process.argv[process.argv.indexOf('--profile') + 1] + '/package.json', JSON.stringify({ dependencies: { 'test-plugin': 'link:test-plugin', '@deepseek-ai/dsh-headless': 'link:headless' }, dsh: { profile: { bundles: ['test-plugin', '@deepseek-ai/dsh-headless'] } } })); }\n`
  await writeFile(cli, setup + script)
  await chmod(cli, 0o755)
  return { root, cli, bundle }
}

async function pluginFixture({ bundle = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'dsh-plugin-test-'))
  await writeFile(resolve(root, 'package.json'), JSON.stringify({
    name: 'test-plugin',
    version: '1.2.3',
    ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  }))
  if (bundle) await writeFile(resolve(root, 'cordis.patch.yml'), '[]\n')
  if (bundle) {
    const checksum = createHash('sha256').update('[]\n').digest('hex')
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'test-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml', sha256: checksum } } }))
  }
  return root
}

test('rejects missing runtime', async () => {
  const plugin = await pluginFixture()
  await assert.rejects(new ManagedDshHost({ runtime: { declarationPath: '/missing/runtime.json' } }).start({ pluginPaths: [plugin], prompt: 'hello' }), error => error.code === 'runtime-missing')
  await rm(plugin, { recursive: true, force: true })
})

test('reports install exit 7 and cleans private data', async () => {
  const runtime = await fixture('process.exit(process.argv.includes("add") ? 7 : 0)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), error => error instanceof DshRunError && error.code === 'nonzero-exit' && error.details.exitCode === 7)
  assert.equal(host.status().running, false)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('rejects a plain plugin without a dsh bundle declaration', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture({ bundle: false })
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), error => error instanceof DshRunError && error.code === 'plugin-not-bundle')
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('uses a private DSH_HOME and workspace and cleans them after success', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); process.stdout.write(JSON.stringify({ home: process.env.DSH_HOME, cwd: process.cwd() }))')
  const plugin = await pluginFixture()
  const personalHome = process.env.DSH_HOME
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  const result = await host.start({ pluginPaths: [plugin], prompt: 'hello' })
  const isolation = JSON.parse(result.stdout)
  assert.notEqual(isolation.home, personalHome)
  assert.match(isolation.home, /dsh-home/)
  assert.match(isolation.cwd, /workspace/)
  assert.equal(typeof result.durationMs, 'number')
  assert.equal(result.provenance.plugin[0].version, '1.2.3')
  assert.equal(result.provenance.plugin[0].contentHash.length, 64)
  assert.equal(result.provenance.plugin[0].manifestHash.length, 64)
  assert.equal(host.status().running, false)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('overrides an inherited DSH_HOME without mutating the parent environment', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); process.stdout.write(process.env.DSH_HOME)')
  const plugin = await pluginFixture()
  const inherited = process.env.DSH_HOME
  process.env.DSH_HOME = '/private/personal-dsh-home'
  try {
    const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
    const result = await host.start({ pluginPaths: [plugin], prompt: 'hello' })
    assert.notEqual(result.stdout, '/private/personal-dsh-home')
    assert.match(result.stdout, /dsh-home/)
    assert.equal(process.env.DSH_HOME, '/private/personal-dsh-home')
  } finally {
    if (inherited === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = inherited
    await rm(runtime.root, { recursive: true, force: true })
    await rm(plugin, { recursive: true, force: true })
  }
})

test('rejects concurrent starts under single-run policy', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); setTimeout(() => process.exit(0), 100)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  const first = host.start({ pluginPaths: [plugin], prompt: 'hello' })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'again' }), DshHostBusyError)
  await first
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('times out and terminates a hanging child', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); setInterval(() => {}, 1000)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, timeoutMs: 200 })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hang' }), error => error instanceof DshRunError && error.code === 'timeout' && error.details.terminated === true)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('supports explicit termination and redacts secrets in output', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); process.stdout.write("api-key=secret-value"); setInterval(() => {}, 1000)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, timeoutMs: 500 })
  const run = host.start({ pluginPaths: [plugin], prompt: 'hang' })
  while (!host.status().spawned) await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
  assert.equal(host.terminate(), true)
  await assert.rejects(run, error => error instanceof DshRunError && (error.code === 'terminated' || error.code === 'timeout') && !String(error.details.stdout).includes('secret-value'))
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('uses an environment runtime without requiring a declaration file', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { declarationPath: '/missing/runtime.json', env: { PLATFORM_DSH_ROOT: runtime.root } } })
  const result = await host.start({ pluginPaths: [plugin], prompt: 'hello' })
  assert.equal(result.exitCode, 0)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('reports immediate termination as not accepted before child spawn', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  let release
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, runtimeResolver: async options => { await new Promise(resolvePromise => { release = resolvePromise }); return { root: runtime.root, cli: runtime.cli, headlessBundle: runtime.bundle } } })
  const run = host.start({ pluginPaths: [plugin], prompt: 'hello' })
  assert.equal(host.terminate(), false)
  while (release === undefined) await new Promise(resolvePromise => setTimeout(resolvePromise, 1))
  release()
  await run
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('redacts JSON, whitespace, and Authorization credential variants', () => {
  const value = redact('{"api_key" : "json-secret", "token": "token-secret", Authorization : "Bearer bearer-secret", Authorization:Bearer compact-secret, password = plain-secret}')
  assert.doesNotMatch(value, /json-secret|token-secret|bearer-secret|compact-secret|plain-secret/)
  assert.match(value, /\[REDACTED\]/)
})

test('TERM-trapping child escalates to SIGKILL within the bound', async () => {
  const runtime = await fixture('if (process.argv.includes("add")) process.exit(0); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, timeoutMs: 100, terminateGraceMs: 50 })
  const started = Date.now()
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hang' }), error => error instanceof DshRunError && error.code === 'timeout')
  assert.ok(Date.now() - started < 2_000)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('runtime declaration can provide a packaged root', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  const declaration = resolve(runtime.root, 'runtime.json')
  await writeFile(declaration, JSON.stringify({ root: runtime.root }))
  const host = new ManagedDshHost({ runtime: { declarationPath: declaration, env: {} } })
  const result = await host.start({ pluginPaths: [plugin], prompt: 'hello' })
  assert.equal(result.exitCode, 0)
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('rejects a bundle when its patch checksum changes', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  await writeFile(resolve(plugin, 'cordis.patch.yml'), '[tampered]\n')
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), error => error instanceof DshRunError && error.code === 'plugin-checksum-mismatch')
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('rejects a bundle patch outside the plugin root', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  await writeFile(resolve(plugin, 'package.json'), JSON.stringify({ name: 'test-plugin', dsh: { bundle: { patch: '../outside.patch', sha256: createHash('sha256').update('outside').digest('hex') } } }))
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), error => error instanceof DshRunError && error.code === 'plugin-invalid')
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})

test('removes signal handlers after a pre-spawn failure', async () => {
  const plugin = await pluginFixture()
  const before = process.listenerCount('SIGTERM')
  const host = new ManagedDshHost({ runtimeResolver: async () => { throw new Error('resolver failed') } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), /resolver failed/)
  assert.equal(process.listenerCount('SIGTERM'), before)
  await rm(plugin, { recursive: true, force: true })
})

test('classifies a synchronous spawn failure as spawn-failed', async () => {
  const runtime = await fixture('process.exit(0)')
  const plugin = await pluginFixture()
  const host = new ManagedDshHost({ runtime: { env: { PLATFORM_DSH_ROOT: runtime.root } }, spawnProcess: () => { throw new Error('sync spawn boom') } })
  await assert.rejects(host.start({ pluginPaths: [plugin], prompt: 'hello' }), error => error instanceof DshRunError && error.code === 'spawn-failed')
  await rm(runtime.root, { recursive: true, force: true })
  await rm(plugin, { recursive: true, force: true })
})
