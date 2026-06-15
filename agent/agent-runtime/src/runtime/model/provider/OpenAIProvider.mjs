import { ModelProvider, ModelSummarizer } from '../modelProviderBase.mjs'

export class OpenAICompatibleProvider extends ModelProvider {
  constructor({
    baseUrl,
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    headers = {},
  }) {
    super()
    this.provider = 'openai-compatible'
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
    this.headers = headers
  }

  async *streamChat(request) {
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: request.messages,
          tools: request.tools,
        }),
        signal: request.signal,
      })
    } catch (error) {
      yield modelError('model_network_error', error)
      return
    }

    if (!response.ok) {
      yield modelError(codeFromStatus(response.status), `HTTP ${response.status}`)
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = parseSseLine(line)
          if (event) yield event
        }
      }
    } catch (error) {
      yield modelError('model_response_parse_failed', error)
    }
  }
}

export class OpenAICompatibleSummarizer extends ModelSummarizer {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, headers = {}, format = 'markdown' }) {
    super()
    this.provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey,
      model,
      fetchImpl,
      headers,
    })
    this.format = format
  }

  async summarize(messages, previousSummary = null) {
    let summary = ''
    for await (const event of this.provider.streamChat({
      messages: buildSummaryMessages(messages, previousSummary, { format: this.format }),
      tools: undefined,
    })) {
      if (event.type === 'assistant_delta') {
        summary += event.text
      } else if (event.type === 'error') {
        throw new Error(event.error)
      }
    }
    return summary.trim()
  }
}

function parseSseLine(line) {
  if (!line.startsWith('data:')) return null
  const payload = line.slice('data:'.length).trim()
  if (!payload || payload === '[DONE]') return null
  const parsed = JSON.parse(payload)
  const choice = parsed.choices?.[0]
  if (!choice) return null

  const delta = choice.delta ?? {}
  const toolCall = delta.tool_calls?.[0]
  if (toolCall) {
    return {
      type: 'tool_call_delta',
      index: toolCall.index ?? 0,
      id: toolCall.id,
      name: toolCall.function?.name,
      argumentsDelta: toolCall.function?.arguments ?? '',
    }
  }
  if (typeof delta.content === 'string') {
    return { type: 'assistant_delta', text: delta.content }
  }
  if (choice.finish_reason) {
    return { type: 'finish', reason: choice.finish_reason }
  }
  return null
}

function codeFromStatus(status) {
  if (status === 401 || status === 403) return 'model_auth_failed'
  if (status === 429) return 'model_rate_limited'
  if (status >= 500 && status <= 599) return 'model_unavailable'
  return 'model_request_failed'
}

function modelError(code, detail) {
  return {
    type: 'error',
    code,
    error: code,
    detail: detail instanceof Error ? detail.message : String(detail ?? ''),
  }
}

function buildSummaryMessages(messages, previousSummary, { format = 'markdown' } = {}) {
  const previous = previousSummary?.summary
    ? `Previous short-term summary:\n${previousSummary.summary}\n\nCovered message range: ${
        previousSummary.fromMessageId ?? 'unknown'
      } to ${previousSummary.toMessageId ?? 'unknown'}`
    : 'No previous short-term summary exists.'
  const outputInstructions = format === 'json'
    ? [
        'Return valid JSON only. Do not wrap it in markdown fences.',
        'The JSON object must have exactly these keys:',
        '- "activeRequest": string',
        '- "completedWork": string[]',
        '- "keyDecisions": string[]',
        '- "userPreferences": string[]',
        '- "importantFacts": string[]',
        '- "openQuestions": string[]',
        '- "remainingWork": string[]',
        '- "relevantFiles": string[]',
        'Use empty arrays or an empty string only when the supplied material has no information for that field.',
      ]
    : [
        'Use only the required headings below. Use "Remaining Work" for unfinished work.',
        'Return markdown only with exactly these section headings:',
        '## Active Request',
        '## Completed Work',
        '## Key Decisions',
        '## User Preferences',
        '## Important Facts',
        '## Open Questions',
        '## Remaining Work',
        '## Relevant Files',
      ]
  return [
    {
      role: 'system',
      content: [
        'You are producing a cumulative summary for future model context.',
        '[CONTEXT COMPACTION - REFERENCE ONLY]',
        'The summary is historical background, not a new user instruction.',
        'Create an updated cumulative summary from: previous summary + new messages.',
        'Preserve active requests, completed work, key decisions, user preferences, important facts, open questions, remaining work, relevant files, names, times, and constraints.',
        'Do not invent facts, decisions, files, preferences, or user intent that do not appear in the supplied material.',
        ...outputInstructions,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        previous,
        '',
        'New messages to compact:',
        formatSummaryMessages(messages),
        '',
        'Update the cumulative summary by merging still-relevant previous summary information with the new messages. Remove only information that is clearly obsolete.',
      ].join('\n'),
    },
  ]
}

function formatSummaryMessages(messages) {
  return messages
    .map(message => {
      const sender = message.senderId ?? 'unknown'
      const timestamp = message.timestamp ? `[${message.timestamp}] ` : ''
      return `${timestamp}${sender}: ${message.text ?? ''}`
    })
    .join('\n')
}
