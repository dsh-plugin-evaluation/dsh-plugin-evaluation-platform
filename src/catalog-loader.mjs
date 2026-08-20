import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeRelativePath, deepFreeze, SourceValidationError, validateCases, validateCatalog, validateProfile } from './validation.mjs'

const DEFAULT_TIMEOUT_MS = 10_000

export class SourceFetchError extends Error {
  name = 'SourceFetchError'
}

function repositoryParts(repository) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/.exec(repository)
  if (!match) throw new SourceValidationError(`unsupported GitHub repository URL: ${repository}`)
  return { owner: match[1], name: match[2] }
}

function assertWithin(root, target) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const pathFromRoot = relative(rootPath, targetPath)
  if (pathFromRoot.startsWith('..') || pathFromRoot.includes('..' + '/')) throw new SourceFetchError('source path escapes fixture root')
}

export class LocalFixtureSource {
  constructor(root, { expectedHashes = {} } = {}) {
    this.root = resolve(root)
    this.expectedHashes = expectedHashes
  }

  expectedHash(repository, ref, sourcePath) {
    return this.expectedHashes[`${repository}|${ref}|${sourcePath}`]
  }

  async read(repository, ref, sourcePath) {
    repositoryParts(repository)
    assertSafeRelativePath(sourcePath, 'source')
    const target = resolve(this.root, sourcePath)
    assertWithin(this.root, target)
    try {
      return await readFile(target, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new SourceFetchError(`fixture source is missing at ${ref}/${sourcePath}`)
      throw error
    }
  }
}

export class GithubSource {
  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs
  }

  async read(repository, ref, sourcePath) {
    const { owner, name } = repositoryParts(repository)
    assertSafeRelativePath(sourcePath, 'source')
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${encodeURIComponent(ref)}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`
    const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!response.ok) throw new SourceFetchError(`GitHub source request failed with HTTP ${response.status}`)
    return response.text()
  }
}

function parseJson(text, path) {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new SourceValidationError(`invalid JSON at ${path}`)
    throw error
  }
}

function contentHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function expectedHash(source, repository, ref, sourcePath) {
  if (typeof source.expectedHash !== 'function') return undefined
  const hash = source.expectedHash(repository, ref, sourcePath)
  if (hash === undefined) return undefined
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new SourceValidationError(`expected hash for ${sourcePath} must be a lowercase SHA-256 digest`)
  return hash
}

function assertFetchedText(text, sourcePath) {
  if (typeof text !== 'string') throw new SourceFetchError(`source adapter returned non-text content for ${sourcePath}`)
  return text
}

export class SourceLoader {
  constructor({ catalogPath, source, cache = new Map() }) {
    this.catalogPath = resolve(catalogPath)
    this.source = source
    this.cache = cache
  }

  async load(profileId) {
    const catalog = parseJson(await readFile(this.catalogPath, 'utf8'), this.catalogPath)
    validateCatalog(catalog)
    const entry = catalog.profiles.find(profile => profile.id === profileId)
    if (!entry) throw new SourceValidationError(`catalog profile ${profileId} was not found`)
    const sourceIdentity = [entry.id, entry.version, entry.source.repository, entry.source.ref, entry.source.profilePath].join('|')

    const profileText = assertFetchedText(await this.source.read(entry.source.repository, entry.source.ref, entry.source.profilePath), entry.source.profilePath)
    const profileHash = contentHash(profileText)
    const expectedProfileHash = expectedHash(this.source, entry.source.repository, entry.source.ref, entry.source.profilePath)
    if (expectedProfileHash && expectedProfileHash !== profileHash) throw new SourceValidationError(`content hash mismatch for ${entry.source.profilePath}`)
    const profile = validateProfile(parseJson(profileText, entry.source.profilePath), entry)
    const casesText = assertFetchedText(await this.source.read(entry.source.repository, entry.source.ref, profile.casesPath), profile.casesPath)
    const casesHash = contentHash(casesText)
    const expectedCasesHash = expectedHash(this.source, entry.source.repository, entry.source.ref, profile.casesPath)
    if (expectedCasesHash && expectedCasesHash !== casesHash) throw new SourceValidationError(`content hash mismatch for ${profile.casesPath}`)
    const cases = validateCases(parseJson(casesText, profile.casesPath), profile, entry)
    const cacheIdentity = `${sourceIdentity}|${profileHash}|${casesHash}`
    const cached = this.cache.get(cacheIdentity)
    if (cached) return cached
    const snapshot = deepFreeze({
      catalogEntry: structuredClone(entry),
      profile: structuredClone(profile),
      cases: structuredClone(cases),
      provenance: Object.freeze({
        repository: entry.source.repository,
        ref: entry.source.ref,
        profilePath: entry.source.profilePath,
        casesPath: profile.casesPath,
        profileSha256: profileHash,
        casesSha256: casesHash,
        cacheIdentity,
      }),
    })
    this.cache.set(cacheIdentity, snapshot)
    return snapshot
  }
}

export function standardsCatalogPath(projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dsh-plugin-evaluation-standards')) {
  return resolve(projectRoot, 'catalog.json')
}
