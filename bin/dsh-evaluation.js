#!/usr/bin/env node

import { startServer } from '../src/server.js'

const server = await startServer()
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : process.env.PORT
process.stdout.write(`DSH evaluation API listening on http://${process.env.HOST ?? '127.0.0.1'}:${port}\n`)

const shutdown = () => server.close(() => process.exit(0))
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
