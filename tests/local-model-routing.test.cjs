const test = require('node:test');
const assert = require('node:assert/strict');

test('Automatic uses cloud only while the needed model is cold', async () => {
  const { shouldUseCloudWhileLoading } = await import('../src/intelligence/localModelRouting.js');
  assert.equal(shouldUseCloudWhileLoading('automatic', false, false), true);
  assert.equal(shouldUseCloudWhileLoading('automatic', true, false), false);
  assert.equal(shouldUseCloudWhileLoading('web_ai', false, false), false);
  assert.equal(shouldUseCloudWhileLoading('dots3_always', false, false), false);
  assert.equal(shouldUseCloudWhileLoading('automatic', false, true), false);
});

test('cold models do not divert pending local workflows to cloud', async () => {
  const { isLocalWorkflowContinuation, shouldUseCloudWhileLoading } = await import('../src/intelligence/localModelRouting.js');
  for (const status of ['awaiting_tool_choice', 'awaiting_argument', 'awaiting_entity_choice', 'awaiting_confirmation', 'executing']) {
    const continuing = isLocalWorkflowContinuation({ status, segments: ['local request'] }, false);
    assert.equal(shouldUseCloudWhileLoading('automatic', false, continuing), false, status);
  }
  assert.equal(isLocalWorkflowContinuation(null, true), true);
  assert.equal(isLocalWorkflowContinuation({ status: 'completed', segments: ['old request'] }, false), false);
  assert.equal(isLocalWorkflowContinuation({ status: 'awaiting_argument', pendingReasoning: true }, false), false);
});
