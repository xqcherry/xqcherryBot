export const STRUCTURED_SUMMARY_SECTIONS = [
  'Active Request',
  'Completed Work',
  'Key Decisions',
  'User Preferences',
  'Important Facts',
  'Open Questions',
  'Remaining Work',
  'Relevant Files',
]

export const JSON_SUMMARY_FIELDS = [
  'activeRequest',
  'completedWork',
  'keyDecisions',
  'userPreferences',
  'importantFacts',
  'openQuestions',
  'remainingWork',
  'relevantFiles',
]

export class SummaryValidator {
  constructor({
    minLength = 1,
    format = 'markdown',
    requireStructuredSections = false,
    requiredSections = STRUCTURED_SUMMARY_SECTIONS,
    requireJsonSchema = format === 'json',
    requiredJsonFields = JSON_SUMMARY_FIELDS,
  } = {}) {
    this.minLength = minLength
    this.format = format
    this.requireStructuredSections = requireStructuredSections
    this.requiredSections = requiredSections
    this.requireJsonSchema = requireJsonSchema
    this.requiredJsonFields = requiredJsonFields
  }

  validate(summary) {
    const text = String(summary ?? '').trim()
    if (!text) {
      return invalid('Summary is empty')
    }
    if (text.length < this.minLength) {
      return invalid(`Summary is too short: ${text.length} < ${this.minLength}`)
    }
    if (this.requireStructuredSections) {
      const missing = this.requiredSections.filter(section => !hasSection(text, section))
      if (missing.length > 0) {
        return invalid(`Missing summary sections: ${missing.join(', ')}`)
      }
    }
    if (this.requireJsonSchema) {
      const parsed = parseJsonSummary(text)
      if (!parsed.ok) return invalid(parsed.reason)
      const missing = this.requiredJsonFields.filter(field => !(field in parsed.value))
      if (missing.length > 0) {
        return invalid(`Missing JSON summary fields: ${missing.join(', ')}`)
      }
      const invalidFields = this.requiredJsonFields.filter(field => !isValidSummaryField(parsed.value[field]))
      if (invalidFields.length > 0) {
        return invalid(`Invalid JSON summary fields: ${invalidFields.join(', ')}`)
      }
    }
    return { ok: true }
  }
}

export function parseJsonSummary(summary) {
  const text = stripJsonFence(String(summary ?? '').trim())
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid('JSON summary must be an object')
    }
    return { ok: true, value }
  } catch (error) {
    return invalid(`Summary is not valid JSON: ${error.message}`)
  }
}

function invalid(reason) {
  return { ok: false, reason }
}

function stripJsonFence(text) {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : text
}

function isValidSummaryField(value) {
  if (typeof value === 'string') return true
  if (Array.isArray(value)) {
    return value.every(item => typeof item === 'string')
  }
  return false
}

function hasSection(text, section) {
  return new RegExp(`(^|\\n)##\\s+${escapeRegExp(section)}\\s*(\\n|$)`, 'i').test(text)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
