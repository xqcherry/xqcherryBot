export class AgentProtocolServer {
  constructor({ engine, messageStore = engine.sessionStore, forwardDeltas = false }) {
    this.engine = engine
    this.messageStore = messageStore
    this.forwardDeltas = forwardDeltas
    this.sessionQueues = new Map()
  }

  async receive(client, message) {
    try {
      switch (message?.type) {
        case 'observed_message':
          await this.#handleObservedMessage(message)
          return
        case 'user_message':
          await this.#enqueueUserMessage(client, message)
          return
        case 'permission_response':
          this.engine.respondToPermission?.({
            sessionId: message.sessionId,
            toolCallId: message.toolCallId,
            decision: message.decision,
            reason: message.reason,
            responderId: message.responderId,
          })
          return
        case 'interrupt':
          this.engine.interrupt(message.sessionId)
          return
        default:
          send(client, {
            type: 'error',
            error: `Unsupported inbound message: ${message?.type ?? 'missing'}`,
          })
      }
    } catch (error) {
      send(client, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async #handleUserMessage(client, message) {
    if (!message.sessionId) {
      throw new Error('user_message requires sessionId')
    }

    const rawText = message.rawText ?? message.text ?? ''
    const agentText = stripAgentPrefix(message.text ?? rawText)
    await this.#storePlatformMessage({ ...message, text: rawText })
    const turn = await this.messageStore?.appendAgentTurn?.({
      sessionId: message.sessionId,
      messageId: message.messageId ?? null,
      senderId: message.senderId ?? null,
      rawText,
      text: agentText,
      status: 'running',
      metadata: message.metadata ?? {},
      createdAt: new Date().toISOString(),
    })

    let finalResult = ''
    try {
      for await (const event of this.engine.submitUserMessage(
        compactObject({
          sessionId: message.sessionId,
          text: agentText,
          senderId: message.senderId,
          messageId: message.messageId,
          metadata: message.metadata ?? {},
        }),
      )) {
        if (event.type === 'assistant_delta' && !this.forwardDeltas) {
          continue
        }
        const outbound = { ...event }
        if (event.type === 'final_result') {
          finalResult = event.result
          outbound.replyToMessageId = message.messageId
        }
        send(client, outbound)
      }
      if (turn?.id) {
        await this.messageStore?.updateAgentTurn?.(turn.id, {
          status: 'completed',
          result: finalResult,
          completedAt: new Date().toISOString(),
        })
      }
    } catch (error) {
      if (turn?.id) {
        await this.messageStore?.updateAgentTurn?.(turn.id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date().toISOString(),
        })
      }
      throw error
    }
  }

  async #enqueueUserMessage(client, message) {
    if (!message.sessionId) {
      throw new Error('user_message requires sessionId')
    }
    const previous = this.sessionQueues.get(message.sessionId) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => {
      release = resolve
    })
    const queued = previous.then(() => current)
    this.sessionQueues.set(message.sessionId, queued)

    await previous
    try {
      await this.#handleUserMessage(client, message)
    } finally {
      release()
      if (this.sessionQueues.get(message.sessionId) === queued) {
        this.sessionQueues.delete(message.sessionId)
      }
    }
  }

  async #handleObservedMessage(message) {
    if (!message.sessionId) {
      throw new Error('observed_message requires sessionId')
    }
    await this.#storePlatformMessage(message)
  }

  async #storePlatformMessage(message) {
    await this.messageStore?.appendPlatformMessage?.({
      sessionId: message.sessionId,
      messageId: message.messageId ?? null,
      senderId: message.senderId ?? null,
      text: message.text ?? '',
      timestamp: message.timestamp ?? new Date().toISOString(),
      metadata: message.metadata ?? {},
    })
  }
}

function send(client, event) {
  client.send(event)
}

function stripAgentPrefix(text, prefix = '#agent') {
  if (typeof text !== 'string') return ''
  if (!text.startsWith(prefix)) return text
  return text.slice(prefix.length).trimStart()
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([_key, value]) => value !== undefined),
  )
}
