export function buildToolDefinitions(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

export function findTool(tools, name) {
  return tools.find(tool => tool.name === name)
}

export function isToolReadOnly(tool, input = {}) {
  if (typeof tool.isReadOnly === 'function') return tool.isReadOnly(input)
  if (typeof tool.readOnly === 'boolean') return tool.readOnly
  if (tool.requiresPermission === true) return false
  return true
}
