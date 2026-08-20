import assert from 'node:assert/strict'
import test from 'node:test'
import { EvaluationOrchestrator } from '../src/orchestrator.js'

test('queues, completes, and reports a redacted evaluation', async () => {
  let resolveRun
  const host = { status: () => ({ running: true }), terminate: () => false, start: () => new Promise(resolve => { resolveRun = resolve }) }
  const orchestrator = new EvaluationOrchestrator({ host, now: (() => { let value = 100; return () => value += 1 })() })
  const created = orchestrator.start({ prompt: 'hello', provenance: { scheme: { id: 'scheme-v1' } } })
  assert.equal(created.status, 'queued')
  await new Promise(resolve => setImmediate(resolve))
  resolveRun({ stdout: 'token=secret-value', nested: { password: 'hidden' } })
  for (let attempt = 0; attempt < 20 && orchestrator.getRun(created.runId)?.status !== 'completed'; attempt += 1) await new Promise(resolve => setImmediate(resolve))
  const run = orchestrator.getRun(created.runId)
  assert.equal(run.status, 'completed')
  assert.equal(run.progress, 100)
  assert.doesNotMatch(JSON.stringify(run), /secret-value|hidden/)
  assert.equal(orchestrator.getReport(created.runId).status, 'completed')
  assert.equal(orchestrator.getReport(created.runId).reportSchemaVersion, 1)
  assert.equal(orchestrator.getReport(created.runId).summary.status, 'passed')
  assert.deepEqual(orchestrator.getReport(created.runId).provenance, { scheme: { id: 'scheme-v1' } })
})

test('cancels a queued evaluation before the host starts it', async () => {
  let release
  let starts = 0
  const host = { status: () => ({ running: false }), terminate: () => { throw new Error('must not terminate') }, start: () => { starts += 1; return new Promise(resolve => { release = resolve }) } }
  const orchestrator = new EvaluationOrchestrator({ host })
  const created = orchestrator.start({ prompt: 'queued' })
  const cancelled = orchestrator.cancel(created.runId)
  assert.equal(cancelled.accepted, true)
  assert.equal(orchestrator.getRun(created.runId).status, 'cancelled')
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  assert.equal(starts, 0)
  assert.equal(orchestrator.getReport(created.runId).status, 'cancelled')
})

test('cancels an active evaluation through the host contract', async () => {
  let terminateCalls = 0
  const host = { status: () => ({ running: true }), terminate: () => { terminateCalls += 1; return true }, start: () => new Promise(() => {}) }
  const orchestrator = new EvaluationOrchestrator({ host })
  const created = orchestrator.start({ prompt: 'hang' })
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  const cancelled = orchestrator.cancel(created.runId)
  assert.equal(cancelled.accepted, true)
  assert.equal(terminateCalls, 1)
  assert.equal(orchestrator.getRun(created.runId).status, 'cancelling')
})
