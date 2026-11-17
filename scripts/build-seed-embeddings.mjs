import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from '@huggingface/transformers';
import { buildToolExampleIndex } from '../src/intelligence/toolIntelligence.js';
import { buildProviderDataIndex } from '../src/intelligence/retrieval/providerData.js';
import { seedOffsetDays, shiftSeedDates, utcDateString } from '../src/demo/seedDates.js';
import {
  EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EMBEDDING_PREPROCESSING, EMBEDDING_REVISION, EMBEDDING_TOKENIZER,
} from '../src/intelligence/embeddingModel.js';

const readSeed = async name => JSON.parse(await readFile(new URL(`../data/seed/${name}.json`, import.meta.url), 'utf8'));
const hash = text => createHash('sha256').update(text).digest('hex');
const fixtureUrl = new URL('../data/seed/tool-embeddings.json', import.meta.url);
const [tools, providers, data, previous] = await Promise.all([
  readSeed('tool-manifests'), readSeed('provider-manifests'), readSeed('provider-data'),
  readSeed('tool-embeddings').catch(error => {
    if (error.code === 'ENOENT') return {};
    throw error;
  }),
]);
const metadata = {
  model: EMBEDDING_MODEL, modelVersion: EMBEDDING_MODEL, tokenizer: EMBEDDING_TOKENIZER,
  revision: EMBEDDING_REVISION, dtype: 'q8', preprocessing: EMBEDDING_PREPROCESSING, dimensions: EMBEDDING_DIMENSIONS,
  pooling: 'mean', normalized: true, similarityMetric: 'cosine',
};
const vectors = new Map();
if (Object.entries(metadata).every(([key, value]) => previous[key] === value)) {
  const bytes = Buffer.from(previous.vectorsBase64, 'base64');
  const vectorBytes = EMBEDDING_DIMENSIONS * 4;
  if (bytes.length !== previous.entries.length * vectorBytes) throw new Error('Invalid previous seed embedding length.');
  for (const [index, entry] of previous.entries.entries()) {
    if (entry.contentHash !== hash(`${entry.sourceType}\0${entry.text}\0${entry.locale ?? ''}`)) {
      throw new Error(`Invalid previous seed embedding hash: ${entry.id}`);
    }
    const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, dimension) => bytes.readFloatLE(index * vectorBytes + dimension * 4));
    const magnitude = Math.hypot(...vector);
    if (vector.some(value => !Number.isFinite(value)) || Math.abs(magnitude - 1) > 0.002) throw new Error(`Invalid previous seed embedding: ${entry.id}`);
    vectors.set(entry.text, vector);
  }
}
let model;
let generated = 0;
const embed = async text => {
  if (!vectors.has(text)) {
    model ??= await pipeline('feature-extraction', EMBEDDING_TOKENIZER, { dtype: 'q8', revision: EMBEDDING_REVISION });
    const output = await model(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    if (vector.length !== EMBEDDING_DIMENSIONS || vector.some(value => !Number.isFinite(value))
      || Math.abs(Math.hypot(...vector) - 1) > 0.002) throw new Error('Model returned an invalid seed embedding.');
    vectors.set(text, vector);
    generated++;
    if (generated % 20 === 0) console.log(`Generated ${generated} embeddings`);
  }
  return { vector: vectors.get(text), dimensions: EMBEDDING_DIMENSIONS };
};
const toolIndex = await buildToolExampleIndex(tools, embed);
const seedDate = utcDateString();
const indexedProviders = providers.map(provider => ({ ...provider, manifest: provider }));
const providerIndex = await buildProviderDataIndex({
  providers: indexedProviders,
  data,
  embed,
});
const baseTexts = new Map(providerIndex.map(item => [`${item.providerId}:${item.recordType}:${item.recordId}`, item.text]));
const currentProviderIndex = await buildProviderDataIndex({
  providers: indexedProviders,
  data: shiftSeedDates(data, seedOffsetDays(new Date(`${seedDate}T00:00:00Z`))),
  embed,
});
const entries = [
  ...toolIndex.map(item => ({ id: item.recordId, sourceType: item.sourceType, text: item.text, locale: item.locale ?? null })),
  ...[...providerIndex, ...currentProviderIndex.filter(item => baseTexts.get(`${item.providerId}:${item.recordType}:${item.recordId}`) !== item.text)]
    .map(item => ({ id: `${item.providerId}:${item.recordType}:${item.recordId}`, sourceType: 'provider-data', text: item.text, locale: null })),
].map(entry => ({ ...entry, contentHash: hash(`${entry.sourceType}\0${entry.text}\0${entry.locale ?? ''}`) }));
const bytes = Buffer.alloc(entries.length * EMBEDDING_DIMENSIONS * 4);
entries.forEach((entry, index) => vectors.get(entry.text).forEach((value, dimension) => {
  bytes.writeFloatLE(value, (index * EMBEDDING_DIMENSIONS + dimension) * 4);
}));
await writeFile(fixtureUrl, `${JSON.stringify({ ...metadata, seedDate, entries, vectorsBase64: bytes.toString('base64') })}\n`);
console.log(`Wrote ${entries.length} seed entries for ${seedDate} UTC (${generated} newly generated embeddings).`);
