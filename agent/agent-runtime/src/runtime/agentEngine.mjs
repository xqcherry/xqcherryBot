import { randomUUID } from 'node:crypto'

import { getDefaultSystemPrompt } from './prompt/defaultPrompts.mjs'
import { findTool, buildToolDefinitions, isToolReadOnly } from './tools/toolSchema.mjs'
import { ToolRegistry, ToolSelector } from './tools/toolRegistry.mjs'

export class AgentEngine {
  constructor({
    modelProvider,
    tools = [],
    toolSelector = null,
    sessionStore,
    permissionManager,
    systemPrompt = getDefaultSystemPrompt(),
    contextEngine = null,
    maxTurns = 8,
    turnTimeoutMs = 120_000,
  }) {
    this.modelProvider = modelProvider
    this.tools = tools
    this.toolSelector = toolSelector ?? new ToolSelector({
      registry: new ToolRegistry(tools),
    })
    this.sessionStore = sessionStore
    this.permissionManager = permissionManager
    this.systemPrompt = systemPrompt
    this.contextEngine = contextEngine
    this.maxTurns = maxTurns
    this.turnTimeoutMs = turnTimeoutMs
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
    const timeout = this.turnTimeoutMs > 0
      ? setTimeout(() => abortController.abort('timeout'), this.turnTimeoutMs)
      : null

    let finalText = ''

    try {
      const session = await this.sessionStore.getOrCreateSession(
        sessionId,
        metadata,
      )
      const priorMessages = [...session.messages]
      const userMessage = { role: 'user', content: text }
      const initialSelectedTools = this.#selectTools({
        sessionId,
        text,
        senderId,
        messageId,
        metadata,
        turn: 0,
      })
      let messages = this.contextEngine
        ? (await this.contextEngine.build({
            sessionId,
            systemPrompt: this.systemPrompt,
            text,
            senderId,
            messageId,
            metadata,
            selectedTools: initialSelectedTools,
          })).messages
        : [
            { role: 'system', content: this.systemPrompt },
            ...priorMessages,
            userMessage,
          ]
      yield stageEvent(sessionId, 'context_built')
      await this.sessionStore.appendMessages(sessionId, [userMessage])
      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        const selectedTools = turn === 0
          ? initialSelectedTools
          : this.#selectTools({
              sessionId,
              text,
              senderId,
              messageId,
              metadata,
              turn,
            })
        const assistantTextParts = []
        const toolCallsByIndex = new Map()
        let finishReason = null

        yield stageEvent(sessionId, 'model_running')
        for await (const event of this.modelProvider.streamChat({
          sessionId,
          messages: [...messages],
          tools: buildToolDefinitions(selectedTools),
          signal: abortController.signal,
        })) {
          if (abortController.signal.aborted) {
            yield timeoutOrInterruptError(sessionId, abortController)
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
            yield { ...event, sessionId, error: event.error }
            return
          }
        }
        if (abortController.signal.aborted) {
          yield timeoutOrInterruptError(sessionId, abortController)
          return
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
          yield stageEvent(sessionId, 'finalizing')
          yield { type: 'final_result', sessionId, result: finalText }
          yield stageEvent(sessionId, 'completed')
          return
        }

        yield stageEvent(sessionId, 'tool_running')
        const toolResultMessages = []
        for (const call of toolCalls) {
          const execution = await this.#executeToolCall(
            { sessionId, senderId, messageId, metadata },
            call,
            selectedTools,
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
      if (timeout) clearTimeout(timeout)
      this.abortControllers.delete(sessionId)
    }
  }

  interrupt(sessionId) {
    this.abortControllers.get(sessionId)?.abort()
  }

  respondToPermission(response) {
    return this.permissionManager.respond(response)
  }

  #selectTools(input) {
    return this.toolSelector.select(input)
  }

  async #executeToolCall(context, call, selectedTools) {
    const { sessionId, metadata } = context
    const selectedTool = findTool(selectedTools, call.name)
    const registeredTool = findTool(this.tools, call.name)
    const input = parseToolInput(call.argumentsText)

    if (!registeredTool) {
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

    if (!selectedTool) {
      return {
        events: [],
        message: Promise.resolve({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ error: `Tool not exposed this turn: ${call.name}` }),
        }),
      }
    }

    const tool = selectedTool
    if (!isToolReadOnly(tool, input)) {
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

function stageEvent(sessionId, stage) {
  return { type: 'turn_stage', sessionId, stage }
}

function timeoutOrInterruptError(sessionId, abortController) {
  return {
    type: 'error',
    sessionId,
    error: abortController.signal.reason === 'timeout' ? 'Agent turn timed out' : 'Interrupted',
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
