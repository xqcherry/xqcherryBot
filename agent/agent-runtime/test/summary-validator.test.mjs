import assert from 'node:assert/strict'
import test from 'node:test'

import {
  JSON_SUMMARY_FIELDS,
  parseJsonSummary,
  SummaryValidator,
} from '../src/index.mjs'

const VALID_JSON_SUMMARY = JSON.stringify({
  activeRequest: '继续实现 JSON summary schema。',
  completedWork: ['已实现 markdown 摘要。'],
  keyDecisions: ['JSON 字段使用 camelCase。'],
  userPreferences: ['用户希望分步骤推进。'],
  importantFacts: ['摘要用于上下文压缩。'],
  openQuestions: ['是否默认启用 JSON？'],
  remainingWork: ['补测试。'],
  relevantFiles: ['packages/agent-runtime/src/runtime/summary-validator.mjs'],
})

test('summary validator accepts valid JSON summary schema', () => {
  const validator = new SummaryValidator({ format: 'json' })

  assert.deepEqual(validator.validate(VALID_JSON_SUMMARY), { ok: true })
  assert.deepEqual(parseJsonSummary(VALID_JSON_SUMMARY).value.activeRequest, '继续实现 JSON summary schema。')
})

test('summary validator rejects invalid JSON summary schema', () => {
  const validator = new SummaryValidator({ format: 'json' })

  assert.match(validator.validate('{bad json').reason, /not valid JSON/)
  assert.match(
    validator.validate(JSON.stringify({ activeRequest: 'x' })).reason,
    /Missing JSON summary fields/,
  )
  assert.match(
    validator.validate(JSON.stringify({
      ...Object.fromEntries(JSON_SUMMARY_FIELDS.map(field => [field, []])),
      importantFacts: { invalid: true },
    })).reason,
    /Invalid JSON summary fields: importantFacts/,
  )
})

test('summary validator accepts fenced JSON summary text', () => {
  const validator = new SummaryValidator({ format: 'json' })

  assert.deepEqual(validator.validate(`\`\`\`json\n${VALID_JSON_SUMMARY}\n\`\`\``), { ok: true })
})
