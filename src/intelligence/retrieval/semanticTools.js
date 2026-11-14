const DEFAULT_WEIGHTS = Object.freeze({ description: 0.35, keyword: 0.3, example: 0.35 });

export function aggregateToolRecords(records, { strategy = 'weighted-max', weights = DEFAULT_WEIGHTS, topK = 2 } = {}) {
  const best = { description: -1, keyword: -1, example: -1 };
  const bySource = { description: [], keyword: [], example: [] };
  for (const record of records) {
    const source = record.sourceType ?? record.source_type ?? 'example';
    if (bySource[source]) bySource[source].push(record.similarity);
  }
  for (const source of Object.keys(bySource)) {
    const values = bySource[source].sort((a, b) => b - a);
    best[source] = values[0] ?? -1;
    if (strategy === 'top-k' && values.length) {
      best[source] = values.slice(0, Math.max(1, topK)).reduce((sum, value) => sum + value, 0) / Math.min(values.length, Math.max(1, topK));
    }
  }
  if (strategy === 'max') return { ...best, score: Math.max(...Object.values(best)) };
  const available = Object.keys(best).filter(source => best[source] >= 0);
  const totalWeight = available.reduce((sum, source) => sum + (weights[source] ?? 0), 0) || available.length;
  const score = available.reduce((sum, source) => sum + best[source] * ((weights[source] ?? (1 / available.length)) / totalWeight), 0);
  return { ...best, score };
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || !left.length) return -1;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export function discoverTools(queryVector, records, { limit = 5, threshold = 0, namespace = 'tool', strategy = 'weighted-max', weights = DEFAULT_WEIGHTS, topK = 2 } = {}) {
  const grouped = new Map();
  for (const record of records) {
    if (record.namespace !== namespace || !record.toolId) continue;
    const similarity = cosineSimilarity(queryVector, record.vector);
    if (similarity < 0) continue;
    if (!grouped.has(record.toolId)) grouped.set(record.toolId, []);
    grouped.get(record.toolId).push({ ...record, similarity });
  }
  return [...grouped].map(([toolId, matches]) => {
    const scores = aggregateToolRecords(matches, { strategy, weights, topK });
    return { toolId, ...scores, bestDescriptionSimilarity: scores.description, bestKeywordSimilarity: scores.keyword, bestExampleSimilarity: scores.example, recordCount: matches.length };
  })
    .filter(candidate => candidate.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit)
    .map((candidate, index, all) => ({ ...candidate, margin: index === 0 ? candidate.score - (all[1]?.score ?? 0) : undefined }));
}

export function detectAmbiguity(candidates, { minimumScore = 0.55, margin = 0.08, plausibleScore = 0.35 } = {}) {
  if (!candidates.length || candidates[0].score < plausibleScore) return 'no_match';
  if (candidates[0].score < minimumScore || (candidates.length > 1 && candidates[0].score - candidates[1].score < margin)) return 'ambiguous';
  return 'matched';
}
