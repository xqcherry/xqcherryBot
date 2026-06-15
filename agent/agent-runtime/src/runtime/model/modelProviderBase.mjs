export class ModelProvider {
  async *streamChat() {
    throw new Error('ModelProvider#streamChat must be implemented')
  }
}

export class ModelSummarizer {
  async summarize() {
    throw new Error('ModelSummarizer#summarize must be implemented')
  }
}
