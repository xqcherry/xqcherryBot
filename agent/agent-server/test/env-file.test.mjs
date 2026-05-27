import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadEnvFile } from '../src/env-file.mjs'

test('loads dotenv-style key values without overriding existing environment values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-env-'))
  const envPath = join(dir, '.env')
  await writeFile(
    envPath,
    [
      'OPENAI_BASE_URL=https://api.deepseek.com',
      'OPENAI_API_KEY="sk-test"',
      'OPENAI_MODEL=deepseek-v4-flash',
      'EXISTING=from-file',
      'EMPTY=',
      '# ignored comment',
      '',
    ].join('\n'),
  )
  const env = { EXISTING: 'from-process' }

  const loaded = await loadEnvFile(envPath, env)

  assert.deepEqual(loaded, {
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_MODEL: 'deepseek-v4-flash',
    EMPTY: '',
  })
  assert.equal(env.OPENAI_BASE_URL, 'https://api.deepseek.com')
  assert.equal(env.OPENAI_API_KEY, 'sk-test')
  assert.equal(env.OPENAI_MODEL, 'deepseek-v4-flash')
  assert.equal(env.EXISTING, 'from-process')
  assert.equal(env.EMPTY, '')
})

test('missing env files are ignored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-env-'))
  const missingPath = join(dir, '.env')
  const env = {}

  const loaded = await loadEnvFile(missingPath, env)

  assert.deepEqual(loaded, {})
})

test('packages env example documents the DeepSeek V4 OpenAI-compatible defaults', async () => {
  const content = await readFile(new URL('../../.env.example', import.meta.url), 'utf8')

  assert.match(content, /OPENAI_BASE_URL=https:\/\/api\.deepseek\.com/)
  assert.match(content, /DEEPSEEK_API_KEY=sk-your-deepseek-api-key/)
  assert.match(content, /OPENAI_MODEL=deepseek-v4-flash/)
  assert.match(content, /AGENT_SUMMARY_MODEL=deepseek-v4-flash/)
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/)
})
