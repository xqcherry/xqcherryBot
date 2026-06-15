import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { applyPromptsFromFile } from '../../scripts/apply-prompts.mjs'
import { CHAT_PERSONA_PROMPT_KEY, SQLiteSessionStore } from '../src/index.mjs'

test('applyPromptsFromFile imports prompt export idempotently and advances current version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')
  const firstExport = {
    exportedAt: '2026-06-15T00:00:00.000Z',
    prompts: [
      {
        promptKey: CHAT_PERSONA_PROMPT_KEY,
        name: 'Chat Persona',
        description: 'Main chat prompt.',
        systemPrompt: 'persona v1',
        userPrompt: '',
        extraJson: null,
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-14T00:00:00.000Z',
      },
    ],
  }

  await writeFile(filePath, JSON.stringify(firstExport, null, 2))
  assert.deepEqual(await applyPromptsFromFile({ dbPath, filePath }), {
    imported: 1,
    promptKeys: [CHAT_PERSONA_PROMPT_KEY],
    prompts: [
      {
        promptKey: CHAT_PERSONA_PROMPT_KEY,
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-14T00:00:00.000Z',
        current: true,
      },
    ],
  })
  assert.deepEqual(await applyPromptsFromFile({ dbPath, filePath }), {
    imported: 1,
    promptKeys: [CHAT_PERSONA_PROMPT_KEY],
    prompts: [
      {
        promptKey: CHAT_PERSONA_PROMPT_KEY,
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-14T00:00:00.000Z',
        current: true,
      },
    ],
  })

  const updatedExport = {
    ...firstExport,
    exportedAt: '2026-06-15T01:00:00.000Z',
    prompts: [
      {
        ...firstExport.prompts[0],
        systemPrompt: 'persona v2',
        sourceVersionNo: 2,
        sourcePublishedAt: '2026-06-15T01:00:00.000Z',
      },
    ],
  }
  await writeFile(filePath, JSON.stringify(updatedExport, null, 2))
  await applyPromptsFromFile({ dbPath, filePath })

  const store = new SQLiteSessionStore(dbPath)
  const rows = store.db
    .prepare('SELECT source_version_no FROM prompt_template_versions ORDER BY source_version_no ASC')
    .all()
    .map(row => Number(row.source_version_no))
  const current = store.db
    .prepare(`
      SELECT v.system_prompt
      FROM prompt_templates t
      JOIN prompt_template_versions v ON v.id = t.current_version_id
      WHERE t.prompt_key = ?
    `)
    .get(CHAT_PERSONA_PROMPT_KEY)

  assert.deepEqual(rows, [1, 2])
  assert.equal(current.system_prompt, 'persona v2')
  store.close()
})

test('applyPromptsFromFile rejects exports without CHAT_PERSONA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')
  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      prompts: [],
    }),
  )

  await assert.rejects(
    () => applyPromptsFromFile({ dbPath, filePath }),
    /CHAT_PERSONA/,
  )
})

test('applyPromptsFromFile imports multiple prompt keys from one export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')
  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      prompts: [
        {
          promptKey: CHAT_PERSONA_PROMPT_KEY,
          name: 'Chat Persona',
          description: 'Persona prompt.',
          systemPrompt: 'persona',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 1,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
        {
          promptKey: 'CHAT_CONSTRAINTS',
          name: 'Chat Constraints',
          description: 'Hard constraints.',
          systemPrompt: 'constraints',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 1,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
    }),
  )

  const result = await applyPromptsFromFile({ dbPath, filePath })

  assert.deepEqual(result.promptKeys, [CHAT_PERSONA_PROMPT_KEY, 'CHAT_CONSTRAINTS'])
  const store = new SQLiteSessionStore(dbPath)
  const rows = store.db
    .prepare('SELECT prompt_key FROM prompt_templates ORDER BY prompt_key ASC')
    .all()
    .map(row => row.prompt_key)
  assert.deepEqual(rows, ['CHAT_CONSTRAINTS', CHAT_PERSONA_PROMPT_KEY])
  store.close()
})

test('applyPromptsFromFile rejects invalid production prompt snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prompt-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')

  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      prompts: [
        {
          promptKey: CHAT_PERSONA_PROMPT_KEY,
          name: 'Chat Persona',
          description: '',
          systemPrompt: 'ok',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 1,
          sourcePublishedAt: 'not-a-date',
        },
      ],
    }),
  )
  await assert.rejects(
    () => applyPromptsFromFile({ dbPath, filePath }),
    /sourcePublishedAt/,
  )

  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      prompts: [
        {
          promptKey: CHAT_PERSONA_PROMPT_KEY,
          name: 'Chat Persona',
          description: '',
          systemPrompt: '   ',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 1,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
    }),
  )
  await assert.rejects(
    () => applyPromptsFromFile({ dbPath, filePath }),
    /systemPrompt/,
  )

  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      prompts: [
        {
          promptKey: CHAT_PERSONA_PROMPT_KEY,
          name: 'Chat Persona',
          description: '',
          systemPrompt: 'one',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 1,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
        {
          promptKey: CHAT_PERSONA_PROMPT_KEY,
          name: 'Chat Persona',
          description: '',
          systemPrompt: 'two',
          userPrompt: '',
          extraJson: null,
          sourceVersionNo: 2,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
    }),
  )
  await assert.rejects(
    () => applyPromptsFromFile({ dbPath, filePath }),
    /duplicate promptKey/,
  )
})
