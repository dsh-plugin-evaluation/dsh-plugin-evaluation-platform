import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'

const SCHEMA_VERSION = 1
const PACKAGE_NAME = /^(?:@([a-z0-9][a-z0-9._~-]*)\/)?([a-z0-9][a-z0-9._~-]*)$/u
const VERSION = /^\d+\.\d+\.\d+$/u
const DIST_TAG = /^[a-z0-9][a-z0-9._-]*$/u
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*-[0-9a-f]{16}$/u
const MANIFEST = 'registry.json'

export class PluginRegistryError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'PluginRegistryError'
    this.code = code
    this.details = details
  }
}

function fail(message, code, details) {
  throw new PluginRegistryError(message, code, details)
}

function containsUnsafePath(value) {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) return true
  let decoded = value
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let next
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return true
    }
    if (next === decoded) break
    decoded = next
  }
  return decoded.includes('\\') || decoded.split(/[\\/]/u).includes('..') || decoded.includes('//') || decoded.includes('\0')
}

function assertInside(root, target) {
  const pathFromRoot = relative(resolve(root), resolve(target))
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) fail('path escapes registry root', 'path-escape')
}

function parsePackageName(name) {
  const match = PACKAGE_NAME.exec(name)
  if (!match || containsUnsafePath(name)) fail(`invalid package name: ${name}`, 'invalid-package-name')
  return name
}

export function parsePackageSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() !== spec || spec.length === 0) fail('package spec is required', 'invalid-package-spec')
  if (containsUnsafePath(spec) || spec.startsWith('-') || /^(?:https?:|git:|git\+|file:|link:|workspace:|\.\.?[/\\])/iu.test(spec)) fail(`unsupported package spec: ${spec}`, 'invalid-package-spec')
  let name
  let selector
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash < 0) fail(`invalid package spec: ${spec}`, 'invalid-package-spec')
    const at = spec.indexOf('@', slash)
    name = at < 0 ? spec : spec.slice(0, at)
    selector = at < 0 ? undefined : spec.slice(at + 1)
  } else {
    const at = spec.indexOf('@')
    name = at < 0 ? spec : spec.slice(0, at)
    selector = at < 0 ? undefined : spec.slice(at + 1)
  }
  if (!PACKAGE_NAME.test(name)) fail(`invalid package spec: ${spec}`, 'invalid-package-spec')
  parsePackageName(name)
  if (selector !== undefined && selector.length === 0) fail(`invalid package spec: ${spec}`, 'invalid-package-spec')
  if (selector !== undefined && !VERSION.test(selector) && !DIST_TAG.test(selector)) fail(`unsupported package selector: ${selector}`, 'invalid-package-spec')
  return Object.freeze({ name, selector, spec })
}

function manifestValue(manifest, source) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail(`invalid package manifest: ${source}`, 'invalid-manifest')
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name) || containsUnsafePath(manifest.name)) fail(`invalid plugin name: ${source}`, 'invalid-manifest')
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) fail(`invalid plugin version: ${source}`, 'invalid-manifest')
  return { name: manifest.name, version: manifest.version }
}

async function readManifest(root) {
  let text
  try { text = await readFile(join(root, 'package.json'), 'utf8') } catch (error) {
    fail(`package manifest is unavailable: ${root}`, 'invalid-manifest', { cause: error instanceof Error ? error.message : String(error) })
  }
  try { return { data: JSON.parse(text), hash: createHash('sha256').update(text, 'utf8').digest('hex') } } catch (error) {
    fail(`package manifest is invalid: ${root}`, 'invalid-manifest', { cause: error instanceof Error ? error.message : String(error) })
  }
}

async function assertTreeSafe(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(current, entry.name)
    const info = await lstat(path)
    if (info.isSymbolicLink()) fail(`symlink is not allowed: ${path}`, 'symlink-escape')
    if (info.isDirectory()) await assertTreeSafe(root, path)
    else if (!info.isFile()) fail(`unsupported package entry: ${path}`, 'invalid-source')
  }
}

