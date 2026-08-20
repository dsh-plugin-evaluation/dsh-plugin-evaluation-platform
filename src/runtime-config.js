import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

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
  const root = rootFromEnv ?? declared?.root
  if (typeof root !== 'string' || root.length === 0) throw new DshRuntimeError('DSH runtime root is missing', 'runtime-missing')
  const runtimeRoot = isAbsolute(root) ? root : resolve(dirname(declaration), root)
  const cli = resolve(runtimeRoot, typeof declared?.cli === 'string' ? declared.cli : 'apps/cli/lib/bin.js')
  const headlessBundle = resolve(runtimeRoot, typeof declared?.headlessBundle === 'string' ? declared.headlessBundle : 'packages/bundle/headless')
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
  return { root: runtimeRoot, cli, headlessBundle, declaration: declarationPath ?? null }
}
