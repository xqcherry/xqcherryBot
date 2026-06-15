export class TurnProfileBuilder {
  build(input = {}) {
    const metadata = input.metadata ?? {}
    const platform = metadata.platform ?? 'qq'
    const chatType = metadata.chatType ?? inferChatType(input.sessionId, metadata)
    const toolCapabilities = normalizeToolCapabilities(input.selectedTools)
    const latestToolFailure = input.latestToolFailure ?? input.failureState ?? ''

    return {
      platform,
      chatType,
      addressedToAgent: Boolean(metadata.addressedToAgent ?? chatType === 'private'),
      toolCapabilities,
      hasToolFailure: hasFailure(latestToolFailure),
      memoryIntent: detectMemoryIntent(input.text),
      sessionId: input.sessionId,
      senderId: input.senderId,
      messageId: input.messageId,
      text: input.text ?? '',
    }
  }
}

function inferChatType(sessionId, metadata) {
  if (metadata.groupId || String(sessionId ?? '').includes('group')) return 'group'
  return 'private'
}

function normalizeToolCapabilities(selectedTools = []) {
  return selectedTools.map(tool => tool.name).filter(Boolean)
}

function hasFailure(value) {
  if (!value || value === 'none') return false
  return true
}

function detectMemoryIntent(text = '') {
  return /(?:我(?:喜欢|偏好|习惯|希望|需要)|以后|下次|记住|remember|prefer|preference|always|never)/i.test(text)
}
