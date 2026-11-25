export function isLocalWorkflowContinuation(state, continuePendingLocally) {
  return continuePendingLocally || (Array.isArray(state?.segments)
    && ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation', 'executing'].includes(state.status));
}

export function shouldUseCloudWhileLoading(mode, modelReady, continuingLocal) {
  return mode === 'automatic' && !modelReady && !continuingLocal;
}
