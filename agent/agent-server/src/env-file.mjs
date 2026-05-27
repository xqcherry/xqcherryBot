import { readFile } from 'node:fs/promises'

export async function loadEnvFile(path, env = process.env) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }

  const loaded = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue

    const key = line.slice(0, separator).trim()
    const value = unquote(line.slice(separator + 1).trim())
    if (!key || Object.hasOwn(env, key)) continue

    env[key] = value
    loaded[key] = value
  }
  return loaded
}

function unquote(value) {
  const quote = value[0]
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return value
  return value.slice(1, -1)
}
