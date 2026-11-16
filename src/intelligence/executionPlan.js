import { validateArguments } from './toolRegistry.js';

export const PLAN_SCHEMA = 'cue.execution-plan';
export const PLAN_VERSION = 1;
export const MAX_PLAN_OPERATIONS = 8;

const operationStatuses = new Set([
  'pending', 'ready', 'running', 'waiting_for_input', 'waiting_for_confirmation',
  'succeeded', 'failed', 'skipped',
]);
const planStatuses = new Set([
  'ready', 'running', 'waiting_for_input', 'waiting_for_confirmation',
  'completed', 'failed', 'cancelled',
]);
const transforms = new Set(['subtract_duration', 'add_duration', 'format_datetime', 'select_first']);

export function validateExecutionPlan(plan, registry, { maxOperations = MAX_PLAN_OPERATIONS } = {}) {
  const errors = [];
  const add = (path, message) => errors.push(`${path}: ${message}`);
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['$: expected an object'] };
  if (plan.schema !== PLAN_SCHEMA) add('$.schema', `expected ${PLAN_SCHEMA}`);
  if (plan.version !== PLAN_VERSION) add('$.version', `expected ${PLAN_VERSION}`);
  for (const key of ['id', 'conversationId', 'originalRequest']) {
    if (typeof plan[key] !== 'string' || !plan[key].trim()) add(`$.${key}`, 'expected a non-empty string');
  }
  if (typeof plan.id === 'string' && plan.id.length > 80) add('$.id', 'must be at most 80 characters');
  if (typeof plan.conversationId === 'string' && plan.conversationId.length > 80) add('$.conversationId', 'must be at most 80 characters');
  if (typeof plan.originalRequest === 'string' && plan.originalRequest.length > 10000) add('$.originalRequest', 'is too long');
  if (!planStatuses.has(plan.status)) add('$.status', 'unsupported plan status');
  if (!Array.isArray(plan.operations)) {
    add('$.operations', 'expected an array');
    return { valid: false, errors };
  }
  if (plan.operations.length > maxOperations) add('$.operations', `exceeds the ${maxOperations}-operation limit`);

  const byId = new Map();
  for (const [index, operation] of plan.operations.entries()) {
    const path = `$.operations[${index}]`;
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      add(path, 'expected an operation object');
      continue;
    }
    if (typeof operation.id !== 'string' || !operation.id.trim() || byId.has(operation.id)) add(`${path}.id`, 'expected a unique non-empty string');
    else byId.set(operation.id, operation);
    if (typeof operation.id === 'string' && operation.id.length > 80) add(`${path}.id`, 'must be at most 80 characters');
    if (typeof operation.toolId !== 'string' || !registry?.get(operation.toolId)) add(`${path}.toolId`, 'must reference a currently registered tool');
    if (typeof operation.purpose !== 'string' || !operation.purpose.trim()) add(`${path}.purpose`, 'expected a non-empty string');
    if (!operation.arguments || typeof operation.arguments !== 'object' || Array.isArray(operation.arguments)) add(`${path}.arguments`, 'expected an object');
    if (!Array.isArray(operation.dependsOn) || operation.dependsOn.some(id => typeof id !== 'string') || new Set(operation.dependsOn).size !== operation.dependsOn.length) add(`${path}.dependsOn`, 'expected unique operation IDs');
    if (!Array.isArray(operation.inputBindings ?? [])) add(`${path}.inputBindings`, 'expected an array');
    if (!Array.isArray(operation.conditions ?? [])) add(`${path}.conditions`, 'expected an array');
    if (!operationStatuses.has(operation.status)) add(`${path}.status`, 'unsupported operation status');
    if (typeof operation.requiresConfirmation !== 'boolean') add(`${path}.requiresConfirmation`, 'expected a boolean');
    const tool = registry?.get(operation.toolId);
    if (tool && operation.requiresConfirmation !== (tool.confirmation === 'required')) add(`${path}.requiresConfirmation`, 'must match the registered tool confirmation policy');

    for (const [bindingIndex, binding] of (operation.inputBindings ?? []).entries()) {
      const bindingPath = `${path}.inputBindings[${bindingIndex}]`;
      if (!binding || typeof binding !== 'object' || typeof binding.targetArgument !== 'string'
        || typeof binding.sourceOperation !== 'string' || typeof binding.sourcePointer !== 'string'
        || !binding.sourcePointer.startsWith('/') || /~(?![01])/.test(binding.sourcePointer)) {
        add(bindingPath, 'requires targetArgument, sourceOperation, and a JSON Pointer');
        continue;
      }
      if (!tool?.parameters?.properties?.[binding.targetArgument]) add(`${bindingPath}.targetArgument`, 'is not a registered tool argument');
      if (binding.transform && (!transforms.has(binding.transform.type) || Object.keys(binding.transform).some(key => !['type', 'duration'].includes(key)))) {
        add(`${bindingPath}.transform`, 'contains an unsupported transformation');
      }
      if (binding.transform && ['subtract_duration', 'add_duration'].includes(binding.transform.type)
        && (typeof binding.transform.duration !== 'string' || !parseDuration(binding.transform.duration))) {
        add(`${bindingPath}.transform.duration`, 'must be a supported ISO duration');
      }
    }
    for (const [conditionIndex, condition] of (operation.conditions ?? []).entries()) {
      const conditionPath = `${path}.conditions[${conditionIndex}]`;
      if (!condition || condition.type !== 'json_pointer_exists' || typeof condition.operation !== 'string'
        || typeof condition.pointer !== 'string' || !condition.pointer.startsWith('/') || /~(?![01])/.test(condition.pointer)) {
        add(conditionPath, 'only json_pointer_exists conditions are supported');
      }
    }
  }

  for (const [index, operation] of plan.operations.entries()) {
    const path = `$.operations[${index}]`;
    if (plan.status === 'ready' && operation?.status !== 'pending') add(`${path}.status`, 'new plans must start with pending operations');
    if (!operation || !Array.isArray(operation.dependsOn)) continue;
    for (const dependency of operation.dependsOn) {
      if (!byId.has(dependency)) add(`${path}.dependsOn`, `references unknown operation '${dependency}'`);
    }
    for (const binding of operation.inputBindings ?? []) {
      if (binding) {
        if (!byId.has(binding.sourceOperation)) add(`${path}.inputBindings`, `references unknown operation '${binding.sourceOperation}'`);
        else if (!operation.dependsOn.includes(binding.sourceOperation)) add(`${path}.inputBindings`, `source '${binding.sourceOperation}' must be a dependency`);
      }
    }
    for (const condition of operation.conditions ?? []) {
      if (condition) {
        if (!byId.has(condition.operation)) add(`${path}.conditions`, `references unknown operation '${condition.operation}'`);
        else if (!operation.dependsOn.includes(condition.operation)) add(`${path}.conditions`, `source '${condition.operation}' must be a dependency`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) if (byId.has(dependency) && !visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  for (const id of byId.keys()) if (!visit(id)) {
    add('$.operations', 'contains a dependency cycle');
    break;
  }

  return { valid: errors.length === 0, errors };
}

export function assertExecutionPlan(plan, registry, options) {
  const result = validateExecutionPlan(plan, registry, options);
  if (!result.valid) throw new TypeError(`Invalid execution plan: ${result.errors.join('; ')}`);
  return plan;
}

export function readJsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new TypeError('A JSON Pointer must start with "/"');
  return pointer.slice(1).split('/').reduce((current, segment) => {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || current === undefined || !Object.hasOwn(Object(current), key)) return undefined;
    return current[key];
  }, value);
}

function parseDuration(duration) {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
  if (!match || !match.slice(1).some(value => value !== undefined)) return undefined;
  return (Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600
    + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0)) * 1000;
}

