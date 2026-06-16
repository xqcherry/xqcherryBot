export class PersonaTemplateStore {
  constructor({ adapter }) {
    if (!adapter) throw new Error('PersonaTemplateStore requires adapter')
    this.adapter = adapter
  }

  async upsertPublishedPersonaConfig(config) {
    const normalized = normalizePersonaExport(config)
    const importedAt = new Date().toISOString()
    const imported = []
    for (const persona of normalized.personas) {
      imported.push(this.#upsertPersona(persona, importedAt))
    }

    this.adapter.run(
      `INSERT INTO persona_config
       (id, default_persona_key, imported_at, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         default_persona_key = excluded.default_persona_key,
         imported_at = excluded.imported_at,
         updated_at = excluded.updated_at`,
      [normalized.defaultPersonaKey, importedAt, importedAt],
    )
    this.adapter.run('DELETE FROM persona_bindings')
    for (const binding of normalized.bindings) {
      this.adapter.run(
        `INSERT INTO persona_bindings
         (scope, subject_id, persona_key, imported_at)
         VALUES (?, ?, ?, ?)`,
        [binding.scope, binding.subjectId, binding.personaKey, importedAt],
      )
    }

    return {
      defaultPersonaKey: normalized.defaultPersonaKey,
      bindings: normalized.bindings.length,
      personas: imported,
    }
  }

  getCurrentPersonaConfig() {
    const config = this.adapter.get(
      'SELECT default_persona_key FROM persona_config WHERE id = 1',
    )
    const personas = this.adapter.all(
      `SELECT
         t.persona_key,
         t.name,
         t.description,
         v.id AS version_id,
         v.content,
         v.source_version_no,
         v.source_published_at,
         v.imported_at
       FROM persona_templates t
       JOIN persona_template_versions v ON v.id = t.current_version_id
       ORDER BY t.persona_key ASC`,
    ).map(rowToPersona)
    const bindings = this.adapter.all(
      `SELECT scope, subject_id, persona_key
       FROM persona_bindings
       ORDER BY id ASC`,
    ).map(row => ({
      scope: row.scope,
      subjectId: row.subject_id,
      personaKey: row.persona_key,
    }))
    return {
      defaultPersonaKey: config?.default_persona_key ?? null,
      personas,
      bindings,
    }
  }

  #upsertPersona(persona, importedAt) {
    const existingTemplate = this.adapter.get(
      'SELECT id FROM persona_templates WHERE persona_key = ?',
      [persona.personaKey],
    )
    let templateId = existingTemplate?.id
    if (templateId == null) {
      const result = this.adapter.run(
        `INSERT INTO persona_templates
         (persona_key, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          persona.personaKey,
          persona.name,
          persona.description,
          importedAt,
          importedAt,
        ],
      )
      templateId = result.lastInsertId
    } else {
      this.adapter.run(
        `UPDATE persona_templates
         SET name = ?, description = ?, updated_at = ?
         WHERE id = ?`,
        [persona.name, persona.description, importedAt, templateId],
      )
    }

    this.adapter.run(
      `INSERT OR IGNORE INTO persona_template_versions
       (template_id, content, source_version_no, source_published_at, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        templateId,
        persona.content,
        persona.sourceVersionNo,
        persona.sourcePublishedAt,
        importedAt,
      ],
    )
    this.adapter.run(
      `UPDATE persona_template_versions
       SET content = ?, source_published_at = ?, imported_at = ?
       WHERE template_id = ? AND source_version_no = ?`,
      [
        persona.content,
        persona.sourcePublishedAt,
        importedAt,
        templateId,
        persona.sourceVersionNo,
      ],
    )
    const version = this.adapter.get(
      `SELECT id
       FROM persona_template_versions
       WHERE template_id = ? AND source_version_no = ?`,
      [templateId, persona.sourceVersionNo],
    )
    this.adapter.run(
      `UPDATE persona_templates
       SET current_version_id = ?, updated_at = ?
       WHERE id = ?`,
      [version.id, importedAt, templateId],
    )
    return {
      personaKey: persona.personaKey,
      templateId,
      versionId: version.id,
      sourceVersionNo: persona.sourceVersionNo,
      sourcePublishedAt: persona.sourcePublishedAt,
    }
  }
}

export function normalizePersonaExport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Persona export must be an object')
  }
  const exportedAt = optionalString(payload.exportedAt) || new Date(0).toISOString()
  const personas = Array.isArray(payload.personas)
    ? payload.personas.map(persona => normalizePersonaEntry(persona, exportedAt))
    : []
  const personaKeys = new Set()
  for (const persona of personas) {
    if (personaKeys.has(persona.personaKey)) {
      throw new Error(`Persona export contains duplicate personaKey: ${persona.personaKey}`)
    }
    personaKeys.add(persona.personaKey)
  }
  const defaultPersonaKey = payload.defaultPersonaKey == null || payload.defaultPersonaKey === ''
    ? null
    : requireNonEmptyString(payload.defaultPersonaKey, 'defaultPersonaKey')
  if (defaultPersonaKey && !personaKeys.has(defaultPersonaKey)) {
    throw new Error(`Persona defaultPersonaKey does not reference a persona: ${defaultPersonaKey}`)
  }
  const bindings = Array.isArray(payload.bindings)
    ? payload.bindings.map(normalizeBindingEntry)
    : []
  for (const binding of bindings) {
    if (!personaKeys.has(binding.personaKey)) {
      throw new Error(`Persona binding references unknown personaKey: ${binding.personaKey}`)
    }
  }
  return {
    exportedAt,
    defaultPersonaKey,
    personas,
    bindings,
  }
}