async function hashTree(root) {
  const hash = createHash('sha256')
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(current, entry.name)
      const info = await lstat(path)
      const relativePath = relative(root, path).split(sep).join('/')
      hash.update(`${relativePath}\0${info.isDirectory() ? 'd' : 'f'}\0`)
      if (info.isDirectory()) await visit(path)
      else hash.update(await readFile(path))
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    const info = await lstat(from)
    if (info.isSymbolicLink()) fail(`symlink is not allowed: ${from}`, 'symlink-escape')
    if (info.isDirectory()) await copyTree(from, to)
    else if (info.isFile()) await writeFile(to, await readFile(from))
    else fail(`unsupported package entry: ${from}`, 'invalid-source')
  }
}

function recordId(name, identity) {
  const safeName = name.replace(/^@/u, '').replaceAll('/', '-')
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16)
  return `${safeName}-${digest}`
}

function defaultPackageManagerRunner({ argv, cwd, env }) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return new Promise((resolvePromise, reject) => {
    const child = execFile(command, argv, { cwd, env, shell: false, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolvePromise({ stderr }) : reject(new PluginRegistryError(`package manager failed: ${stderr}`, 'package-manager-failed', { code, stderr })))
  })
}

async function loadRecords(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.records === null || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) fail('registry manifest is malformed', 'registry-corrupt')
    return parsed.records
  } catch (error) {
    if (error instanceof PluginRegistryError) throw error
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    fail('registry manifest is malformed', 'registry-corrupt', { cause: error instanceof Error ? error.message : String(error) })
  }
}

async function saveRecords(path, records) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, records }, null, 2) + '\n', { flag: 'wx' })
  await rename(temporary, path)
}

export async function discoverLocalPlugin(input, { cwd } = {}) {
  if (typeof input !== 'string' || input.length === 0) fail('local plugin path is required', 'invalid-path')
  if (containsUnsafePath(input)) fail(`unsafe local plugin path: ${input}`, 'invalid-path')
  if (!isAbsolute(input) && (typeof cwd !== 'string' || !isAbsolute(cwd))) fail('relative local plugin paths require an absolute cwd', 'invalid-path')
  const sourcePath = resolve(isAbsolute(input) ? input : join(cwd, input))
  let info
  try { info = await lstat(sourcePath) } catch (error) { fail(`local plugin is unavailable: ${sourcePath}`, 'source-missing', { cause: error instanceof Error ? error.message : String(error) }) }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`local plugin must be a directory: ${sourcePath}`, 'invalid-source')
  await assertTreeSafe(sourcePath)
  const manifest = await readManifest(sourcePath)
  const packageInfo = manifestValue(manifest.data, sourcePath)
  return Object.freeze({ kind: 'local', input, sourcePath, canonicalSource: sourcePath, ...packageInfo, manifestHash: manifest.hash, contentHash: await hashTree(sourcePath) })
}

export function discoverPackagePlugin(spec) {
  const parsed = parsePackageSpec(spec)
  return Object.freeze({ kind: 'package', input: spec, canonicalSource: parsed.spec, name: parsed.name, selector: parsed.selector, spec: parsed.spec })
}

export class PluginRegistry {
  #root
  #runner
  #now
  #installLocks = new Map()

