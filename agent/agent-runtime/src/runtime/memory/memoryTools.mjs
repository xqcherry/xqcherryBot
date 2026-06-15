export function createMemoryCandidateTool({ sessionStore }) {
  return {
    name: 'propose_memory_candidate',
    description:
      'Propose a long-term memory candidate. Candidates are stored for later audit and are not active memories by default.',
    readOnly: true,
    requiresPermission: false,
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'user'] },
        subjectId: { type: 'string' },
        summary: { type: 'string' },
        evidenceMessageIds: {
          type: 'array',
          items: { type: 'string' },
        },
        confidence: { type: 'number' },
      },
      required: ['scope', 'subjectId', 'summary', 'evidenceMessageIds', 'confidence'],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input, context) => {
      const stored = await sessionStore.appendMemoryCandidate({
        sessionId: context.sessionId,
        scope: input.scope,
        subjectId: input.subjectId,
        summary: input.summary,
        evidenceMessageIds: input.evidenceMessageIds ?? [],
        confidence: input.confidence,
        createdByMessageId: context.messageId ?? null,
        createdBySenderId: context.senderId ?? null,
        metadata: {
          ...(context.metadata ?? {}),
          sourceSessionId: context.sessionId,
          sourceSenderId: context.senderId ?? null,
          evidenceMessageIds: input.evidenceMessageIds ?? [],
          confidence: input.confidence,
        },
        sourceMessageId: context.messageId ?? null,
        createdBy: context.senderId ?? null,
      })
      return {
        id: stored.id,
        status: stored.status,
      }
    },
  }
}
