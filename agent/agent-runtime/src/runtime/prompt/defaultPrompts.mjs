import { DEFAULT_CHAT_PERSONA_PROMPT } from './promptTemplateStore.mjs'

export {
  DEFAULT_CHAT_PERSONA_PROMPT,
  CHAT_PERSONA_PROMPT_KEY,
  PromptTemplateStore,
  fallbackChatPersona,
} from './promptTemplateStore.mjs'

export function getDefaultSystemPrompt() {
  return DEFAULT_CHAT_PERSONA_PROMPT
}
