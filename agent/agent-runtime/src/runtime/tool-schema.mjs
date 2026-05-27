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
