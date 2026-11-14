import { cosineSimilarity } from './semanticTools.js';

async function hashContent(content) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function buildProviderDataIndex({ providers, data, embed, dimensions = 384, recordIds }) {
  const index = [];
  for (const provider of providers) {
    const config = provider.manifest?.contextSearch;
    if (!config || provider.status !== 'available') continue;
    for (const recordType of config.recordTypes ?? []) {
      const records = data?.[provider.id]?.[recordType] ?? [];
      for (const record of records) {
        const content = (config.fields ?? []).flatMap(field => {
          const value = record[field];
          return Array.isArray(value) ? value.filter(item => typeof item === 'string') : typeof value === 'string' || typeof value === 'number' ? [String(value)] : [];
        }).join('\n').trim();
        if (!content) continue;
        const indexId = `${provider.id}:${recordType}:${record.id}`;
        if (recordIds && !recordIds.has(indexId)) continue;
        const result = await embed(content);
        const vector = Array.isArray(result) ? result : result.vector;
        const actualDimensions = result.dimensions ?? vector?.length;
        if (!Array.isArray(vector) || actualDimensions !== dimensions || vector.length !== dimensions) {
          throw new Error(`Unexpected provider-data embedding for ${provider.id}.${recordType}: expected ${dimensions} dimensions`);
        }
        index.push({
          namespace: 'provider-data',
          providerId: provider.id,
          recordType,
          recordId: String(record.id),
          record,
          text: content,
          contentHash: await hashContent(content),
          vector,
          indexedAt: new Date().toISOString(),
        });
      }
    }
  }
  return index;
}

export function searchProviderData(queryVector, index, { providerIds = [], limit = 3, threshold = 0.3 } = {}) {
  const allowedProviders = new Set(providerIds);
  const byProvider = new Map();
  for (const item of index) {
    if (item.namespace !== 'provider-data' || !allowedProviders.has(item.providerId)) continue;
    const similarity = cosineSimilarity(queryVector, item.vector);
    if (similarity < threshold) continue;
    if (!byProvider.has(item.providerId)) byProvider.set(item.providerId, []);
    byProvider.get(item.providerId).push({ recordId: item.recordId, recordType: item.recordType, record: item.record, similarity, indexedAt: item.indexedAt });
  }
  return Object.fromEntries([...byProvider].map(([providerId, hits]) => [
    providerId,
    {
      namespace: 'provider-data',
      indexedAt: hits.reduce((latest, hit) => hit.indexedAt > latest ? hit.indexedAt : latest, ''),
      hits: hits.sort((left, right) => right.similarity - left.similarity).slice(0, limit),
    },
  ]));
}
