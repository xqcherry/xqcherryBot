export class TokenEstimator {
  constructor({
    charsPerToken = 4,
    messageOverheadTokens = 4,
  } = {}) {
    this.charsPerToken = charsPerToken
    this.messageOverheadTokens = messageOverheadTokens
  }

  estimateText(text = '') {
    if (!text) return 0
    return Math.ceil(String(text).length / this.charsPerToken)
  }

  estimateMessage(message = {}) {
    return this.messageOverheadTokens + this.estimateText(message.content ?? message.text ?? '')
  }

  estimateMessages(messages = []) {
    return messages.reduce((total, message) => total + this.estimateMessage(message), 0)
  }
}
