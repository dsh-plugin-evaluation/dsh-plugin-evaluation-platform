import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { LocalFixtureSource, SourceLoader } from '../src/catalog-loader.mjs'
import { SourceValidationError } from '../src/validation.mjs'

const projectRoot = new URL('../../', import.meta.url)
const standardsRoot = new URL('../../dsh-plugin-evaluation-standards/', import.meta.url)
const datasetRoot = new URL('../../dsh-security-evaluation-dataset/', import.meta.url)
const repository = 'https://github.com/dsh-plugin-evaluation/dsh-security-evaluation-dataset'
const ref = 'v1.1.0'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-loader-'))
  await cp(new URL('profiles/', datasetRoot), join(root, 'profiles'), { recursive: true })
  await cp(new URL('cases/', datasetRoot), join(root, 'cases'), { recursive: true })
  return root
}

async function catalogWith(source) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-'))
  const catalog = JSON.parse(await readFile(new URL('catalog.json', standardsRoot), 'utf8'))
  catalog.profiles[0].source = source
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  return { root, catalogPath: join(root, 'catalog.json') }
}

async function assertRejects(loader, message) {
  await assert.rejects(loader.load('prompt-injection-basic-v1'), error => error instanceof SourceValidationError && error.message.includes(message))
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('loads and freezes a catalog-governed offline snapshot without executing source code', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const loader = new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source: new LocalFixtureSource(root) })

  const snapshot = await loader.load('prompt-injection-basic-v1')

  assert.equal(snapshot.profile.version, '1.1.0')
  assert.equal(snapshot.cases.cases.length, 6)
  assert.equal(snapshot.provenance.ref, ref)
  assert.match(snapshot.provenance.profileSha256, /^[0-9a-f]{64}$/)
  assert.match(snapshot.provenance.casesSha256, /^[0-9a-f]{64}$/)
  assert(Object.isFrozen(snapshot))
  assert(Object.isFrozen(snapshot.cases.cases))
  assert.equal(typeof snapshot.cases.cases[0].input, 'string')
})

test('caches an immutable snapshot for a fixed source identity', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  let reads = 0
  const fixtureSource = new LocalFixtureSource(root)
  const source = { read: (...args) => { reads += 1; return fixtureSource.read(...args) } }
  const loader = new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source })
  const first = await loader.load('prompt-injection-basic-v1')
  await writeFile(join(root, 'profiles/prompt-injection-basic-v1.json'), '{"changed":true}')

  const second = await loader.load('prompt-injection-basic-v1')

  assert.strictEqual(second, first)
  assert.equal(second.profile.version, '1.1.0')
  assert.equal(reads, 2)
})

test('loads schema-valid changed content with a new immutable content identity', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalogPath = fileURLToPath(new URL('catalog.json', standardsRoot))
  const first = await new SourceLoader({ catalogPath, source: new LocalFixtureSource(root) }).load('prompt-injection-basic-v1')
  const profilePath = join(root, 'profiles/prompt-injection-basic-v1.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.name = `${profile.name} changed`
  await writeFile(profilePath, JSON.stringify(profile))

  const second = await new SourceLoader({ catalogPath, source: new LocalFixtureSource(root) }).load('prompt-injection-basic-v1')

  assert.notStrictEqual(second, first)
  assert.equal(second.profile.name, `${first.profile.name} changed`)
  assert.notEqual(second.provenance.profileSha256, first.provenance.profileSha256)
})

test('validates expected SHA-256 hashes before accepting fetched content', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const profilePath = join(root, 'profiles/prompt-injection-basic-v1.json')
  const casesPath = join(root, 'cases/prompt-injection-basic-v1.json')
  const profileText = await readFile(profilePath, 'utf8')
  const casesText = await readFile(casesPath, 'utf8')
  const hashes = {
    [`${repository}|${ref}|profiles/prompt-injection-basic-v1.json`]: sha256(profileText),
    [`${repository}|${ref}|cases/prompt-injection-basic-v1.json`]: '0'.repeat(64),
  }
  await assertRejects(new SourceLoader({
    catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)),
    source: new LocalFixtureSource(root, { expectedHashes: hashes }),
  }), 'content hash mismatch')
})

