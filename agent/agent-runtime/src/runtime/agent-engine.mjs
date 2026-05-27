import { randomUUID } from 'node:crypto'

import { findTool, buildToolDefinitions } from './tool-schema.mjs'

const DEFAULT_SYSTEM_PROMPT =
  'You are an agent connected through a generic session protocol. Use read-only tools freely. Ask permission before side-effect tools.'

export class AgentEngine {
  constructor({
    modelProvider,
    tools,
    sessionStore,
    permissionManager,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    contextBuilder = null,
    maxTurns = 8,
  }) {
    this.modelProvider = modelProvider
    this.tools = tools
    this.sessionStore = sessionStore
    this.permissionManager = permissionManager
    this.systemPrompt = systemPrompt
    this.contextBuilder = contextBuilder
    this.maxTurns = maxTurns
    this.abortControllers = new Map()
  }

  async *submitUserMessage({
    sessionId,
    text,
    senderId = undefined,
    messageId = undefined,
    metadata = {},
  }) {
    const abortController = new AbortController()
    this.abortControllers.set(sessionId, abortController)

    const session = await this.sessionStore.getOrCreateSession(
      sessionId,
      metadata,
    )
    const priorMessages = [...session.messages]
    const userMessage = { role: 'user', content: text }
    let messages = this.contextBuilder
      ? await this.contextBuilder.build({
          sessionId,
          systemPrompt: this.systemPrompt,
          text,
          senderId,
          messageId,
          metadata,
        })
      : [
          { role: 'system', content: this.systemPrompt },
          ...priorMessages,
          userMessage,
        ]
    await this.sessionStore.appendMessages(sessionId, [userMessage])
    let finalText = ''

    try {
      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        const assistantTextParts = []
        const toolCallsByIndex = new Map()
        let finishReason = null

        for await (const event of this.modelProvider.streamChat({
          sessionId,
          messages: [...messages],
          tools: buildToolDefinitions(this.tools),
          signal: abortController.signal,
        })) {
          if (abortController.signal.aborted) {
            yield { type: 'error', sessionId, error: 'Interrupted' }
            return
          }

          if (event.type === 'assistant_delta') {
            assistantTextParts.push(event.text)
            finalText += event.text
            yield {
              type: 'assistant_delta',
              sessionId,
              delta: event.text,
            }
          } else if (event.type === 'tool_call_delta') {
            mergeToolCallDelta(toolCallsByIndex, event)
          } else if (event.type === 'finish') {
            finishReason = event.reason
          } else if (event.type === 'error') {
            yield { type: 'error', sessionId, error: event.error }
            return
          }
        }

        const toolCalls = Array.from(toolCallsByIndex.values())
        const assistantMessage = buildAssistantMessage(
          assistantTextParts.join(''),
          toolCalls,
        )
        if (assistantMessage) {
          await this.sessionStore.appendMessages(sessionId, [assistantMessage])
          messages.push(assistantMessage)
        }

        if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
          yield { type: 'final_result', sessionId, result: finalText }
          return
        }

        const toolResultMessages = []
        for (const call of toolCalls) {
          const execution = await this.#executeToolCall(
            { sessionId, senderId, messageId, metadata },
            call,
          )
          yield* execution.events
          toolResultMessages.push(await execution.message)
        }

