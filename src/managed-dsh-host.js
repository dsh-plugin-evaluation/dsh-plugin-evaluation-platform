import { mkdir, mkdtemp, readFile, readdir, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { resolveDshRuntime } from './runtime-config.js'

export class DshHostBusyError extends Error {
  constructor() {
    super('A DSH evaluation is already running')
    this.name = 'DshHostBusyError'
    this.code = 'run-in-progress'
  }
}

export class DshRunError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'DshRunError'
    this.code = code
    this.details = details
  }
}

const SECRET = /((?:["'])(?:api[\s_-]?key|secret|token|password|authorization)["']|\b(?:api[\s_-]?key|secret|token|password|authorization)\b)\s*([:=])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu
const BEARER = /\b(Bearer|Basic)\s+[^\s,;}\]]+/giu

export function redact(text) {
  return String(text ?? '')
    .replace(BEARER, '$1 [REDACTED]')
    .replace(SECRET, '$1$2 [REDACTED]')
}

function isBundleManifest(manifest) {
  return typeof manifest === 'object' && manifest !== null
    && typeof manifest.dsh === 'object' && manifest.dsh !== null
    && typeof manifest.dsh.bundle === 'object' && manifest.dsh.bundle !== null
    && typeof manifest.name === 'string' && manifest.name.length > 0
    && typeof manifest.dsh.bundle.patch === 'string' && manifest.dsh.bundle.patch.length > 0
    && typeof manifest.dsh.bundle.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(manifest.dsh.bundle.sha256)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function hashPluginTree(root) {
  const hash = createHash('sha256')
  async function visit(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = resolve(current, entry.name)
      const info = await lstat(path)
      const relativePath = relative(root, path).split(process.platform === 'win32' ? '\\' : '/').join('/')
      hash.update(`${relativePath}\0${info.isDirectory() ? 'd' : 'f'}\0`)
      if (info.isDirectory()) await visit(path)
      else if (info.isFile()) hash.update(await readFile(path))
    }
  }
  await visit(root)
  return hash.digest('hex')
}

async function validatePlugin(path, registryRecord) {
  let manifest
  try {
    manifest = await readJson(resolve(path, 'package.json'))
  } catch (error) {
    throw new DshRunError(`Plugin manifest is unavailable: ${path}`, 'plugin-invalid', { path, cause: error instanceof Error ? error.message : String(error) })
  }
  if (!isBundleManifest(manifest)) throw new DshRunError(`Plugin is not a DSH bundle: ${path}`, 'plugin-not-bundle', { path })
  const patchPath = resolve(path, manifest.dsh.bundle.patch)
  const patchRelative = relative(path, patchPath)
  if (patchRelative === '..' || patchRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new DshRunError(`Plugin bundle patch escapes plugin root: ${path}`, 'plugin-invalid', { path })
  }
  let patch
  try {
    patch = await readFile(patchPath)
  } catch (error) {
    throw new DshRunError(`Plugin bundle patch is unavailable: ${path}`, 'plugin-invalid', { path, cause: error instanceof Error ? error.message : String(error) })
  }
  const checksum = createHash('sha256').update(patch).digest('hex')
  if (checksum.toLowerCase() !== manifest.dsh.bundle.sha256.toLowerCase()) {
    throw new DshRunError(`Plugin bundle checksum failed: ${path}`, 'plugin-checksum-mismatch', { path, expected: manifest.dsh.bundle.sha256, actual: checksum })
  }
  return {
    name: manifest.name,
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    patchHash: checksum,
    contentHash: registryRecord?.contentHash ?? await hashPluginTree(path),
    manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    registry: registryRecord === undefined ? undefined : { id: registryRecord.id, canonicalSourceIdentity: registryRecord.canonicalSourceIdentity, contentHash: registryRecord.contentHash, packageManifestHash: registryRecord.packageManifestHash },
  }
}

async function verifyActivation(dshHome, profile, pluginPaths, headlessBundle) {
  const manifest = await readJson(resolve(dshHome, 'profiles', profile, 'package.json'))
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const pluginManifests = await Promise.all(pluginPaths.map(async path => readJson(resolve(path, 'package.json'))))
  const pluginNames = pluginManifests.map(manifest => manifest.name)
  const headlessManifest = await readJson(resolve(headlessBundle, 'package.json'))
  const headlessName = headlessManifest.name
  const expected = [...pluginNames, headlessName]
  const missing = expected.filter(name => typeof name !== 'string' || !bundles.includes(name) || dependencies[name] === undefined)
  if (missing.length > 0) throw new DshRunError('DSH profile activation proof failed', 'activation-failed', { profile, missing })
  return { dependencies: Object.keys(dependencies).sort(), bundles: [...bundles].sort(), names: expected.sort() }
}

export class ManagedDshHost {
  #active = null
  #runtimeOptions
  #runtimeResolver
  #timeoutMs
  #terminateGraceMs
  #spawn
  #tempPrefix

  constructor({ runtime = {}, runtimeResolver = resolveDshRuntime, timeoutMs = 120_000, terminateGraceMs = 1_000, spawnProcess = spawn, tempPrefix = 'dsh-evaluation-' } = {}) {
    this.#runtimeOptions = runtime
    this.#runtimeResolver = runtimeResolver
    this.#timeoutMs = timeoutMs
    this.#terminateGraceMs = terminateGraceMs
    this.#spawn = spawnProcess
    this.#tempPrefix = tempPrefix
  }

  status() {
    if (this.#active === null) return { running: false }
    return { running: true, runId: this.#active.runId, profile: this.#active.profile, startedAt: this.#active.startedAt, spawned: this.#active.spawned, terminating: this.#active.terminating }
  }

  async start({ pluginPaths, prompt, timeoutMs = this.#timeoutMs, pluginRecords = [] } = {}) {
    if (this.#active !== null) throw new DshHostBusyError()
    if (!Array.isArray(pluginPaths) || pluginPaths.length === 0) throw new DshRunError('At least one plugin must be selected', 'plugin-required')
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new DshRunError('Prompt is required', 'prompt-required')
    const active = { runId: randomUUID(), profile: `evaluation-${randomUUID()}`, startedAt: Date.now(), child: null, spawned: false, terminating: false, terminate: null }
    this.#active = active
    let dataRoot
    const signalHandler = () => { active.terminate?.() }
    process.once('SIGINT', signalHandler)
    process.once('SIGTERM', signalHandler)
    try {
      const plugins = []
      for (const [index, path] of pluginPaths.entries()) plugins.push({ path, ...(await validatePlugin(path, pluginRecords[index])) })
      const runtime = await this.#runtimeResolver(this.#runtimeOptions)
      dataRoot = await mkdtemp(resolve(tmpdir(), this.#tempPrefix))
      const dshHome = resolve(dataRoot, 'dsh-home')
      const workspace = resolve(dataRoot, 'workspace')
      await mkdir(workspace)
      const env = { ...process.env, ...(this.#runtimeOptions.env ?? {}), DSH_HOME: dshHome }
      const install = await this.#runChild([runtime.cli, 'plugin', '--profile', active.profile, 'add', ...pluginPaths.map(path => `link:${path}`), `link:${runtime.headlessBundle}`], { cwd: runtime.root, env, timeoutMs, active })
      this.#throwForProcess(install, 'plugin installation')
      const activation = await verifyActivation(dshHome, active.profile, pluginPaths, runtime.headlessBundle)
      const result = await this.#runChild([runtime.cli, '--profile', active.profile, prompt], { cwd: workspace, env, timeoutMs, active })
      this.#throwForProcess(result, 'DSH evaluation')
      return {
        runId: active.runId,
        profile: active.profile,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr),
        activation,
        provenance: {
          ...(this.#runtimeOptions.provenance ?? {}),
          plugin: plugins.map(plugin => ({ name: plugin.name, ...(plugin.version === undefined ? {} : { version: plugin.version }), ...(plugin.contentHash === undefined ? {} : { contentHash: plugin.contentHash }), patchHash: plugin.patchHash, manifestHash: plugin.manifestHash, ...(plugin.registry === undefined ? {} : { registry: plugin.registry }) })),
        },
      }
    } finally {
      process.removeListener('SIGINT', signalHandler)
      process.removeListener('SIGTERM', signalHandler)
      this.#active = null
      if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true })
    }
  }

  terminate() {
    if (this.#active?.child === null || this.#active.child === undefined || this.#active.terminating) return false
    this.#active.terminate?.()
    return true
  }

  #throwForProcess(result, operation) {
    const details = { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
    if (result.timedOut) throw new DshRunError(`${operation} timed out`, 'timeout', details)
    if (result.terminated) throw new DshRunError(`${operation} was terminated`, 'terminated', details)
    if (result.exitCode !== 0) throw new DshRunError(`${operation} failed`, 'nonzero-exit', details)
  }

  #runChild(args, { cwd, env, timeoutMs, active }) {
    return new Promise((resolvePromise, reject) => {
      const startedAt = Date.now()
      let child
      try {
        child = this.#spawn(process.execPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new DshRunError(`Unable to start DSH: ${error instanceof Error ? error.message : String(error)}`, 'spawn-failed'))
        return
      }
      active.child = child
      active.spawned = true
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let terminated = false
      let escalation
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(escalation)
        resolvePromise({ ...result, stdout, stderr, timedOut, terminated, durationMs: Date.now() - startedAt })
      }
      const kill = (signal) => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, signal) } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
          }
        } else child.kill(signal)
      }
      const timer = setTimeout(() => { timedOut = true; active.terminate?.() }, timeoutMs)
      active.terminate = () => {
        if (settled || active.terminating) return
        active.terminating = true
        terminated = true
        kill('SIGTERM')
        escalation = setTimeout(() => kill('SIGKILL'), this.#terminateGraceMs)
      }
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.once('error', error => {
        clearTimeout(timer)
        clearTimeout(escalation)
        if (!settled) {
          settled = true
          reject(new DshRunError(`Unable to start DSH: ${error.message}`, 'spawn-failed'))
        }
      })
      child.once('close', (code, signal) => finish({ exitCode: code ?? 1, signal }))
    })
  }
}
