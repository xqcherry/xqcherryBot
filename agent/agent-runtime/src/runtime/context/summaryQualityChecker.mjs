const ACTIVE_REQUEST_SECTION = 'Active Request'
const USER_PREFERENCES_SECTION = 'User Preferences'
const OPEN_QUESTIONS_SECTION = 'Open Questions'

const EMPTY_SECTION_PATTERN =
  /^(?:none|n\/a|not mentioned|no open questions|no user preferences|无|暂无|没有|未提及|无明确信息)[。.\s]*$/i

export class SummaryQualityChecker {
  constructor({
    enabled = true,
    minSectionLength = 2,
  } = {}) {
    this.enabled = enabled
    this.minSectionLength = minSectionLength
  }

  check({ summary, messages = [] } = {}) {
    if (!this.enabled) return { ok: true }

    const sections = parseMarkdownSections(summary)
    const findings = []
    if (hasActiveRequestSignal(messages) && isEmptySection(sections, ACTIVE_REQUEST_SECTION, this.minSectionLength)) {
      findings.push('missing_active_request')
    }
    if (hasPreferenceSignal(messages) && isEmptySection(sections, USER_PREFERENCES_SECTION, this.minSectionLength)) {
      findings.push('missing_user_preferences')
    }
    if (hasQuestionSignal(messages) && isEmptySection(sections, OPEN_QUESTIONS_SECTION, this.minSectionLength)) {
      findings.push('missing_open_questions')
    }

    if (findings.length > 0) {
      return {
        ok: false,
        reason: `Summary quality check failed: ${findings.join(', ')}`,
        findings,
      }
    }
    return { ok: true }
  }
}

export function parseMarkdownSections(summary) {
  const jsonSections = parseJsonSummarySections(summary)
  if (jsonSections) return jsonSections

  const sections = new Map()
  let current = null
  for (const line of String(summary ?? '').split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+?)\s*$/)
    if (match) {
      current = match[1].trim()
      sections.set(current.toLowerCase(), '')
      continue
    }
    if (!current) continue
    const key = current.toLowerCase()
    const previous = sections.get(key) ?? ''
    sections.set(key, previous ? `${previous}\n${line}` : line)
  }
  return sections
}

function parseJsonSummarySections(summary) {
  try {
    const value = JSON.parse(stripJsonFence(String(summary ?? '').trim()))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return new Map([
      ['active request', stringifySection(value.activeRequest)],
      ['completed work', stringifySection(value.completedWork)],
      ['key decisions', stringifySection(value.keyDecisions)],
      ['user preferences', stringifySection(value.userPreferences)],
      ['important facts', stringifySection(value.importantFacts)],
      ['open questions', stringifySection(value.openQuestions)],
      ['remaining work', stringifySection(value.remainingWork)],
      ['relevant files', stringifySection(value.relevantFiles)],
    ])
  } catch {
    return null
  }
}

function stripJsonFence(text) {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : text
}

function stringifySection(value) {
  if (Array.isArray(value)) return value.join('\n')
  return String(value ?? '')
}

function isEmptySection(sections, sectionName, minSectionLength) {
  const content = String(sections.get(sectionName.toLowerCase()) ?? '').trim()
  if (content.length < minSectionLength) return true
  return EMPTY_SECTION_PATTERN.test(content)
}

function hasActiveRequestSignal(messages) {
  return messages.some(message => normalize(message.text ?? message.content).length > 0)
}

function hasPreferenceSignal(messages) {
  return messages.some(message =>
    /(?:我希望|我想|我需要|记住|偏好|不要|别|必须|最好|prefer|preference|remember|must|should|don't|do not)/i.test(
      normalize(message.text ?? message.content),
    ),
  )
}

function hasQuestionSignal(messages) {
  return messages.some(message =>
    /[?？]|(?:怎么|如何|什么|为什么|是否|哪[个些]?|能不能|可以吗|how|what|why|whether|which|can you|could you|should)/i.test(
      normalize(message.text ?? message.content),
    ),
  )
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}
