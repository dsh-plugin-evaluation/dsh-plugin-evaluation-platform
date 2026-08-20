import { randomUUID } from 'node:crypto'
import { redact } from './managed-dsh-host.js'

function publicError(error) {
  return { code: error?.code ?? 'evaluation-failed', message: redact(error?.message ?? 'Evaluation failed'), details: redact(error?.details ?? {}) }
}

export class EvaluationOrchestrator {
  #host
  #runs = new Map()
  #reports = new Map()
  #now

  constructor({ host, now = () => Date.now() } = {}) {
    if (!host || typeof host.start !== 'function' || typeof host.status !== 'function' || typeof host.terminate !== 'function') throw new TypeError('host must provide start, status, and terminate')
    this.#host = host
    this.#now = now
  }

  status() {
    return { host: this.#host.status(), runs: this.#runs.size, reports: this.#reports.size }
  }

  listRuns() { return [...this.#runs.values()].map(run => structuredClone(run)) }
  listReports() { return [...this.#reports.values()].map(report => structuredClone(report)) }
  getRun(runId) { return this.#runs.has(runId) ? structuredClone(this.#runs.get(runId)) : undefined }
  getReport(runId) { return this.#reports.has(runId) ? structuredClone(this.#reports.get(runId)) : undefined }

  start(input) {
    const runId = randomUUID()
    const run = { runId, status: 'queued', progress: 0, startedAt: this.#now() }
    this.#runs.set(runId, run)
    Promise.resolve().then(async () => {
      run.status = 'running'
      run.progress = 10
      const result = await this.#host.start(input)
      run.status = 'completed'
      run.progress = 100
      run.finishedAt = this.#now()
      run.result = redactValue(result)
      this.#reports.set(runId, { reportId: runId, runId, status: run.status, createdAt: run.finishedAt, result: run.result })
    }).catch(error => {
      run.status = error?.code === 'terminated' ? 'cancelled' : 'failed'
      run.progress = 100
      run.finishedAt = this.#now()
      run.error = publicError(error)
      this.#reports.set(runId, { reportId: runId, runId, status: run.status, createdAt: run.finishedAt, error: run.error })
    })
    return structuredClone(run)
  }

  cancel(runId) {
    const run = this.#runs.get(runId)
    if (!run) return { accepted: false, code: 'run-not-found' }
    if (run.status !== 'running' && run.status !== 'queued') return { accepted: false, code: 'run-not-running' }
    if (!this.#host.terminate()) return { accepted: false, code: 'run-not-cancellable' }
    run.status = 'cancelling'
    return { accepted: true, run: structuredClone(run) }
  }
}

function redactValue(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /secret|token|password|authorization|api[_ -]?key/i.test(key) ? '[REDACTED]' : redactValue(entry)]))
  return value
}
