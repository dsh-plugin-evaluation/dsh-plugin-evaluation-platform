import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, resolve, relative } from 'node:path'

export class DshRuntimeError extends Error {
  constructor(message, code = 'runtime-unavailable') {
    super(message)
    this.name = 'DshRuntimeError'
    this.code = code
  }
}

export async function resolveDshRuntime({ env = process.env, declarationPath, readText = path => readFile(path, 'utf8'), accessPath = path => access(path, constants.X_OK) } = {}) {
  const rootFromEnv = env.PLATFORM_DSH_ROOT
  const declaration = declarationPath ?? resolve(import.meta.dirname, '../runtime.json')
  let declared
  if (rootFromEnv === undefined) {
    try {
      declared = JSON.parse(await readText(declaration))
    } catch (error) {
      if (error instanceof SyntaxError) throw new DshRuntimeError('Invalid DSH runtime declaration', 'runtime-invalid')
      throw new DshRuntimeError('DSH runtime is not configured', 'runtime-missing')
    }
  }
  if (declared !== undefined && (typeof declared !== 'object' || declared === null || Array.isArray(declared))) {
    throw new DshRuntimeError('Invalid DSH runtime declaration', 'runtime-invalid')
  }
  const root = rootFromEnv ?? declared?.root
  if (typeof root !== 'string' || root.length === 0) throw new DshRuntimeError('DSH runtime root is missing', 'runtime-missing')
  const runtimeRoot = isAbsolute(root) ? root : resolve(dirname(declaration), root)
  const cliPath = declared?.cli ?? 'apps/cli/lib/bin.js'
  const bundlePath = declared?.headlessBundle ?? 'packages/bundle/headless'
  if (typeof cliPath !== 'string' || typeof bundlePath !== 'string' || isAbsolute(cliPath) || isAbsolute(bundlePath)) {
    throw new DshRuntimeError('Invalid DSH runtime declaration', 'runtime-invalid')
  }
  const cli = resolve(runtimeRoot, cliPath)
  const headlessBundle = resolve(runtimeRoot, bundlePath)
  const separator = process.platform === 'win32' ? '\\' : '/'
  const escapesRoot = path => {
    const child = relative(runtimeRoot, path)
    return child === '..' || child.startsWith(`..${separator}`) || isAbsolute(child)
  }
  if (escapesRoot(cli) || escapesRoot(headlessBundle)) {
    throw new DshRuntimeError('DSH runtime paths escape the runtime root', 'runtime-invalid')
  }
  try {
    await accessPath(cli)
  } catch {
    throw new DshRuntimeError(`DSH CLI is not executable: ${cli}`, 'runtime-invalid')
  }
  try {
    await accessPath(headlessBundle)
  } catch {
    throw new DshRuntimeError(`DSH headless bundle is unavailable: ${headlessBundle}`, 'runtime-invalid')
  }
  return { root: runtimeRoot, cli, headlessBundle, declaration }
}
