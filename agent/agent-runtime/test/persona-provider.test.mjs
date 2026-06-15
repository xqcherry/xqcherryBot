import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  FilePersonaProvider,
  PromptManager,
} from '../src/index.mjs'

async function writePersonaConfig(payload) {
  const dir = await mkdtemp(join(tmpdir(), 'persona-provider-'))
  const filePath = join(dir, 'current.json')
  await writeFile(filePath, JSON.stringify(payload, null, 2))
  return filePath
}

test('file persona provider resolves user binding before session binding', async () => {
  const filePath = await writePersonaConfig({
    defaultPersonaKey: 'default_friend',
    personas: [
      {
        personaKey: 'session_friend',
        name: 'Session Friend',
        description: '',
        content: 'session persona',
      },
      {
        personaKey: 'user_friend',
        name: 'User Friend',
        description: '',
        content: 'user persona',
      },
      {
        personaKey: 'default_friend',
        name: 'Default Friend',
        description: '',
        content: 'default persona',
      },
    ],
    bindings: [
      { scope: 'session', subjectId: 'qq-group:1000', personaKey: 'session_friend' },
      { scope: 'user', subjectId: '42', personaKey: 'user_friend' },
    ],
  })
  const provider = new FilePersonaProvider({ filePath })

  const persona = await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })

  assert.deepEqual(persona, {
    source: 'user_binding',
    personaKey: 'user_friend',
    name: 'User Friend',
    content: 'user persona',
    description: '',
  })
})

test('file persona provider resolves session binding before default persona', async () => {
  const filePath = await writePersonaConfig({
    defaultPersonaKey: 'default_friend',
    personas: [
      {
        personaKey: 'session_friend',
        name: 'Session Friend',
        description: '',
        content: 'session persona',
      },
      {
        personaKey: 'default_friend',
        name: 'Default Friend',
        description: '',
        content: 'default persona',
      },
    ],
    bindings: [
      { scope: 'session', subjectId: 'qq-group:1000', personaKey: 'session_friend' },
    ],
  })
  const provider = new FilePersonaProvider({ filePath })

  const persona = await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '7',
  })

  assert.equal(persona.source, 'session_binding')
  assert.equal(persona.personaKey, 'session_friend')
})

test('file persona provider falls back to CHAT_PERSONA prompt when no persona matches', async () => {
  const filePath = await writePersonaConfig({
    defaultPersonaKey: null,
    personas: [],
    bindings: [],
  })
  const promptManager = new PromptManager({
    fallbackPrompts: {
      CHAT_PERSONA: {
        promptKey: 'CHAT_PERSONA',
        name: 'Chat Persona',
        description: 'fallback persona',
        systemPrompt: 'chat persona content',
        userPrompt: '',
        extraJson: null,
        fallback: true,
      },
    },
  })
  const provider = new FilePersonaProvider({ filePath, promptManager })

  const persona = await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })

  assert.deepEqual(persona, {
    source: 'chat_persona',
    personaKey: 'CHAT_PERSONA',
    name: 'Chat Persona',
    content: 'chat persona content',
    description: 'fallback persona',
  })
})

test('file persona provider ignores invalid persona references and continues fallback', async () => {
  const filePath = await writePersonaConfig({
    defaultPersonaKey: 'missing_default',
    personas: [
      {
        personaKey: 'real_persona',
        name: 'Real Persona',
        description: '',
        content: 'real content',
      },
    ],
    bindings: [
      { scope: 'user', subjectId: '42', personaKey: 'missing_user_persona' },
    ],
  })
  const provider = new FilePersonaProvider({ filePath })

  const persona = await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })

  assert.equal(persona.source, 'fallback')
  assert.equal(persona.personaKey, 'CHAT_PERSONA')
})

test('file persona provider falls back when config file is missing', async () => {
  const provider = new FilePersonaProvider({
    filePath: join(tmpdir(), 'missing-personas-current.json'),
  })

  const persona = await provider.resolve({
    sessionId: 'qq-group:1000',
    senderId: '42',
  })

  assert.equal(persona.source, 'fallback')
  assert.equal(persona.personaKey, 'CHAT_PERSONA')
})
