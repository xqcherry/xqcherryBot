export class OpenAICompatibleProvider {
  constructor({
    baseUrl,
    apiKey,
    model,
    fetchImpl = globalThis.fetch,
    headers = {},
  }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
    this.model = model
    this.fetchImpl = fetchImpl
    this.headers = headers
  }

  async *streamChat(request) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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

    if (!response.ok) {
      yield {
        type: 'error',
        error: `OpenAI-compatible backend returned ${response.status}`,
      }
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseSseLine(line)
        if (event) yield event
      }
    }
  }
}

export class OpenAICompatibleSummarizer {
  constructor({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, headers = {} }) {
    this.provider = new OpenAICompatibleProvider({
      baseUrl,
      apiKey,
      model,
      fetchImpl,
      headers,
    })
  }

  async summarize(messages, previousSummary = null) {
    let summary = ''
    for await (const event of this.provider.streamChat({
      messages: buildSummaryMessages(messages, previousSummary),
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

function buildSummaryMessages(messages, previousSummary) {
  const previous = previousSummary?.summary
    ? `Previous short-term summary:\n${previousSummary.summary}\n\nCovered message range: ${
        previousSummary.fromMessageId ?? 'unknown'
      } to ${previousSummary.toMessageId ?? 'unknown'}`
    : 'No previous short-term summary exists.'
  return [
    {
      role: 'system',
      content:
        'Summarize older chat messages for future context. Preserve concrete facts, decisions, names, times, unresolved questions, and user preferences. Be concise.',
    },
    {
      role: 'user',
      content: `${previous}\n\nNew messages to compact:\n${formatSummaryMessages(messages)}`,
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
