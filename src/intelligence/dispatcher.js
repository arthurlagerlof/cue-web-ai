import { assertDisplayDocument } from '../display/document.js';
import { validateArguments } from './toolRegistry.js';
import { assertExecutionPlan, MAX_PLAN_OPERATIONS, readJsonPointer, resolveForEachArguments, resolveOperationArguments } from './executionPlan.js';

export class ToolDispatcher {
  constructor(registry, { maxOperations = MAX_PLAN_OPERATIONS } = {}) {
    this.registry = registry;
    this.maxOperations = Math.max(1, Math.min(MAX_PLAN_OPERATIONS, Math.floor(maxOperations)));
  }
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
    assertExecutionPlan(plan, this.registry, {
      maxOperations: this.maxOperations,
      validateStaticArguments: true,
    });
    if (plan.status === 'cancelled') {
      return { state: 'cancelled', plan, executionState, results: executionState?.results ?? {} };
    }
    const state = executionState ?? {
      plan: structuredClone(plan),
      results: {},
      documents: {},
      executedSideEffects: [],
      pendingConfirmation: undefined,
      iterations: {},
      iterationItems: {},
      iterationResults: {},
    };
    state.iterations ??= {};
    state.iterationItems ??= {};
    state.iterationResults ??= {};
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
      for (const [templateId, iteration] of Object.entries(state.iterations)) {
        const template = byId.get(templateId);
        if (template?.status === 'running' && iteration.children.every(id => terminal.has(byId.get(id)?.status))) {
          const output = iteration.children.map(id => state.results[id]);
          template.status = 'succeeded';
          results.set(templateId, output);
          state.results[templateId] = output;
          await save();
        }
      }
      if (!state.plan.operations.some(candidate => !terminal.has(candidate.status))) break;

      const unexpandedFanOut = state.plan.operations.some(operation =>
        operation.forEach && !state.iterations[operation.id] && !terminal.has(operation.status),
      );
      let operation = state.plan.operations.find(candidate =>
        !terminal.has(candidate.status) && !(candidate.forEach && state.iterations[candidate.id])
        && (candidate.dependsOn ?? []).every(id => terminal.has(byId.get(id)?.status)),
      );
      if (unexpandedFanOut) {
        operation = state.plan.operations.find(candidate =>
          !terminal.has(candidate.status) && !(candidate.forEach && state.iterations[candidate.id])
          && (candidate.dependsOn ?? []).every(id => terminal.has(byId.get(id)?.status))
          && (candidate.forEach || this.registry.get(candidate.toolId)?.confirmation !== 'required'),
        ) ?? operation;
      }
      if (!operation) {
        const unfinished = state.plan.operations.filter(candidate => !terminal.has(candidate.status))
          .map(candidate => `${candidate.id}(${candidate.status})`).join(', ');
        await failPlan(undefined, new TypeError(`Plan contains a dependency cycle or an unfinished dependency: ${unfinished}`));
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
      if (operation.forEach && !state.iterations[operation.id]) {
        let items;
        try {
          items = readJsonPointer(results.get(operation.forEach.sourceOperation), operation.forEach.sourcePointer);
          if (!Array.isArray(items)) throw new TypeError(`Fan-out source ${operation.forEach.sourceOperation}${operation.forEach.sourcePointer} is not an array`);
        } catch (error) {
          await failPlan(operation, error);
        }
        const operationIndex = state.plan.operations.indexOf(operation);
        const expandedCount = state.plan.operations.length - 1 + items.length;
        if (expandedCount > this.maxOperations) {
          const question = `This collection would require ${expandedCount} operations, above the ${this.maxOperations}-operation limit. Please narrow the request and try again.`;
          operation.status = 'waiting_for_input';
          state.pendingQuestion = question;
          state.plan.status = 'waiting_for_input';
          await save();
          return { state: 'operation_limit', question, plan: state.plan, executionState: state };
        }
        let generated;
        try {
          generated = items.map((item, index) => {
            const args = resolveForEachArguments(operation, item, results, tool);
            return {
              id: `fan_${operationIndex + 1}_${index + 1}`,
              toolId: operation.toolId,
              purpose: operation.purpose,
              arguments: args,
              dependsOn: [...(operation.dependsOn ?? [])],
              inputBindings: [],
              conditions: [],
              status: 'pending',
              requiresConfirmation: operation.requiresConfirmation,
            };
          });
        } catch (error) {
          await failPlan(operation, error);
        }
        const children = generated.map(child => child.id);
        for (const child of generated) byId.set(child.id, child);
        generated.forEach((child, index) => {
          state.iterationItems[child.id] = {
            templateOperation: operation.id,
            sourceOperation: operation.forEach.sourceOperation,
            sourcePointer: operation.forEach.sourcePointer,
            itemIndex: index,
            item: structuredClone(items[index]),
          };
        });
        state.iterations[operation.id] = { children };
        state.iterationResults[operation.id] = [];
        state.plan.operations.splice(operationIndex + 1, 0, ...generated);
        operation.status = 'running';
        try {
          assertExecutionPlan(state.plan, this.registry, {
            maxOperations: this.maxOperations,
            validateStaticArguments: true,
          });
        } catch (error) {
          await failPlan(operation, error);
        }
        await save();
        continue;
      }

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
      const iterationItem = state.iterationItems[operation.id];
      if (iterationItem) {
        state.iterationResults[iterationItem.templateOperation][iterationItem.itemIndex] = results.get(operation.id);
      }
      approvedOperationId = undefined;
      await save();
    }
    state.plan.status = 'completed';
    await save();
    const lastDocument = [...documents.values()].at(-1);
    return { state: 'completed', plan: state.plan, executionState: state, document: lastDocument, results: state.results };
  }
}
