import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { PluginRegistry, PluginRegistryError, discoverLocalPlugin, discoverPackagePlugin, parsePackageSpec } from '../src/index.js'

async function localFixture(name = 'safe-plugin') {
  const root = await mkdtemp(join(tmpdir(), 'plugin-source-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
  await writeFile(join(root, 'README.md'), 'plugin data\n')
  return root
}

test('discovers an explicit local plugin and hashes only data', async t => {
  const root = await localFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  const discovered = await discoverLocalPlugin(root)

  assert.equal(discovered.kind, 'local')
  assert.equal(discovered.name, 'safe-plugin')
  assert.equal(discovered.version, '1.2.3')
  assert.match(discovered.contentHash, /^[0-9a-f]{64}$/u)
  assert.match(discovered.manifestHash, /^[0-9a-f]{64}$/u)
})

test('requires an explicit cwd for relative local discovery and rejects escapes', async t => {
  const root = await localFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(discoverLocalPlugin('plugin'), error => error instanceof PluginRegistryError && error.code === 'invalid-path')
  await assert.rejects(discoverLocalPlugin('../plugin', { cwd: resolve(root, 'nested') }), error => error instanceof PluginRegistryError && error.code === 'invalid-path')
  await assert.rejects(discoverLocalPlugin('%2e%2e/plugin', { cwd: root }), error => error instanceof PluginRegistryError && error.code === 'invalid-path')
})

test('rejects symlink escape and malformed local metadata', async t => {
  const root = await localFixture()
  const outside = await mkdtemp(join(tmpdir(), 'plugin-outside-'))
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]))
  await symlink(outside, join(root, 'linked'))
  await assert.rejects(discoverLocalPlugin(root), error => error instanceof PluginRegistryError && error.code === 'symlink-escape')
  await rm(join(root, 'linked'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '../escape', version: '1.2.3' }))
  await assert.rejects(discoverLocalPlugin(root), error => error instanceof PluginRegistryError && error.code === 'invalid-manifest')
})

test('parses only safe npm names with exact versions or dist tags', () => {
  assert.deepEqual(parsePackageSpec('@scope/plugin@1.2.3'), { name: '@scope/plugin', selector: '1.2.3', spec: '@scope/plugin@1.2.3' })
  assert.deepEqual(parsePackageSpec('plugin@latest'), { name: 'plugin', selector: 'latest', spec: 'plugin@latest' })
  assert.equal(discoverPackagePlugin('plugin').canonicalSource, 'plugin')
  for (const spec of ['--ignore-scripts', 'https://example.test/plugin', 'git+https://example.test/plugin.git', 'file:./plugin', 'link:plugin', 'workspace:*', '../plugin', 'plugin@^1.2.3', 'plugin name', 'plugin/%2e%2e']) {
    assert.throws(() => parsePackageSpec(spec), error => error instanceof PluginRegistryError && error.code === 'invalid-package-spec')
  }
})

test('installs local and package plugins in an isolated registry with stable provenance', async t => {
  const source = await localFixture('local-plugin')
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-'))
  const external = await mkdtemp(join(tmpdir(), 'plugin-external-'))
  const calls = []
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(root, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]))
  const registry = new PluginRegistry({ root, now: () => new Date('2026-01-02T03:04:05.000Z'), packageManagerRunner: async ({ argv, cwd, env }) => {
    calls.push({ argv, cwd, env })
    const prefix = argv[argv.indexOf('--prefix') + 1]
    const packageRoot = join(prefix, 'node_modules', 'remote-plugin')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'remote-plugin', version: '2.0.0' }))
  } })

  const local = await registry.installLocal(source)
  const remote = await registry.installPackage('remote-plugin@2.0.0')
  const records = await registry.list()

  assert.equal(records.length, 2)
  assert.deepEqual(records.map(record => record.id), [...records].sort((left, right) => left.id.localeCompare(right.id)).map(record => record.id))
  assert.equal((await registry.provenance(local.id)).installedAt, '2026-01-02T03:04:05.000Z')
  assert.equal((await registry.provenance(remote.id)).packageName, 'remote-plugin')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].argv, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', calls[0].argv[5], 'remote-plugin@2.0.0'])
  assert.equal(calls[0].env.PATH, process.env.PATH)
  assert.equal(resolve(local.installedPath).startsWith(resolve(root)), true)
  assert.equal(resolve(remote.installedPath).startsWith(resolve(root)), true)
  assert.equal(await readFile(join(local.installedPath, 'package.json'), 'utf8'), await readFile(join(source, 'package.json'), 'utf8'))
  assert.equal((await lstat(external)).isDirectory(), true)
})

test('returns the existing local registration on retry', async t => {
  const source = await localFixture('retry-plugin')
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-retry-'))
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]))
  const registry = new PluginRegistry({ root })
  const first = await registry.installLocal(source)
  const second = await registry.installLocal(source)
  assert.deepEqual(second, first)
})

test('removes only installed safe IDs and persists an atomic manifest', async t => {
  const source = await localFixture()
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-remove-'))
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]))
  const registry = new PluginRegistry({ root })
  const installed = await registry.installLocal(source)

  await assert.rejects(registry.remove('../outside'), error => error instanceof PluginRegistryError && error.code === 'invalid-plugin-id')
  await assert.rejects(registry.remove('missing-0000000000000000'), error => error instanceof PluginRegistryError && error.code === 'plugin-missing')
  await registry.remove(installed.id)

  assert.deepEqual(await registry.list(), [])
  const manifest = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.deepEqual(manifest.records, {})
})

test('does not execute package or plugin contents during discovery and listing', async t => {
  const source = await localFixture('no-execute')
  const marker = join(source, 'executed')
  await writeFile(join(source, 'run.mjs'), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'executed')`)
  const root = await mkdtemp(join(tmpdir(), 'plugin-registry-data-'))
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]))
  const registry = new PluginRegistry({ root })

  await registry.installLocal(source)
  await registry.list()

  await assert.rejects(readFile(marker, 'utf8'))
  assert.equal(createHash('sha256').update('stable').digest('hex').length, 64)
})
