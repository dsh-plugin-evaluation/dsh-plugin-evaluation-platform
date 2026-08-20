import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const STORAGE_COLLECTIONS = Object.freeze([
  'sources',
  'snapshots',
  'plugins',
  'runs',
  'results',
  'reports',
  'cache',
])

const COLLECTIONS = new Set(STORAGE_COLLECTIONS)
const SCHEMA_VERSION = 1

export class StorageError extends Error {
  constructor(message, code = 'storage-error') {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

function assertCollection(collection) {
  if (!COLLECTIONS.has(collection)) throw new StorageError(`unsupported storage collection: ${collection}`, 'collection-invalid')
}

function assertRecordId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/') || id.includes('\\')) {
    throw new StorageError('storage record id must be a non-empty path-safe string', 'record-invalid')
  }
}

function paths(root, collection) {
  const file = resolve(root, `${collection}.json`)
  return { file, backup: `${file}.bak`, temp: `${file}.tmp` }
}

function parseEnvelope(text, path) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
  if (document.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(document.revision) || document.revision < 1) return undefined
  if (document.records === null || typeof document.records !== 'object' || Array.isArray(document.records)) return undefined
  for (const [id, record] of Object.entries(document.records)) {
    if (typeof id !== 'string' || record === undefined) return undefined
  }
  return { schemaVersion: document.schemaVersion, revision: document.revision, records: document.records, path }
}

async function readCandidate(path) {
  try {
    return parseEnvelope(await readFile(path, 'utf8'), path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function syncDirectory(root) {
  const handle = await open(root, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class JsonStorage {
  #root
  #writes = new Map()

  constructor(root) {
    this.#root = resolve(root)
  }

  async put(collection, id, record) {
    assertCollection(collection)
    assertRecordId(id)
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new StorageError('storage records must be objects', 'record-invalid')
    return this.#enqueue(collection, async () => {
      const document = await this.#recover(collection)
      const records = { ...document.records, [id]: structuredClone(record) }
      await this.#commit(collection, { schemaVersion: SCHEMA_VERSION, revision: document.revision + 1, records })
      return structuredClone(record)
    })
  }

  async get(collection, id) {
    assertCollection(collection)
    assertRecordId(id)
    const document = await this.#recover(collection)
    const record = document.records[id]
    return record === undefined ? undefined : structuredClone(record)
  }

  async list(collection) {
    assertCollection(collection)
    const document = await this.#recover(collection)
    return Object.values(document.records).map(record => structuredClone(record))
  }

  async remove(collection, id) {
    assertCollection(collection)
    assertRecordId(id)
    return this.#enqueue(collection, async () => {
      const document = await this.#recover(collection)
      if (document.records[id] === undefined) return false
      const records = { ...document.records }
      delete records[id]
      await this.#commit(collection, { schemaVersion: SCHEMA_VERSION, revision: document.revision + 1, records })
      return true
    })
  }

  #enqueue(collection, operation) {
    const previous = this.#writes.get(collection) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.#writes.set(collection, current.finally(() => {
      if (this.#writes.get(collection) === current) this.#writes.delete(collection)
    }))
    return current
  }

  async #recover(collection) {
    const { file, backup, temp } = paths(this.#root, collection)
    await mkdir(dirname(file), { recursive: true })
    const candidates = (await Promise.all([readCandidate(file), readCandidate(backup), readCandidate(temp)])).filter(Boolean)
    const document = candidates.sort((left, right) => right.revision - left.revision)[0] ?? { schemaVersion: SCHEMA_VERSION, revision: 0, records: {} }
    if (document.path !== file) await this.#commit(collection, document)
    if (document.path === file) await rm(temp, { force: true })
    return document
  }

  async #commit(collection, document) {
    const { file, backup, temp } = paths(this.#root, collection)
    const text = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision: document.revision, records: document.records }, null, 2)}\n`
    await writeFile(temp, text, 'utf8')
    const tempHandle = await open(temp, 'r')
    try {
      await tempHandle.sync()
    } finally {
      await tempHandle.close()
    }
    const current = await readCandidate(file)
    if (current) await rename(file, backup)
    await rename(temp, file)
    await syncDirectory(this.#root)
  }
}
