import { assertDisplayDocument } from '../display/document.js';
import { validateArguments } from './toolRegistry.js';
import { assertExecutionPlan, readJsonPointer, resolveOperationArguments } from './executionPlan.js';

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
    const operationId = call.operationId ?? globalThis.crypto?.randomUUID?.() ?? `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result = await provider.execute(tool.id, call.arguments, { confirmed, operationId });
    const outputDocument = result && result.document ? result.document : result;
    const document = assertDisplayDocument(outputDocument, { registry: this.registry });
    return { state: 'ready', document, data: result && result.document ? result.data : document };
  }
  async dispatchPlan(plan, { confirmed = false, confirmedOperationId, executionState, onStateChange } = {}) {
    if (executionState) {
      if (!plan || plan.id !== executionState.plan?.id) throw new TypeError('The resumed plan does not match the stored execution state');
      plan = executionState.plan;
    }
    assertExecutionPlan(plan, this.registry);
    const state = executionState ?? {
      plan: structuredClone(plan),
      results: {},
      documents: {},
      executedSideEffects: [],
      pendingConfirmation: undefined,
    };
    const save = async () => { if (onStateChange) await onStateChange(structuredClone(state)); };
    const byId = new Map(state.plan.operations.map(operation => [operation.id, operation]));
    const results = new Map(Object.entries(state.results));
    const documents = new Map(Object.entries(state.documents));
    const terminal = new Set(['succeeded', 'failed', 'skipped']);
    let approvedOperationId;
    const failPlan = async (operation, error) => {
      if (operation) operation.status = 'failed';
      state.pendingConfirmation = undefined;
      state.plan.status = 'failed';
      await save();
      throw error;
    };

    if (state.pendingConfirmation) {
      const pending = state.pendingConfirmation;
      const approved = confirmed && (!confirmedOperationId || confirmedOperationId === pending.operationId);
      if (!approved) {
        state.plan.status = 'waiting_for_confirmation';
        return { state: 'confirmation_required', plan: state.plan, executionState: state, pendingConfirmation: pending, results: state.results };
      }
      const operation = byId.get(pending.operationId);
      if (!operation) await failPlan(undefined, new TypeError('The pending confirmation does not belong to this plan'));
      const tool = this.registry.get(operation.toolId);
      let args;
      try {
        args = resolveOperationArguments(operation, results, tool);
      } catch (error) {
        await failPlan(operation, error);
      }
      const identity = JSON.stringify({ toolId: tool.id, arguments: args });
      if (identity !== pending.identity) await failPlan(operation, new Error('The pending confirmation no longer matches this operation and its arguments'));
      if (confirmedOperationId && confirmedOperationId !== pending.operationId) throw new Error('Confirmation does not authorize this operation');
      approvedOperationId = pending.operationId;
      state.pendingConfirmation = undefined;
      operation.status = 'ready';
    }

    state.plan.status = 'running';
    await save();
    while (state.plan.operations.some(operation => !terminal.has(operation.status))) {
      const operation = state.plan.operations.find(candidate =>
        !terminal.has(candidate.status) && (candidate.dependsOn ?? []).every(id => terminal.has(byId.get(id)?.status)),
      );
      if (!operation) {
        await failPlan(undefined, new TypeError('Plan contains a dependency cycle or an unfinished dependency'));
      }
      const dependencies = operation.dependsOn ?? [];
      if (dependencies.some(id => ['failed', 'skipped'].includes(byId.get(id).status))) {
        operation.status = 'skipped';
        await save();
        continue;
      }
      const conditionFailed = (operation.conditions ?? []).some(condition => {
        const source = results.get(condition.operation);
        return condition.type === 'json_pointer_exists' && readJsonPointer(source, condition.pointer) === undefined;
      });
      if (conditionFailed) {
        operation.status = 'skipped';
        await save();
        continue;
      }

      const tool = this.registry.get(operation.toolId);
      let args;
      let provider;
      try {
        args = resolveOperationArguments(operation, results, tool);
        ({ provider } = this.validateCall({ toolId: tool.id, arguments: args }));
      } catch (error) {
        await failPlan(operation, error);
      }
      const sideEffect = operation.requiresConfirmation;
      const identity = JSON.stringify({ toolId: tool.id, arguments: args });
      if (sideEffect && state.executedSideEffects.includes(identity)) await failPlan(operation, new Error(`Duplicate side effect rejected: ${tool.id}`));
      if (sideEffect) {
        const pending = state.pendingConfirmation;
        if (approvedOperationId !== operation.id && (!pending || pending.operationId !== operation.id || pending.identity !== identity)) {
          operation.status = 'waiting_for_confirmation';
          state.pendingConfirmation = { operationId: operation.id, toolId: tool.id, arguments: args, identity };
          state.plan.status = 'waiting_for_confirmation';
          await save();
          return {
            state: 'confirmation_required',
            operations: [{ id: operation.id, toolId: tool.id }],
            plan: state.plan,
            executionState: state,
            pendingConfirmation: state.pendingConfirmation,
            results: state.results,
          };
        }
      }

      operation.status = 'running';
      await save();
      const operationId = `${state.plan.id}:${operation.id}`;
      let output;
      try {
        output = await provider.execute(tool.id, args, { confirmed: sideEffect, operationId });
        const document = assertDisplayDocument(output && output.document ? output.document : output, { registry: this.registry });
        const actualResult = output && output.document ? output.data : document;
        results.set(operation.id, actualResult);
        documents.set(operation.id, document);
        state.results[operation.id] = actualResult;
        state.documents[operation.id] = document;
      } catch (error) {
        await failPlan(operation, error);
      }
      if (sideEffect) state.executedSideEffects.push(identity);
      operation.status = 'succeeded';
      approvedOperationId = undefined;
      await save();
    }
    state.plan.status = 'completed';
    await save();
    const lastDocument = [...documents.values()].at(-1);
    return { state: 'completed', plan: state.plan, executionState: state, document: lastDocument, results: state.results };
  }
}
