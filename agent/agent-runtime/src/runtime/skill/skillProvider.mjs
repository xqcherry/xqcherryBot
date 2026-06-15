import { createContextBlock } from '../context/contextBlocks.mjs'

export class SkillProvider {
  async resolve() {
    return []
  }
}

export function skillToBlock(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    throw new Error('Skill must be an object')
  }
  const skillKey = requireNonEmptyString(skill.skillKey, 'skillKey')
  return createContextBlock({
    id: `skill:${skillKey}`,
    type: 'skill',
    stability: skill.stability ?? 'stable',
    role: skill.role ?? 'system',
    content: requireNonEmptyString(skill.content, 'content'),
    metadata: {
      skillKey,
      ...(skill.source ? { source: skill.source } : {}),
      ...(skill.activationReason ? { activationReason: skill.activationReason } : {}),
      ...(skill.metadata ?? {}),
    },
  })
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Skill ${fieldName} is required`)
  }
  return value
}
