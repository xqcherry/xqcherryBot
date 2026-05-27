export class InMemoryPermissionManager {
  #pending = new Map()
  #now

  constructor(options = {}) {
    this.#now = options.now ?? (() => new Date())
  }

  createRequest({ sessionId, toolCallId, toolName, input, riskSummary, ttlMs = 60_000 }) {
    const request = {
      type: 'permission_request',
      sessionId,
      toolCallId,
      toolName,
      input,
      riskSummary:
        riskSummary ?? `${toolName} may perform a side effect in this session.`,
      expiresAt: new Date(this.#now().getTime() + ttlMs).toISOString(),
    }

    let resolve
    const promise = new Promise(resolveResponse => {
      resolve = resolveResponse
    })
    this.#pending.set(toolCallId, { request, resolve })
    return { request, response: promise }
  }

  respond({ toolCallId, decision, reason, responderId }) {
    const pending = this.#pending.get(toolCallId)
    if (!pending) return false
    this.#pending.delete(toolCallId)
    pending.resolve({
      toolCallId,
      decision,
      reason,
      responderId,
      respondedAt: this.#now().toISOString(),
    })
    return true
  }
}