  constructor({ root, packageManagerRunner = defaultPackageManagerRunner, now = () => new Date() } = {}) {
    if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) fail('registry root must be an absolute path', 'invalid-registry-root')
    this.#root = resolve(root)
    this.#runner = packageManagerRunner
    this.#now = now
  }

  async discoverLocal(input, options) { return discoverLocalPlugin(input, options) }
  discoverPackage(spec) { return discoverPackagePlugin(spec) }

  async installLocal(input, options) {
    const source = await discoverLocalPlugin(input, options)
    return this.#install(source, async temporary => copyTree(source.sourcePath, temporary))
  }

  async installPackage(spec) {
    const source = discoverPackagePlugin(spec)
    return this.#install(source, async temporary => {
      const packageRoot = join(temporary, 'package')
      await mkdir(packageRoot, { recursive: true })
      const argv = ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', packageRoot, source.spec]
      await this.#runner({ argv: [...argv], cwd: temporary, env: { ...process.env } })
      const installed = join(packageRoot, 'node_modules', source.name)
      await assertTreeSafe(installed)
      const manifest = await readManifest(installed)
      const packageInfo = manifestValue(manifest.data, installed)
      if (packageInfo.name !== source.name) fail('package manager returned a different package', 'package-manager-failed')
      return { source: { ...source, name: packageInfo.name, version: packageInfo.version, canonicalSource: `${packageInfo.name}@${packageInfo.version}`, manifestHash: manifest.hash, contentHash: await hashTree(installed) }, path: installed }
    })
  }

  async #install(source, prepare) {
    const id = recordId(source.name, source.canonicalSource)
    const previous = this.#installLocks.get(id)
    let release
    const current = new Promise(resolvePromise => { release = resolvePromise })
    this.#installLocks.set(id, current)
    if (previous !== undefined) await previous
    try {
    await mkdir(this.#root, { recursive: true })
    const records = await loadRecords(join(this.#root, MANIFEST))
    if (records[id] !== undefined) return structuredClone(records[id])
    const temporaryRoot = await mkdtemp(join(this.#root, `.install-${id}-`))
    const destination = join(this.#root, id)
    assertInside(this.#root, destination)
    try {
      const prepared = await prepare(temporaryRoot)
      const packagePath = prepared?.path ?? temporaryRoot
      const finalRoot = packagePath === temporaryRoot ? temporaryRoot : `${temporaryRoot}-content`
      if (packagePath !== temporaryRoot) {
        await copyTree(packagePath, finalRoot)
        await rm(temporaryRoot, { recursive: true, force: true })
      }
      const finalSource = prepared?.source ?? source
      const record = { id, sourceKind: finalSource.kind, originalInput: finalSource.input, canonicalSourceIdentity: finalSource.canonicalSource, packageName: finalSource.name, packageVersion: finalSource.version, installedPath: destination, contentHash: finalSource.contentHash, packageManifestHash: finalSource.manifestHash, installedAt: this.#now().toISOString(), registrySchemaVersion: SCHEMA_VERSION }
      await rename(finalRoot, destination)
      records[id] = record
      await saveRecords(join(this.#root, MANIFEST), records)
      return structuredClone(record)
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true })
      await rm(`${temporaryRoot}-content`, { recursive: true, force: true })
      throw error
    }
    } finally {
      if (this.#installLocks.get(id) === current) this.#installLocks.delete(id)
      release()
    }
  }

  async list() {
    const records = await loadRecords(join(this.#root, MANIFEST))
    return Object.values(records).sort((left, right) => left.id.localeCompare(right.id)).map(record => structuredClone(record))
  }

  async provenance(id) {
    this.#assertId(id)
    const records = await loadRecords(join(this.#root, MANIFEST))
    if (!records[id]) fail(`plugin is not installed: ${id}`, 'plugin-missing')
    return structuredClone(records[id])
  }

  async remove(id) {
    this.#assertId(id)
    const records = await loadRecords(join(this.#root, MANIFEST))
    if (!records[id]) fail(`plugin is not installed: ${id}`, 'plugin-missing')
    assertInside(this.#root, join(this.#root, id))
    await rm(join(this.#root, id), { recursive: true, force: false })
    delete records[id]
    await saveRecords(join(this.#root, MANIFEST), records)
    return id
  }

  #assertId(id) {
    if (typeof id !== 'string' || !SAFE_ID.test(id) || containsUnsafePath(id)) fail(`invalid plugin id: ${id}`, 'invalid-plugin-id')
  }
}
