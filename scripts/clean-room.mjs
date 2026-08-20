import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = '@dsh-plugin-evaluation/evaluation-platform'
const tempRoot = await mkdtemp(resolve(root, '.clean-room-'))

try {
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--pack-destination', tempRoot], { cwd: root })
  const packResult = JSON.parse(stdout)
  const tarball = resolve(tempRoot, packResult[0].filename)
  const installRoot = resolve(tempRoot, 'install')
  await mkdir(installRoot)
  await writeFile(resolve(installRoot, 'package.json'), '{"private":true}\n')
  await execFileAsync('npm', ['install', '--ignore-scripts', '--no-save', tarball], { cwd: installRoot })
  const packageJson = JSON.parse(await readFile(resolve(installRoot, 'node_modules', '@dsh-plugin-evaluation', 'evaluation-platform', 'package.json'), 'utf8'))
  assert.equal(packageJson.name, packageName)

  const installedRoot = resolve(installRoot, 'node_modules', '@dsh-plugin-evaluation', 'evaluation-platform')
  const child = spawn(process.execPath, [resolve(installedRoot, 'bin/dsh-evaluation.js')], {
    cwd: installRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('clean-room server did not start')), 10_000)
    child.stdout.on('data', () => {
      if (!output.includes('DSH evaluation API listening on ')) return
      clearTimeout(timer)
      resolvePromise()
    })
    child.once('error', reject)
    child.once('exit', code => { if (code !== null && code !== 0) reject(new Error(`clean-room server exited with ${code}`)) })
  })

  const address = output.match(/listening on (http:\/\/[^\s]+)/)?.[1]
  assert.ok(address, output)
  const response = await fetch(`${address}/api/v1/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { apiVersion: 'v1', status: 'ok' })
  child.kill('SIGTERM')
  await new Promise(resolvePromise => child.once('exit', resolvePromise))
  console.log('evaluation-platform clean-room passed: packed tarball installed and health endpoint served')
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
