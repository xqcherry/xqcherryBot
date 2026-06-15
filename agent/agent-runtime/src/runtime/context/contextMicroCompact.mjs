export function microCompact(messages, { maxContentLength = 4000 } = {}) {
  return messages.map(message => {
    if (typeof message.content !== 'string') return message
    if (message.content.length <= maxContentLength) return message
    return {
      ...message,
      content: `${message.content.slice(0, maxContentLength)}\n[truncated]`,
    }
  })
}