        await this.sessionStore.appendMessages(sessionId, toolResultMessages)
        messages.push(...toolResultMessages)
      }

      yield {
        type: 'error',
        sessionId,
        error: `Reached maximum number of turns (${this.maxTurns})`,
      }
    } finally {
      this.abortControllers.delete(sessionId)
    }
  }

  interrupt(sessionId) {
    this.abortControllers.get(sessionId)?.abort()
  }

  respondToPermission(response) {
    return this.permissionManager.respond(response)
  }

  async #executeToolCall(context, call) {
    const { sessionId, metadata } = context
    const tool = findTool(this.tools, call.name)
    const input = parseToolInput(call.argumentsText)

    if (!tool) {
      return {
        events: [],
        message: Promise.resolve({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        }),
      }
    }

    if (!tool.isReadOnly(input)) {
      const { request, response } = this.permissionManager.createRequest({
        sessionId,
        toolCallId: call.id,
        toolName: tool.name,
        input,
      })
      await this.sessionStore.appendPermissionAudit(sessionId, {
        ...request,
        createdAt: new Date().toISOString(),
      })

      const permissionEvent = { ...request }
      const decisionPromise = response
      return await this.#resumeAfterPermission({
        sessionId,
        call,
        tool,
        input,
        permissionEvent,
        decisionPromise,
        context,
      })
    }

    return await this.#runAllowedTool({ context, call, tool, input })
  }

  async #resumeAfterPermission({
    sessionId,
    call,
    tool,
    input,
    permissionEvent,
    decisionPromise,
    context,
  }) {
    async function* eventsAfterDecision(engine) {
      yield permissionEvent
      const decision = await decisionPromise
      await engine.sessionStore.appendPermissionAudit(sessionId, decision)

      if (decision.decision !== 'allow') {
        const result = {
          error: 'Permission denied',
          reason: decision.reason ?? null,
        }
        return {
          events: [],
          message: toolResultMessage(call, tool.name, result),
        }
      }

      return await engine.#runAllowedTool({ context, call, tool, input })
    }

    const eventIterator = eventsAfterDecision(this)
    const first = await eventIterator.next()
    const remaining = eventIterator.next()
    return {
      events: yieldableEvents(first.value, remaining),
      message: awaitMessageFromPermission(remaining),
    }
  }

  async #runAllowedTool({ context, call, tool, input }) {
    const { sessionId } = context
    const started = {
      type: 'tool_call_started',
      sessionId,
      toolCallId: call.id,
      toolName: tool.name,
      input,
    }
    const result = await tool.call(input, {
      sessionId,
      toolCallId: call.id,
      senderId: context.senderId,
      messageId: context.messageId,
      metadata: context.metadata,
    })
    const finished = {
      type: 'tool_call_finished',
      sessionId,
      toolCallId: call.id,
      toolName: tool.name,
      result,
    }
    await this.sessionStore.appendToolCall(sessionId, {
      id: call.id,
      name: tool.name,
      input,
      result,
      completedAt: new Date().toISOString(),
    })
    return {
      events: [started, finished],
      message: Promise.resolve(toolResultMessage(call, tool.name, result)),
    }
  }
}

function mergeToolCallDelta(toolCallsByIndex, event) {
  const key = event.index ?? 0
  const current =
    toolCallsByIndex.get(key) ?? {
      id: event.id ?? `call_${randomUUID()}`,
      name: event.name ?? '',
      argumentsText: '',
    }
  if (event.id) current.id = event.id
  if (event.name) current.name = event.name
  if (event.argumentsDelta) current.argumentsText += event.argumentsDelta
  toolCallsByIndex.set(key, current)
}

function buildAssistantMessage(text, toolCalls) {
  if (!text && toolCalls.length === 0) return null
  const message = { role: 'assistant', content: text }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.argumentsText,
      },
    }))
  }
  return message
}

function parseToolInput(argumentsText) {
  if (!argumentsText) return {}
  try {
    return JSON.parse(argumentsText)
  } catch (error) {
    return {
      __parse_error: error instanceof Error ? error.message : String(error),
      raw: argumentsText,
    }
  }
}

function toolResultMessage(call, name, result) {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name,
    content: JSON.stringify(result),
  }
}

function yieldableEvents(firstEvent, remainingPromise) {
  return {
    async *[Symbol.asyncIterator]() {
      yield firstEvent
      const completed = await remainingPromise
      yield* completed.value.events
    },
  }
}

async function awaitMessageFromPermission(remainingPromise) {
  const completed = await remainingPromise
  return completed.value.message
}
