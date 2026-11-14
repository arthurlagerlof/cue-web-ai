const idPattern = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export function validateArguments(schema, value, path = '$') {
  const errors = [];
  function visit(rule, current, currentPath) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { errors.push(`${currentPath}: invalid schema`); return; }
    if (rule.type === 'object') {
      if (!current || typeof current !== 'object' || Array.isArray(current)) { errors.push(`${currentPath}: expected object`); return; }
      const required = Array.isArray(rule.required) ? rule.required : [];
      for (const key of required) if (!(key in current)) errors.push(`${currentPath}.${key}: required`);
      const properties = rule.properties || {};
      for (const [key, child] of Object.entries(current)) {
        if (!(key in properties)) { if (rule.additionalProperties === false) errors.push(`${currentPath}.${key}: additional property not allowed`); continue; }
        visit(properties[key], child, `${currentPath}.${key}`);
      }
    } else if (rule.type === 'array') {
      if (!Array.isArray(current)) { errors.push(`${currentPath}: expected array`); return; }
      if (rule.minItems !== undefined && current.length < rule.minItems) errors.push(`${currentPath}: too few items`);
      if (rule.maxItems !== undefined && current.length > rule.maxItems) errors.push(`${currentPath}: too many items`);
      if (rule.items) current.forEach((item, index) => visit(rule.items, item, `${currentPath}[${index}]`));
    } else if (rule.type === 'string') {
      if (typeof current !== 'string') errors.push(`${currentPath}: expected string`);
      else { if (rule.minLength !== undefined && current.length < rule.minLength) errors.push(`${currentPath}: too short`); if (rule.enum && !rule.enum.includes(current)) errors.push(`${currentPath}: unsupported value`); }
    } else if (rule.type === 'number' || rule.type === 'integer') {
      if (typeof current !== 'number' || !Number.isFinite(current) || (rule.type === 'integer' && !Number.isInteger(current))) errors.push(`${currentPath}: expected ${rule.type}`);
      else { if (rule.minimum !== undefined && current < rule.minimum) errors.push(`${currentPath}: below minimum`); if (rule.maximum !== undefined && current > rule.maximum) errors.push(`${currentPath}: above maximum`); }
    } else if (rule.type === 'boolean') {
      if (typeof current !== 'boolean') errors.push(`${currentPath}: expected boolean`);
    } else errors.push(`${currentPath}: unsupported JSON Schema type`);
  }
  visit(schema, value, path);
  return { valid: errors.length === 0, errors };
}

export function validateToolDefinition(tool) {
  if (!tool || typeof tool !== 'object' || !idPattern.test(tool.id ?? '')) throw new TypeError('Tool id must be a qualified id such as provider.operation');
  if (typeof tool.providerId !== 'string' || !tool.providerId || typeof tool.name !== 'string' || !tool.name || typeof tool.description !== 'string' || !tool.description) throw new TypeError(`Tool ${tool.id} requires providerId, name, and description`);
  if (!tool.parameters || tool.parameters.type !== 'object' || typeof tool.parameters.properties !== 'object') throw new TypeError(`Tool ${tool.id} requires an object JSON Schema`);
  if (!['none', 'required'].includes(tool.confirmation)) throw new TypeError(`Tool ${tool.id} requires a supported confirmation policy`);
  if (!Array.isArray(tool.examples) || tool.examples.some(example => typeof example !== 'string' || !example.trim())) throw new TypeError(`Tool ${tool.id} requires non-empty example utterances`);
  if (tool.requiredPermissions !== undefined && (!Array.isArray(tool.requiredPermissions) || tool.requiredPermissions.some(permission => typeof permission !== 'string' || !permission))) throw new TypeError(`Tool ${tool.id} has invalid required permissions`);
  return tool;
}

export class ToolRegistry {
  constructor() { this.tools = new Map(); this.providers = new Map(); }
  registerProvider(provider) {
    if (!provider || typeof provider.id !== 'string' || typeof provider.execute !== 'function') throw new TypeError('Provider adapter requires an id and execute function');
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }
  registerTool(tool) {
    validateToolDefinition(tool);
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, Object.freeze({ ...tool }));
  }
  get(id) { return this.tools.get(id); }
  getProvider(id) { return this.providers.get(id); }
  list() { return [...this.tools.values()]; }
}
