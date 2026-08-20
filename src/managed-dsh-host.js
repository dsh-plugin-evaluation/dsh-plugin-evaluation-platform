import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

const SECRET = /(["']?)(api[\s_-]?key|secret|token|password|authorization)\1\s*([:=])\s*("[^"]*"|'[^']*'|[^\s,;}\]]+)/giu
const BEARER = /\b(Bearer|Basic)\s+[^\s,;}\]]+/giu

export function redact(text) {
  return String(text ?? '')
    .replace(SECRET, '$1$2$1$3 [REDACTED]')
    .replace(BEARER, '$1 [REDACTED]')
}

function isBundleManifest(manifest) {
  return typeof manifest === 'object' && manifest !== null
    && typeof manifest.dsh === 'object' && manifest.dsh !== null
    && typeof manifest.dsh.bundle === 'object' && manifest.dsh.bundle !== null
    && typeof manifest.dsh.bundle.patch === 'string' && manifest.dsh.bundle.patch.length > 0
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function validatePlugin(path) {
  let manifest
  try {
    manifest = await readJson(resolve(path, 'package.json'))
  } catch (error) {
    throw new DshRunError(`Plugin manifest is unavailable: ${path}`, 'plugin-invalid', { path, cause: error instanceof Error ? error.message : String(error) })
  }
  if (!isBundleManifest(manifest)) throw new DshRunError(`Plugin is not a DSH bundle: ${path}`, 'plugin-not-bundle', { path })
}

async function verifyActivation(dshHome, profile, pluginPaths, headlessBundle) {
  const manifest = await readJson(resolve(dshHome, 'profiles', profile, 'package.json'))
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const pluginNames = await Promise.all(pluginPaths.map(async path => (await readJson(resolve(path, 'package.json'))).name))
  const headlessName = (await readJson(resolve(headlessBundle, 'package.json'))).name
  const expected = [...pluginNames, headlessName]
  const missing = expected.filter(name => typeof name !== 'string' || !bundles.includes(name) || dependencies[name] === undefined)
  if (missing.length > 0) throw new DshRunError('DSH profile activation proof failed', 'activation-failed', { profile, missing })
  return { dependencies: Object.keys(dependencies), bundles: [...bundles] }
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

  async start({ pluginPaths, prompt, timeoutMs = this.#timeoutMs } = {}) {
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
      for (const path of pluginPaths) await validatePlugin(path)
      const runtime = await this.#runtimeResolver(this.#runtimeOptions)
      dataRoot = await mkdtemp(resolve(tmpdir(), this.#tempPrefix))
      const dshHome = resolve(dataRoot, 'dsh-home')
      const env = { ...process.env, ...(this.#runtimeOptions.env ?? {}), DSH_HOME: dshHome }
      const install = await this.#runChild([runtime.cli, 'plugin', '--profile', active.profile, 'add', ...pluginPaths.map(path => `link:${path}`), `link:${runtime.headlessBundle}`], { cwd: runtime.root, env, timeoutMs, active })
      this.#throwForProcess(install, 'plugin installation')
      const activation = await verifyActivation(dshHome, active.profile, pluginPaths, runtime.headlessBundle)
      const result = await this.#runChild([runtime.cli, '--profile', active.profile, prompt], { cwd: runtime.root, env, timeoutMs, active })
      this.#throwForProcess(result, 'DSH evaluation')
      return { runId: active.runId, profile: active.profile, exitCode: result.exitCode, stdout: redact(result.stdout), stderr: redact(result.stderr), activation }
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
    if (result.timedOut) throw new DshRunError(`${operation} timed out`, 'timeout', result)
    if (result.terminated) throw new DshRunError(`${operation} was terminated`, 'terminated', result)
    if (result.exitCode !== 0) throw new DshRunError(`${operation} failed`, 'nonzero-exit', { ...result, stderr: redact(result.stderr) })
  }

  #runChild(args, { cwd, env, timeoutMs, active }) {
    return new Promise((resolvePromise, reject) => {
      const child = this.#spawn(process.execPath, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
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
        resolvePromise({ ...result, stdout, stderr, timedOut, terminated })
      }
      const kill = (signal) => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, signal) } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
          }
        }
        child.kill(signal)
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
      child.once('error', error => { clearTimeout(timer); reject(new DshRunError(`Unable to start DSH: ${error.message}`, 'spawn-failed')) })
      child.once('close', (code, signal) => finish({ exitCode: code ?? 1, signal }))
    })
  }
}
