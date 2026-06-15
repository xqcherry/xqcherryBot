export function createRecentMessagesTool({ sessionStore, defaultLimit = 20, maxLimit = 50 }) {
  return {
    name: 'get_recent_messages',
    description: 'Read recent raw chat messages from the current session.',
    readOnly: true,
    requiresPermission: false,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input, context) => {
      const requested = Number.isFinite(input.limit) ? Math.floor(input.limit) : defaultLimit
      const limit = Math.max(1, Math.min(maxLimit, requested))
      const messages = await sessionStore.getRecentPlatformMessages(context.sessionId, limit)
      return {
        messages: messages.map(message => ({
          messageId: message.messageId ?? null,
          senderId: message.senderId ?? null,
          text: message.text ?? '',
          timestamp: message.timestamp ?? null,
        })),
      }
    },
  }
}

export function createActiveMemoriesTool({ sessionStore }) {
  return {
    name: 'get_active_memories',
    description: 'Read active long-term memories for the current session and sender.',
    readOnly: true,
    requiresPermission: false,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (_input, context) => {
      const sessionMemories = sessionStore.listActiveMemories
        ? await sessionStore.listActiveMemories({
            scope: 'session',
            subjectId: context.sessionId,
          })
        : []
      const userMemories =
        context.senderId && sessionStore.listActiveMemories
          ? await sessionStore.listActiveMemories({
              scope: 'user',
              subjectId: context.senderId,
            })
          : []
      return {
        memories: [...sessionMemories, ...userMemories].map(memory => ({
          id: memory.id,
          scope: memory.scope,
          subjectId: memory.subjectId,
          summary: memory.summary,
          status: memory.status,
        })),
      }
    },
  }
}

export function createSearchChatHistoryTool({ sessionStore, defaultLimit = 20, maxLimit = 20 }) {
  return {
    name: 'search_chat_history',
    description: 'Search raw chat message history in the current session by text.',
    readOnly: true,
    requiresPermission: false,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        senderId: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input, context) => {
      const requested = Number.isFinite(input.limit) ? Math.floor(input.limit) : defaultLimit
      const limit = Math.max(1, Math.min(maxLimit, requested))
      const messages = sessionStore.searchPlatformMessages
        ? await sessionStore.searchPlatformMessages(context.sessionId, {
            query: input.query,
            limit,
            senderId: input.senderId,
          })
        : []
      return {
        messages: messages.map(message => ({
          messageId: message.messageId ?? null,
          senderId: message.senderId ?? null,
          text: message.text ?? '',
          timestamp: message.timestamp ?? null,
        })),
      }
    },
  }
}
