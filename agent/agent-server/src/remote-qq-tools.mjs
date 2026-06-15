import { randomUUID } from 'node:crypto'

export class RemoteToolBridge {
  constructor({
    createRequestId = () => randomUUID(),
    timeoutMs = 30_000,
  } = {}) {
    this.createRequestId = createRequestId
    this.timeoutMs = timeoutMs
    this.clientsBySessionId = new Map()
    this.pending = new Map()
  }

  registerClient(sessionId, client) {
    if (!sessionId || !client) return
    this.clientsBySessionId.set(sessionId, client)
  }

  async callTool(toolName, input, context = {}) {
    const client = this.clientsBySessionId.get(context.sessionId)
    if (!client) {
      return { error: `No bridge client is connected for session: ${context.sessionId ?? 'missing'}` }
    }

    const requestId = this.createRequestId()
    const request = {
      type: 'tool_request',
      requestId,
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
      toolName,
      input,
      context: {
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
        senderId: context.senderId,
        messageId: context.messageId,
        metadata: context.metadata ?? {},
      },
    }

    return await new Promise(resolve => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ error: `Remote QQ tool timed out: ${toolName}` })
      }, this.timeoutMs)
      this.pending.set(requestId, {
        resolve,
        timeout,
      })
      client.send(request)
    })
  }

  acceptResult(message) {
    const requestId = message?.requestId
    const pending = requestId ? this.pending.get(requestId) : null
    if (!pending) return false

    clearTimeout(pending.timeout)
    this.pending.delete(requestId)
    if (message.ok === false) {
      pending.resolve({ error: message.error ?? 'Remote QQ tool failed' })
      return true
    }
    pending.resolve(message.result ?? {})
    return true
  }
}

export function createRemoteQqTools({ bridge }) {
  return [
    {
      name: 'get_group_info',
      description: 'Read QQ group profile information through the connected NoneBot bridge.',
      group: 'qq',
      readOnly: true,
      requiresPermission: false,
      riskLevel: 'low',
      activationRule: input => input.metadata?.platform === 'qq',
      inputSchema: {
        type: 'object',
        properties: {
          groupId: { type: 'string' },
        },
        additionalProperties: false,
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input, context) => bridge.callTool('get_group_info', input, context),
    },
    {
      name: 'get_user_info',
      description: 'Read QQ user profile information through the connected NoneBot bridge.',
      group: 'qq',
      readOnly: true,
      requiresPermission: false,
      riskLevel: 'low',
      activationRule: input => input.metadata?.platform === 'qq',
      inputSchema: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
        },
        additionalProperties: false,
      },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      call: async (input, context) => bridge.callTool('get_user_info', input, context),
    },
    {
      name: 'send_message',
      description: 'Send a QQ message to the current or explicitly selected chat.',
      group: 'qq',
      readOnly: false,
      requiresPermission: true,
      riskLevel: 'medium',
      activationRule: input => input.metadata?.platform === 'qq',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          messageType: { type: 'string', enum: ['group', 'private'] },
          groupId: { type: 'string' },
          userId: { type: 'string' },
          chat: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['group', 'private'] },
              groupId: { type: 'string' },
              userId: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      call: async (input, context) => bridge.callTool('send_message', input, context),
    },
    {
      name: 'reply_message',
      description: 'Reply to a QQ message in the current or explicitly selected chat.',
      group: 'qq',
      readOnly: false,
      requiresPermission: true,
      riskLevel: 'medium',
      activationRule: input => input.metadata?.platform === 'qq',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          messageId: { type: 'string' },
          messageType: { type: 'string', enum: ['group', 'private'] },
          groupId: { type: 'string' },
          userId: { type: 'string' },
          chat: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['group', 'private'] },
              groupId: { type: 'string' },
              userId: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      call: async (input, context) => bridge.callTool('reply_message', input, context),
    },
  ]
}
