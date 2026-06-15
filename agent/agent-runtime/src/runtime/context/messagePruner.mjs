const DEFAULT_MAX_TEXT_LENGTH = 4000
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 1200

export class MessagePruner {
  constructor({
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    maxToolResultLength = DEFAULT_MAX_TOOL_RESULT_LENGTH,
    collapseDuplicates = true,
  } = {}) {
    this.maxTextLength = maxTextLength
    this.maxToolResultLength = maxToolResultLength
    this.collapseDuplicates = collapseDuplicates
  }

  prune(messages = []) {
    const seen = new Map()
    const pruned = []
    let changed = false

    for (const message of messages) {
      const normalized = normalizeText(message.text ?? message.content ?? '')
      if (this.collapseDuplicates && normalized) {
        const duplicate = seen.get(normalized)
        if (duplicate) {
          duplicate.count += 1
          duplicate.lastMessageId = message.messageId ?? duplicate.lastMessageId
          changed = true
          continue
        }
        seen.set(normalized, {
          count: 1,
          lastMessageId: message.messageId ?? null,
          outputIndex: pruned.length,
        })
      }

      const next = this.#pruneMessage(message)
      if (next !== message) changed = true
      pruned.push(next)
    }

    if (this.collapseDuplicates) {
      for (const duplicate of seen.values()) {
        if (duplicate.count <= 1) continue
        const message = pruned[duplicate.outputIndex]
        pruned[duplicate.outputIndex] = {
          ...message,
          text: appendPruneNote(
            message.text ?? message.content ?? '',
            `[duplicate message collapsed: repeated ${duplicate.count} times, lastMessageId=${duplicate.lastMessageId ?? 'unknown'}]`,
          ),
          metadata: {
            ...(message.metadata ?? {}),
            prunedDuplicateCount: duplicate.count,
          },
        }
      }
    }

    return {
      messages: pruned,
      changed,
      originalCount: messages.length,
      prunedCount: pruned.length,
    }
  }

  #pruneMessage(message) {
    const text = message.text ?? message.content
    if (typeof text !== 'string') return message

    let nextText = pruneAttachmentPlaceholders(text)
    const isToolLike = isToolLikeMessage(message, nextText)
    const maxLength = isToolLike ? this.maxToolResultLength : this.maxTextLength
    nextText = truncateText(nextText, maxLength)

    if (nextText === text) return message
    return {
      ...message,
      text: nextText,
      metadata: {
        ...(message.metadata ?? {}),
        prunedForSummary: true,
        originalTextLength: text.length,
      },
    }
  }
}

export function pruneMessagesForSummary(messages, options) {
  return new MessagePruner(options).prune(messages)
}

function truncateText(text, maxLength) {
  if (!maxLength || text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n[pruned ${text.length - maxLength} chars]`
}

function pruneAttachmentPlaceholders(text) {
  return text
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]{80,}/g, '[summary-pruned: base64 attachment]')
    .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|zip|pdf)(?:\?\S*)?/gi, '[summary-pruned: attachment url]')
}

function isToolLikeMessage(message, text) {
  if (message.role === 'tool' || message.toolCallId || message.tool_call_id) return true
  if (message.name && /tool|search|call|result/i.test(message.name)) return true
  return /^\s*(?:\{|\[)/.test(text) && /"result"|"error"|"items"|"data"/.test(text)
}

function normalizeText(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

function appendPruneNote(text, note) {
  return `${text}\n${note}`
}
