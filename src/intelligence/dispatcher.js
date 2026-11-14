import { assertDisplayDocument } from '../display/document.js';
import { validateArguments } from './toolRegistry.js';

function readPath(root, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], root);
}

function resolveReferences(value, results) {
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, results));
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && value.$from && typeof value.$from.operationId === 'string' && typeof value.$from.path === 'string') {
    const operationResult = results.get(value.$from.operationId);
    if (!operationResult) throw new Error(`Dependency result unavailable: ${value.$from.operationId}`);
    const resolved = readPath(operationResult, value.$from.path);
    if (resolved === undefined) throw new Error(`Dependency value unavailable: ${value.$from.operationId}.${value.$from.path}`);
    return resolved;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReferences(item, results)]));
}

export class ToolDispatcher {
  constructor(registry) { this.registry = registry; }
  validateCall(call) {
    const tool = this.registry.get(call?.toolId);
    if (!tool) throw new Error(`Unknown tool id: ${call?.toolId}`);
    const provider = this.registry.getProvider(tool.providerId);
    if (!provider || provider.available === false || provider.canExecute === false || typeof provider.execute !== 'function') throw new Error(`Provider unavailable: ${tool.providerId}`);
    if ((tool.requiredPermissions ?? []).some(permission => !provider.permissions?.includes(permission))) throw new Error(`Provider lacks execution permission for ${tool.id}`);
    const validation = validateArguments(tool.parameters, call.arguments);
    if (!validation.valid) throw new TypeError(`Invalid arguments for ${tool.id}: ${validation.errors.join('; ')}`);
    return { tool, provider };
  }
  async dispatch(call, { confirmed = false } = {}) {
    const { tool, provider } = this.validateCall(call);
    if (tool.confirmation === 'required' && !confirmed) return { state: 'confirmation_required', toolId: tool.id, arguments: call.arguments };
    const result = await provider.execute(tool.id, call.arguments, { confirmed });
    const outputDocument = result && result.document ? result.document : result;
    const document = assertDisplayDocument(outputDocument, { registry: this.registry });
    return { state: 'ready', document, data: result && result.document ? result.data : document };
  }
  async dispatchPlan(plan, { confirmed = false } = {}) {
    if (!plan || !Array.isArray(plan.operations) || !plan.operations.length) throw new TypeError('A plan requires at least one operation');
    const operationById = new Map();
    for (const operation of plan.operations) {
      if (typeof operation.id !== 'string' || !operation.id || operationById.has(operation.id)) throw new TypeError('Operation ids must be unique non-empty strings');
      const tool = this.registry.get(operation.toolId);
      const provider = tool && this.registry.getProvider(tool.providerId);
      if (!tool) throw new Error(`Unknown tool id: ${operation.toolId}`);
      if (!provider || provider.available === false || provider.canExecute === false || typeof provider.execute !== 'function') throw new Error(`Provider unavailable: ${tool.providerId}`);
      if ((tool.requiredPermissions ?? []).some(permission => !provider.permissions?.includes(permission))) throw new Error(`Provider lacks execution permission for ${tool.id}`);
      operationById.set(operation.id, operation);
    }
    const pendingConfirmation = plan.operations.filter(operation => this.registry.get(operation.toolId).confirmation === 'required');
    if (pendingConfirmation.length && !confirmed) return { state: 'confirmation_required', operations: pendingConfirmation.map(({ id, toolId }) => ({ id, toolId })), plan };
    const results = new Map(), documents = new Map(), remaining = new Map(operationById);
    while (remaining.size) {
      const ready = [...remaining.values()].filter(operation => (operation.dependsOn ?? []).every(id => results.has(id)));
      if (!ready.length) throw new TypeError('Plan contains an unknown dependency or cycle');
      for (const operation of ready) {
        for (const dependency of operation.dependsOn ?? []) if (!operationById.has(dependency)) throw new TypeError(`Unknown dependency: ${dependency}`);
        const args = resolveReferences(operation.arguments, results);
        const { tool, provider } = this.validateCall({ toolId: operation.toolId, arguments: args });
        const output = await provider.execute(tool.id, args, { confirmed });
        const document = assertDisplayDocument(output && output.document ? output.document : output, { registry: this.registry });
        documents.set(operation.id, document);
        results.set(operation.id, output && output.document ? output.data : document);
        remaining.delete(operation.id);
      }
    }
    const lastDocument = [...documents.values()].at(-1);
    return { state: 'ready', document: lastDocument, results: Object.fromEntries(results) };
  }
}
