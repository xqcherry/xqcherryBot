export class SessionStore {
  async getOrCreateSession() {
    throw new Error('SessionStore#getOrCreateSession must be implemented')
  }

  async appendMessages() {
    throw new Error('SessionStore#appendMessages must be implemented')
  }

  async appendPlatformMessage() {
    throw new Error('SessionStore#appendPlatformMessage must be implemented')
  }

  async getPlatformMessages() {
    throw new Error('SessionStore#getPlatformMessages must be implemented')
  }

  async getRecentPlatformMessages() {
    throw new Error('SessionStore#getRecentPlatformMessages must be implemented')
  }

  async searchPlatformMessages() {
    throw new Error('SessionStore#searchPlatformMessages must be implemented')
  }

  async appendToolCall() {
    throw new Error('SessionStore#appendToolCall must be implemented')
  }

  async appendPermissionAudit() {
    throw new Error('SessionStore#appendPermissionAudit must be implemented')
  }

  async appendConversationSummary() {
    throw new Error('SessionStore#appendConversationSummary must be implemented')
  }

  async appendAgentTurn() {
    throw new Error('SessionStore#appendAgentTurn must be implemented')
  }

  async updateAgentTurn() {
    throw new Error('SessionStore#updateAgentTurn must be implemented')
  }

  async appendMemoryCandidate() {
    throw new Error('SessionStore#appendMemoryCandidate must be implemented')
  }

  async activateMemoryCandidate() {
    throw new Error('SessionStore#activateMemoryCandidate must be implemented')
  }

  async listMemoryCandidates() {
    throw new Error('SessionStore#listMemoryCandidates must be implemented')
  }

  async listActiveMemories(filter = {}) {
    const candidates = await this.listMemoryCandidates(filter)
    return candidates.filter(candidate => candidate.status === 'active')
  }

  async getSessionStatus() {
    throw new Error('SessionStore#getSessionStatus must be implemented')
  }

  async clearSessionSummary() {
    throw new Error('SessionStore#clearSessionSummary must be implemented')
  }

  async clearSessionContext() {
    throw new Error('SessionStore#clearSessionContext must be implemented')
  }

  async deleteMemoryCandidate() {
    throw new Error('SessionStore#deleteMemoryCandidate must be implemented')
  }

  close() {}
}
