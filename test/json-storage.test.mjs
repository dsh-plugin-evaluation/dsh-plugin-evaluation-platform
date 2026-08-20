import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStorage, STORAGE_COLLECTIONS } from '../src/json-storage.mjs'

async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-'))
  return { root, storage: new JsonStorage(root) }
}

test('persists every supported collection in a versioned JSON envelope', async t => {
  const { root, storage } = await storageFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const records = Object.fromEntries(STORAGE_COLLECTIONS.map(collection => [collection, { id: collection, value: 1 }]))

  for (const [collection, record] of Object.entries(records)) await storage.put(collection, record.id, record)

  for (const collection of STORAGE_COLLECTIONS) {
    const loaded = await storage.get(collection, collection)
    assert.deepEqual(loaded, records[collection])
    const document = JSON.parse(await readFile(join(root, `${collection}.json`), 'utf8'))
    assert.equal(document.schemaVersion, 1)
    assert.equal(document.revision, 1)
    assert.deepEqual(document.records[collection], records[collection])
  }
})

test('writes complete documents atomically and leaves no temporary files', async t => {
  const { root, storage } = await storageFixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  await storage.put('runs', 'run-1', { id: 'run-1', status: 'running' })
  await storage.put('runs', 'run-1', { id: 'run-1', status: 'complete' })

  assert.deepEqual(await storage.get('runs', 'run-1'), { id: 'run-1', status: 'complete' })
  assert.deepEqual((await readdir(root)).sort(), ['runs.json', 'runs.json.bak'])
  assert.match(await readFile(join(root, 'runs.json'), 'utf8'), /^\{[\s\S]*\}\n$/)
})

test('recovers the newest valid interrupted temporary document', async t => {
  const { root, storage } = await storageFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await storage.put('reports', 'report-1', { id: 'report-1', status: 'old' })
  const interrupted = JSON.stringify({ schemaVersion: 1, revision: 2, records: { 'report-1': { id: 'report-1', status: 'new' } } })
  await writeFile(join(root, 'reports.json.tmp'), `${interrupted}\n`)

  assert.deepEqual(await storage.get('reports', 'report-1'), { id: 'report-1', status: 'new' })
  assert.deepEqual((await readdir(root)).sort(), ['reports.json', 'reports.json.bak'])
})

test('falls back to the valid backup when the current document is corrupt', async t => {
  const { root, storage } = await storageFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await storage.put('cache', 'cache-1', { id: 'cache-1', value: 'stable' })
  await storage.put('cache', 'cache-1', { id: 'cache-1', value: 'latest' })
  await writeFile(join(root, 'cache.json'), '{broken')

  assert.deepEqual(await storage.get('cache', 'cache-1'), { id: 'cache-1', value: 'stable' })
})

test('lists records without exposing the storage envelope', async t => {
  const { root, storage } = await storageFixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  await storage.put('plugins', 'a', { id: 'a', name: 'first' })
  await storage.put('plugins', 'b', { id: 'b', name: 'second' })

  assert.deepEqual(await storage.list('plugins'), [{ id: 'a', name: 'first' }, { id: 'b', name: 'second' }])
})
