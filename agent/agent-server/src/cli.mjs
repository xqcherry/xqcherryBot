#!/usr/bin/env node
import { resolve } from 'node:path'

import { createGatewayFromEnv } from './gateway-service.mjs'
import { loadEnvFile } from './env-file.mjs'

const envFile = process.env.AGENT_ENV_FILE ?? resolve(process.cwd(), '.env')
await loadEnvFile(envFile, process.env)

const gateway = createGatewayFromEnv(process.env, {
  logger: event => {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...event }))
  },
})

await gateway.start()
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    type: 'gateway_started',
    host: gateway.host,
    port: gateway.port,
  }),
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    gateway.close()
    process.exit(0)
  })
}
