import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseMarkdownSections,
  SummaryQualityChecker,
} from '../src/index.mjs'

const VALID_SUMMARY = [
  '## Active Request',
  '继续实现上下文质量检查。',
  '## Completed Work',
  '已有压缩基础。',
  '## Key Decisions',
  '使用结构化摘要。',
  '## User Preferences',
  '用户希望分步骤完成。',
  '## Important Facts',
  '上下文工程正在推进。',
  '## Open Questions',
  '是否启用严格质量检查？',
  '## Remaining Work',
  '继续补测试。',
  '## Relevant Files',
  'packages/agent-runtime/src/runtime/summary-quality-checker.mjs',
].join('\n')

test('summary quality checker parses markdown sections', () => {
  const sections = parseMarkdownSections(VALID_SUMMARY)

  assert.equal(sections.get('active request'), '继续实现上下文质量检查。')
  assert.equal(sections.get('user preferences'), '用户希望分步骤完成。')
})

test('summary quality checker accepts summaries preserving critical sections', () => {
  const checker = new SummaryQualityChecker()

  const result = checker.check({
    summary: VALID_SUMMARY,
    messages: [
      { text: '我希望分步骤完成，下一步怎么做？' },
    ],
  })

  assert.deepEqual(result, { ok: true })
})

test('summary quality checker rejects missing active request preferences and questions', () => {
  const checker = new SummaryQualityChecker()
  const summary = [
    '## Active Request',
    'none',
    '## User Preferences',
    '无',
    '## Open Questions',
    'No open questions.',
  ].join('\n')

  const result = checker.check({
    summary,
    messages: [
      { text: '我希望分步骤完成，这个怎么做？' },
    ],
  })

  assert.equal(result.ok, false)
  assert.deepEqual(result.findings, [
    'missing_active_request',
    'missing_user_preferences',
    'missing_open_questions',
  ])
  assert.match(result.reason, /Summary quality check failed/)
})

test('summary quality checker can be disabled', () => {
  const checker = new SummaryQualityChecker({ enabled: false })

  assert.deepEqual(
    checker.check({
      summary: '',
      messages: [{ text: '我希望保留偏好，这怎么做？' }],
    }),
    { ok: true },
  )
})
