import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { applyPersonasFromFile } from '../../scripts/apply-personas.mjs'
import { PersonaTemplateStore, SQLiteSessionStore } from '../src/index.mjs'

test('applyPersonasFromFile imports persona export idempotently and advances current version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')
  const firstExport = {
    exportedAt: '2026-06-15T00:00:00.000Z',
    defaultPersonaKey: 'girlfriend',
    personas: [
      {
        personaKey: 'girlfriend',
        name: 'Girlfriend',
        description: 'Replica persona.',
        content: 'persona v1',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
    bindings: [
      { scope: 'session', subjectId: 'qq-private:42', personaKey: 'girlfriend' },
    ],
  }

  await writeFile(filePath, JSON.stringify(firstExport, null, 2))
  assert.deepEqual(await applyPersonasFromFile({ dbPath, filePath }), {
    imported: 1,
    personaKeys: ['girlfriend'],
    defaultPersonaKey: 'girlfriend',
    bindings: 1,
    personas: [
      {
        personaKey: 'girlfriend',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        current: true,
      },
    ],
  })
  assert.deepEqual(await applyPersonasFromFile({ dbPath, filePath }), {
    imported: 1,
    personaKeys: ['girlfriend'],
    defaultPersonaKey: 'girlfriend',
    bindings: 1,
    personas: [
      {
        personaKey: 'girlfriend',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        current: true,
      },
    ],
  })

  const updatedExport = {
    ...firstExport,
    exportedAt: '2026-06-15T01:00:00.000Z',
    personas: [
      {
        ...firstExport.personas[0],
        content: 'persona v2',
        sourceVersionNo: 2,
        sourcePublishedAt: '2026-06-15T01:00:00.000Z',
      },
    ],
  }
  await writeFile(filePath, JSON.stringify(updatedExport, null, 2))
  await applyPersonasFromFile({ dbPath, filePath })

  const store = new SQLiteSessionStore(dbPath)
  const personaStore = new PersonaTemplateStore({ adapter: store.adapter })
  const config = await personaStore.getCurrentPersonaConfig()

  assert.deepEqual(
    store.db
      .prepare('SELECT source_version_no FROM persona_template_versions ORDER BY source_version_no ASC')
      .all()
      .map(row => Number(row.source_version_no)),
    [1, 2],
  )
  assert.equal(config.personas[0].content, 'persona v2')
  store.close()
})

test('applyPersonasFromFile rejects invalid persona exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-apply-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const filePath = join(dir, 'current.json')

  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      defaultPersonaKey: 'missing',
      personas: [],
      bindings: [],
    }),
  )
  await assert.rejects(
    () => applyPersonasFromFile({ dbPath, filePath }),
    /defaultPersonaKey/,
  )

  await writeFile(
    filePath,
    JSON.stringify({
      exportedAt: '2026-06-15T00:00:00.000Z',
      defaultPersonaKey: 'girlfriend',
      personas: [
        {
          personaKey: 'girlfriend',
          name: 'Girlfriend',
          description: '',
          content: '   ',
          sourceVersionNo: 1,
          sourcePublishedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
      bindings: [],
    }),
  )
  await assert.rejects(
    () => applyPersonasFromFile({ dbPath, filePath }),
    /content/,
  )
})
