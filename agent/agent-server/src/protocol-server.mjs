export class AgentProtocolServer {
  constructor({
    engine,
    messageStore = engine.sessionStore,
    forwardDeltas = false,
    logger = () => {},
    healthCheck = () => ({ ok: true }),
    backupStatus = () => null,
    remoteToolBridge = null,
  }) {
    this.engine = engine
    this.messageStore = messageStore
    this.forwardDeltas = forwardDeltas
    this.logger = logger
    this.healthCheck = healthCheck
    this.backupStatus = backupStatus
    this.remoteToolBridge = remoteToolBridge
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
          this.remoteToolBridge?.registerClient?.(message.sessionId, client)
          this.engine.respondToPermission?.({
            sessionId: message.sessionId,
            toolCallId: message.toolCallId,
            decision: message.decision,
            reason: message.reason,
            responderId: message.responderId,
          })
          return
        case 'tool_result':
          if (!this.remoteToolBridge?.acceptResult?.(message)) {
            send(client, {
              type: 'error',
              error: `Unknown tool_result requestId: ${message?.requestId ?? 'missing'}`,
            })
          }
          return
        case 'list_memory_candidates':
          await this.#handleListMemoryCandidates(client, message)
          return
        case 'activate_memory_candidate':
          await this.#handleActivateMemoryCandidate(client, message)
          return
        case 'delete_memory_candidate':
          await this.#handleDeleteMemoryCandidate(client, message)
          return
        case 'get_session_status':
          await this.#handleGetSessionStatus(client, message)
          return
        case 'get_agent_diag':
          await this.#handleGetAgentDiag(client, message)
          return
        case 'get_backup_status':
          await this.#handleGetBackupStatus(client, message)
          return
        case 'clear_session_summary':
          await this.#handleClearSessionSummary(client, message)
          return
        case 'clear_session_context':
          await this.#handleClearSessionContext(client, message)
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
    this.remoteToolBridge?.registerClient?.(message.sessionId, client)

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
    let sawError = false
    const startedAt = Date.now()
    let toolCount = 0
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
        if (event.type === 'turn_stage') {
          if (turn?.id) {
            await this.messageStore?.updateAgentTurn?.(turn.id, {
              stage: event.stage,
              updatedAt: new Date().toISOString(),
            })
          }
          this.logger({
            type: 'turn_stage',
            sessionId: message.sessionId,
            turnId: turn?.id,
            messageId: message.messageId,
            stage: event.stage,
          })
          continue
        }
        if (event.type === 'assistant_delta' && !this.forwardDeltas) {
          continue
        }
        const outbound = { ...event }
        if (event.type === 'final_result') {
          finalResult = event.result
          outbound.replyToMessageId = message.messageId
        }
        if (event.type === 'tool_call_finished') {
          toolCount += 1
        }
        if (event.type === 'error' && turn?.id) {
          sawError = true
          await this.messageStore?.updateAgentTurn?.(turn.id, {
            status: 'error',
            error: event.error,
            errorCode: event.code ?? event.error,
            completedAt: new Date().toISOString(),
          })
        }
        send(client, outbound)
      }
      if (turn?.id && !sawError) {
        await this.messageStore?.updateAgentTurn?.(turn.id, {
          status: 'completed',
          result: finalResult,
          durationMs: Date.now() - startedAt,
          toolCount,
          completedAt: new Date().toISOString(),
        })
      }
      this.logger({
        type: 'turn_completed',
        sessionId: message.sessionId,
        turnId: turn?.id,
        messageId: message.messageId,
        durationMs: Date.now() - startedAt,
        toolCount,
        status: sawError ? 'error' : 'completed',
      })
    } catch (error) {
      if (turn?.id) {
        await this.messageStore?.updateAgentTurn?.(turn.id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          toolCount,
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

  async #handleListMemoryCandidates(client, message) {
    const candidates = await this.messageStore?.listMemoryCandidates?.({
      scope: message.scope,
      subjectId: message.subjectId,
    })
    send(client, {
      type: 'memory_candidates_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      candidates: (candidates ?? []).filter(candidate => candidate.status !== 'deleted'),
    })
  }

  async #handleActivateMemoryCandidate(client, message) {
    if (!message.memoryId) {
      throw new Error('activate_memory_candidate requires memoryId')
    }
    const memory = await this.messageStore?.activateMemoryCandidate?.(message.memoryId, {
      approvedBy: message.responderId ?? message.senderId ?? null,
    })
    send(client, {
      type: 'memory_candidate_updated',
      requestId: message.requestId,
      sessionId: message.sessionId,
      action: 'activate',
      memoryId: message.memoryId,
      ok: Boolean(memory),
      memory: memory ?? null,
    })
  }

  async #handleDeleteMemoryCandidate(client, message) {
    if (!message.memoryId) {
      throw new Error('delete_memory_candidate requires memoryId')
    }
    const memory = await this.messageStore?.deleteMemoryCandidate?.(message.memoryId)
    send(client, {
      type: 'memory_candidate_updated',
      requestId: message.requestId,
      sessionId: message.sessionId,
      action: 'delete',
      memoryId: message.memoryId,
      ok: Boolean(memory),
      memory: memory ?? null,
    })
  }

  async #handleGetSessionStatus(client, message) {
    if (!message.sessionId) {
      throw new Error('get_session_status requires sessionId')
    }
    const status = await this.messageStore?.getSessionStatus?.(message.sessionId)
    const compactionStatus = this.#getCompactionStatus(message.sessionId)
    send(client, {
      type: 'session_status_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      status: status ? { ...status, compactionStatus } : null,
    })
  }

  async #handleGetAgentDiag(client, message) {
    if (!message.sessionId) {
      throw new Error('get_agent_diag requires sessionId')
    }
    const health = await this.healthCheck()
    const status = await this.messageStore?.getSessionStatus?.(message.sessionId)
    const compactionStatus = this.#getCompactionStatus(message.sessionId)
    send(client, {
      type: 'agent_diag_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      health,
      model: health?.model ?? null,
      dbPath: this.backupStatus()?.dbPath ?? null,
      latestTurn: status?.latestTurn ?? null,
      compactionStatus,
      toolNames: (this.engine.tools ?? []).map(tool => tool.name),
    })
  }

  async #handleGetBackupStatus(client, message) {
    send(client, {
      type: 'backup_status_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      status: this.backupStatus(),
    })
  }

  async #handleClearSessionSummary(client, message) {
    if (!message.sessionId) {
      throw new Error('clear_session_summary requires sessionId')
    }
    const result = await this.messageStore?.clearSessionSummary?.(message.sessionId)
    send(client, {
      type: 'session_reset_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      action: 'clear_summary',
      ok: Boolean(result),
      result: result ?? null,
    })
  }

  async #handleClearSessionContext(client, message) {
    if (!message.sessionId) {
      throw new Error('clear_session_context requires sessionId')
    }
    const result = await this.messageStore?.clearSessionContext?.(message.sessionId)
    send(client, {
      type: 'session_reset_result',
      requestId: message.requestId,
      sessionId: message.sessionId,
      action: 'clear_context',
      ok: Boolean(result),
      result: result ?? null,
    })
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

  #getCompactionStatus(sessionId) {
    return (
      this.engine.contextEngine?.compactionEngine?.getStatus?.(sessionId) ?? null
    )
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