function normalizePersonaEntry(persona, exportedAt) {
  if (!persona || typeof persona !== 'object' || Array.isArray(persona)) {
    throw new Error('Persona export entry must be an object')
  }
  const personaKey = requireNonEmptyString(persona.personaKey, 'personaKey')
  const content = requireNonEmptyString(persona.content, `persona "${personaKey}" content`)
  const sourceVersionNo = Number(persona.sourceVersionNo ?? 1)
  if (!Number.isInteger(sourceVersionNo) || sourceVersionNo <= 0) {
    throw new Error(`Persona "${personaKey}" sourceVersionNo must be a positive integer`)
  }
  const sourcePublishedAt = optionalString(persona.sourcePublishedAt) || exportedAt
  if (!isValidIsoDate(sourcePublishedAt)) {
    throw new Error(`Persona "${personaKey}" sourcePublishedAt must be a valid timestamp`)
  }
  return {
    personaKey,
    name: optionalString(persona.name) || personaKey,
    description: optionalString(persona.description),
    content,
    sourceVersionNo,
    sourcePublishedAt,
  }
}

function normalizeBindingEntry(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('Persona binding must be an object')
  }
  const scope = requireNonEmptyString(binding.scope, 'binding scope')
  if (!['user', 'session'].includes(scope)) {
    throw new Error(`Unsupported persona binding scope: ${scope}`)
  }
  return {
    scope,
    subjectId: requireNonEmptyString(binding.subjectId, 'binding subjectId'),
    personaKey: requireNonEmptyString(binding.personaKey, 'binding personaKey'),
  }
}

function rowToPersona(row) {
  return {
    source: 'database',
    personaKey: row.persona_key,
    name: row.name ?? '',
    description: row.description ?? '',
    content: row.content ?? '',
    versionId: row.version_id,
    sourceVersionNo: row.source_version_no,
    sourcePublishedAt: row.source_published_at ?? null,
    importedAt: row.imported_at ?? null,
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Persona ${fieldName} is required`)
  }
  return value.trim()
}

function optionalString(value) {
  if (value == null) return ''
  if (typeof value !== 'string') {
    throw new Error('Persona string fields must be strings when provided')
  }
  return value
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  return Number.isFinite(Date.parse(value))
}