export function applyBindingTransform(value, transform) {
  if (!transform) return value;
  if (transform.type === 'select_first') {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    return value[0];
  }
  if (transform.type === 'format_datetime') {
    const date = new Date(value);
    if (typeof value !== 'string' || Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }
  const milliseconds = parseDuration(transform.duration);
  const date = new Date(value);
  if (milliseconds === undefined || typeof value !== 'string' || Number.isNaN(date.getTime())) return undefined;
  date.setTime(date.getTime() + (transform.type === 'subtract_duration' ? -milliseconds : milliseconds));
  return date.toISOString();
}

export function resolveOperationArguments(operation, results, tool) {
  const args = structuredClone(operation.arguments);
  for (const binding of operation.inputBindings ?? []) {
    const source = results.get(binding.sourceOperation);
    if (source === undefined) throw new Error(`Dependency result unavailable: ${binding.sourceOperation}`);
    const value = applyBindingTransform(readJsonPointer(source, binding.sourcePointer), binding.transform);
    if (value === undefined) throw new Error(`Dependency value unavailable: ${binding.sourceOperation}${binding.sourcePointer}`);
    args[binding.targetArgument] = value;
  }
  const validation = validateArguments(tool.parameters, args);
  if (!validation.valid) throw new TypeError(`Invalid bound arguments for ${tool.id}: ${validation.errors.join('; ')}`);
  return args;
}
