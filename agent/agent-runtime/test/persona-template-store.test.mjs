import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  DatabasePersonaProvider,
  PersonaTemplateStore,
  SQLiteSessionStore,
} from '../src/index.mjs'

test('persona template store reads current persona config from SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-store-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const personaStore = new PersonaTemplateStore({ adapter: store.adapter })

  await personaStore.upsertPublishedPersonaConfig({
    exportedAt: '2026-06-15T00:00:00.000Z',
    defaultPersonaKey: 'friend',
    personas: [
      {
        personaKey: 'friend',
        name: 'Friend',
        description: 'Main persona.',
        content: 'database persona v1',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
    bindings: [
      { scope: 'user', subjectId: '42', personaKey: 'friend' },
    ],
  })

  const config = await personaStore.getCurrentPersonaConfig()

  assert.equal(config.defaultPersonaKey, 'friend')
  assert.deepEqual(config.bindings, [
    { scope: 'user', subjectId: '42', personaKey: 'friend' },
  ])
  assert.equal(config.personas[0].personaKey, 'friend')
  assert.equal(config.personas[0].content, 'database persona v1')
  assert.equal(config.personas[0].sourceVersionNo, 1)
  assert.equal(config.personas[0].source, 'database')
  store.close()
})

test('database persona provider resolves user, session, default, then fallback prompt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-provider-db-'))
  const dbPath = join(dir, 'sessions.sqlite')
  const store = new SQLiteSessionStore(dbPath)
  const personaStore = new PersonaTemplateStore({ adapter: store.adapter })

  await personaStore.upsertPublishedPersonaConfig({
    exportedAt: '2026-06-15T00:00:00.000Z',
    defaultPersonaKey: 'default_friend',
    personas: [
      {
        personaKey: 'default_friend',
        name: 'Default Friend',
        description: '',
        content: 'default persona',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
      {
        personaKey: 'session_friend',
        name: 'Session Friend',
        description: '',
        content: 'session persona',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
      {
        personaKey: 'user_friend',
        name: 'User Friend',
        description: '',
        content: 'user persona',
        sourceVersionNo: 1,
        sourcePublishedAt: '2026-06-15T00:00:00.000Z',
      },
    ],
    bindings: [
      { scope: 'session', subjectId: 'qq-group:1000', personaKey: 'session_friend' },
      { scope: 'user', subjectId: '42', personaKey: 'user_friend' },
    ],
  })
  const provider = new DatabasePersonaProvider({ personaStore })

  assert.equal((await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })).content, 'user persona')
  assert.equal((await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '7',
  })).content, 'session persona')
  assert.equal((await provider.resolve({
    sessionId: 'qq-group:2000',
    senderId: '7',
  })).content, 'default persona')
  store.close()
})