test('rejects floating refs before reading source content', async t => {
  const root = await fixture()
  const { root: catalogRoot, catalogPath } = await catalogWith({ type: 'external', repository, ref: 'main', profilePath: 'profiles/prompt-injection-basic-v1.json' })
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(catalogRoot, { recursive: true, force: true })]))
  await assertRejects(new SourceLoader({ catalogPath, source: new LocalFixtureSource(root) }), 'fixed semver/tag/SHA')
})

test('rejects non-GitHub URLs', async t => {
  const root = await fixture()
  const { root: catalogRoot, catalogPath } = await catalogWith({ type: 'external', repository: 'https://example.com/repo', ref, profilePath: 'profiles/prompt-injection-basic-v1.json' })
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(catalogRoot, { recursive: true, force: true })]))
  await assertRejects(new SourceLoader({ catalogPath, source: new LocalFixtureSource(root) }), 'GitHub HTTPS URL')
})

test('rejects invalid JSON from a source file', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'profiles/prompt-injection-basic-v1.json'), '{invalid')
  await assertRejects(new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source: new LocalFixtureSource(root) }), 'invalid JSON')
})

test('rejects profile version mismatch', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const profilePath = join(root, 'profiles/prompt-injection-basic-v1.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.version = '9.9.9'
  await writeFile(profilePath, JSON.stringify(profile))
  await assertRejects(new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source: new LocalFixtureSource(root) }), 'version must match catalog')
})

test('rejects changed content and cases path escape', async t => {
  const root = await fixture()
  const { root: catalogRoot, catalogPath } = await catalogWith({ type: 'external', repository, ref, profilePath: '../dsh-security-evaluation-dataset/profiles/prompt-injection-basic-v1.json' })
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(catalogRoot, { recursive: true, force: true })]))
  await assertRejects(new SourceLoader({ catalogPath, source: new LocalFixtureSource(root) }), 'must not escape')
})

test('rejects encoded and separator traversal before any source read', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const reads = []
  const source = {
    read(repositoryName, sourceRef, sourcePath) {
      reads.push(sourcePath)
      return new LocalFixtureSource(root).read(repositoryName, sourceRef, sourcePath)
    },
  }
  for (const profilePath of [
    '../outside.json',
    '%2e%2e/outside.json',
    '%252e%252e/outside.json',
    '..%2foutside.json',
    '%2e%2e%2foutside.json',
    'profiles%2fprompt-injection-basic-v1.json',
    'profiles/%2e%2e/outside.json',
    'profiles//prompt-injection-basic-v1.json',
    'profiles\\prompt-injection-basic-v1.json',
  ]) {
    const { root: catalogRoot, catalogPath } = await catalogWith({ type: 'external', repository, ref, profilePath })
    await assertRejects(new SourceLoader({ catalogPath, source }), 'path')
    await rm(catalogRoot, { recursive: true, force: true })
  }
  assert.deepEqual(reads, [])
})

test('rejects catalog metadata that violates the standards contract', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-contract-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const catalog = JSON.parse(await readFile(new URL('catalog.json', standardsRoot), 'utf8'))
  delete catalog.profiles[0].scenarios
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  await assertRejects(new SourceLoader({
    catalogPath: join(root, 'catalog.json'),
    source: new LocalFixtureSource(await fixture()),
  }), 'scenarios are required')
})

test('rejects profile cases path escape even when the profile itself is valid JSON', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const profilePath = join(root, 'profiles/prompt-injection-basic-v1.json')
  const profile = JSON.parse(await readFile(profilePath, 'utf8'))
  profile.casesPath = '../outside.json'
  await writeFile(profilePath, JSON.stringify(profile))
  await assertRejects(new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source: new LocalFixtureSource(root) }), 'must not escape')
})

test('rejects changed case content when its version no longer matches the profile', async t => {
  const root = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const casesPath = join(root, 'cases/prompt-injection-basic-v1.json')
  const cases = JSON.parse(await readFile(casesPath, 'utf8'))
  cases.version = '9.9.9'
  await writeFile(casesPath, JSON.stringify(cases))
  await assertRejects(new SourceLoader({ catalogPath: fileURLToPath(new URL('catalog.json', standardsRoot)), source: new LocalFixtureSource(root) }), 'version must match profile')
})
