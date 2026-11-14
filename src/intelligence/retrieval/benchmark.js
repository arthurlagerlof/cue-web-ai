import { detectAmbiguity, discoverTools } from './semanticTools.js';

export async function evaluateToolBenchmark({ cases, records, embed, config = {}, now = () => performance.now() }) {
  const outcomes = [];
  for (const sample of cases) {
    const started = now();
    const result = await embed(sample.request);
    const vector = Array.isArray(result) ? result : result.vector;
    const candidates = discoverTools(vector, records, {
      threshold: config.plausibleScore ?? 0,
      limit: config.topK ?? 5,
      strategy: config.scoring ?? 'weighted-max',
      weights: config.weights,
    });
    const classification = detectAmbiguity(candidates, {
      minimumScore: config.minimumScore ?? 0.58,
      plausibleScore: config.plausibleScore ?? 0.38,
      margin: config.ambiguityMargin ?? 0.08,
    });
    const elapsedMs = Math.max(0, now() - started);
    const predictedOutcome = classification === 'matched' ? 'selected' : classification === 'ambiguous' ? 'ambiguous' : 'no_tool';
    outcomes.push({ id: sample.id, language: sample.language, expectedToolId: sample.expectedToolId, expectedOutcome: sample.expectedOutcome ?? 'selected', predictedOutcome, predictedToolId: candidates[0]?.toolId, topK: candidates.map(candidate => candidate.toolId), elapsedMs });
  }

  const positives = outcomes.filter(item => item.expectedOutcome === 'selected');
  const noTools = outcomes.filter(item => item.expectedOutcome === 'no_tool');
  const ambiguous = outcomes.filter(item => item.expectedOutcome === 'ambiguous');
  const ratio = (numerator, denominator) => denominator ? numerator / denominator : 0;
  const grouped = (key, selector) => Object.fromEntries([...new Set(outcomes.map(item => item[key] ?? 'unknown'))].map(value => {
    const items = outcomes.filter(item => (item[key] ?? 'unknown') === value);
    return [value, selector(items)];
  }));
  return {
    caseCount: outcomes.length,
    top1ToolAccuracy: ratio(positives.filter(item => item.predictedOutcome === 'selected' && item.predictedToolId === item.expectedToolId).length, positives.length),
    topKRecall: ratio(positives.filter(item => item.topK.includes(item.expectedToolId)).length, positives.length),
    correctNoToolRate: ratio(noTools.filter(item => item.predictedOutcome === 'no_tool').length, noTools.length),
    falseToolActivationRate: ratio(noTools.filter(item => item.predictedOutcome !== 'no_tool').length, noTools.length),
    ambiguityDetectionRate: ratio(ambiguous.filter(item => item.predictedOutcome === 'ambiguous').length, ambiguous.length),
    missedToolRate: ratio(positives.filter(item => !item.topK.includes(item.expectedToolId)).length, positives.length),
    meanLatencyMs: ratio(outcomes.reduce((sum, item) => sum + item.elapsedMs, 0), outcomes.length),
    byLanguage: grouped('language', items => ({ count: items.length, top1ToolAccuracy: ratio(items.filter(item => item.expectedOutcome === 'selected' && item.predictedOutcome === 'selected' && item.predictedToolId === item.expectedToolId).length, items.filter(item => item.expectedOutcome === 'selected').length), falseToolActivationRate: ratio(items.filter(item => item.expectedOutcome === 'no_tool' && item.predictedOutcome !== 'no_tool').length, items.filter(item => item.expectedOutcome === 'no_tool').length) })),
    byTool: grouped('expectedToolId', items => ({ count: items.length, top1ToolAccuracy: ratio(items.filter(item => item.predictedOutcome === 'selected' && item.predictedToolId === item.expectedToolId).length, items.length), missedToolRate: ratio(items.filter(item => !item.topK.includes(item.expectedToolId)).length, items.length) })),
    outcomes,
  };
}
