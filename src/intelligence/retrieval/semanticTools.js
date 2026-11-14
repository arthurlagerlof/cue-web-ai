export function aggregateExampleScores(scores) {
  if (!scores.length) return 0;
  const ordered = [...scores].sort((a, b) => b - a);
  const top = ordered.slice(0, 2);
  return 0.7 * ordered[0] + 0.3 * (top.reduce((sum, score) => sum + score, 0) / top.length);
}

export function discoverTools(queryVector, indexedExamples, { limit = 5, threshold = 0.35, namespace = 'tool' } = {}) {
  const scores = new Map();
  for (const example of indexedExamples) {
    if (example.namespace !== namespace || !Array.isArray(example.vector) || example.vector.length !== queryVector.length || !example.vector.length) continue;
    let dot = 0, left = 0, right = 0;
    for (let i = 0; i < queryVector.length; i++) { dot += queryVector[i] * example.vector[i]; left += queryVector[i] ** 2; right += example.vector[i] ** 2; }
    const similarity = left && right ? dot / Math.sqrt(left * right) : -1;
    if (!scores.has(example.toolId)) scores.set(example.toolId, []);
    scores.get(example.toolId).push(similarity);
  }
  return [...scores.entries()].map(([toolId, values]) => ({ toolId, score: aggregateExampleScores(values) }))
    .filter(candidate => candidate.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function detectAmbiguity(candidates, { minimumScore = 0.35, margin = 0.04 } = {}) {
  if (!candidates.length || candidates[0].score < minimumScore) return 'no_match';
  if (candidates.length > 1 && candidates[0].score - candidates[1].score < margin) return 'ambiguous';
  return 'matched';
}
