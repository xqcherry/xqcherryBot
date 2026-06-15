export const TOOL_RISK_LEVELS = new Set(['low', 'medium', 'high'])

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = []
    this.toolNames = new Set()
    for (const tool of tools) {
      this.register(tool)
    }
  }

  register(tool) {
    validateTool(tool, this.toolNames)
    const normalized = normalizeTool(tool)
    this.tools.push(normalized)
    this.toolNames.add(normalized.name)
    return this
  }

  list() {
    return [...this.tools].sort(compareTools)
  }

  listEnabled() {
    return this.list().filter(tool => tool.enabled !== false)
  }
}

export class ToolSelector {
  constructor({
    registry = new ToolRegistry(),
    enabledToolNames = null,
    groups = null,
    platform = null,
    provider = null,
    policy = new ToolPolicy(),
  } = {}) {
    this.registry = registry
    this.enabledToolNames = enabledToolNames ? new Set(enabledToolNames) : null
    this.groups = groups ? new Set(groups) : null
    this.platform = platform
    this.provider = provider
    this.policy = policy
  }

  select(input = {}) {
    const selected = this.registry.listEnabled().filter(tool => {
      if (this.enabledToolNames && !this.enabledToolNames.has(tool.name)) return false
      if (this.groups && !this.groups.has(tool.group)) return false
      if (this.platform && input.metadata?.platform !== this.platform) return false
      if (this.provider && input.provider !== this.provider) return false
      if (typeof tool.activationRule === 'function') return Boolean(tool.activationRule(input))
      return true
    })
    return this.policy.apply(selected, input)
  }
}

export class ToolPolicy {
  constructor({
    allowToolNames = null,
    denyToolNames = null,
    allowGroups = null,
    denyGroups = null,
    readOnlyOnly = false,
    allowPermissionRequired = true,
  } = {}) {
    this.allowToolNames = allowToolNames ? new Set(allowToolNames) : null
    this.denyToolNames = denyToolNames ? new Set(denyToolNames) : null
    this.allowGroups = allowGroups ? new Set(allowGroups) : null
    this.denyGroups = denyGroups ? new Set(denyGroups) : null
    this.readOnlyOnly = readOnlyOnly
    this.allowPermissionRequired = allowPermissionRequired
  }

  apply(tools, input = {}) {
    return tools.filter(tool => {
      if (this.denyToolNames?.has(tool.name)) return false
      if (tool.group && this.denyGroups?.has(tool.group)) return false
      if (this.allowToolNames && !this.allowToolNames.has(tool.name)) return false
      if (this.allowGroups && !this.allowGroups.has(tool.group)) return false
      if (this.readOnlyOnly && !isStaticReadOnly(tool)) return false
      if (!this.allowPermissionRequired && tool.requiresPermission === true) return false
      if (typeof tool.policyRule === 'function') return Boolean(tool.policyRule(input))
      return true
    })
  }
}

function normalizeTool(tool) {
  return {
    ...tool,
    priority: tool.priority ?? 100,
    readOnly: tool.readOnly ?? false,
    requiresPermission: tool.requiresPermission ?? false,
    riskLevel: tool.riskLevel ?? 'low',
  }
}

function validateTool(tool, existingNames) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new Error('Tool entry must be an object')
  }
  const normalized = normalizeTool(tool)
  if (typeof normalized.name !== 'string' || normalized.name.length === 0) {
    throw new Error('Tool name is required')
  }
  if (existingNames.has(normalized.name)) {
    throw new Error(`Tool name is duplicate: ${normalized.name}`)
  }
  if (typeof normalized.description !== 'string' || normalized.description.length === 0) {
    throw new Error('Tool description is required')
  }
  if (
    !normalized.inputSchema ||
    typeof normalized.inputSchema !== 'object' ||
    Array.isArray(normalized.inputSchema)
  ) {
    throw new Error(`Tool "${normalized.name}" inputSchema must be an object`)
  }
  if (typeof normalized.call !== 'function') {
    throw new Error(`Tool "${normalized.name}" call must be a function`)
  }
  if (!Number.isFinite(normalized.priority)) {
    throw new Error(`Tool "${normalized.name}" priority must be a finite number`)
  }
  if (!TOOL_RISK_LEVELS.has(normalized.riskLevel)) {
    throw new Error(`Tool "${normalized.name}" has invalid riskLevel: ${normalized.riskLevel}`)
  }
  if (
    normalized.metadata !== undefined &&
    (!normalized.metadata || typeof normalized.metadata !== 'object' || Array.isArray(normalized.metadata))
  ) {
    throw new Error(`Tool "${normalized.name}" metadata must be an object when provided`)
  }
}

function isStaticReadOnly(tool) {
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  if (tool.requiresPermission === true) return false
  return false
}

function compareTools(left, right) {
  return (
    left.priority - right.priority ||
    left.name.localeCompare(right.name)
  )
}
