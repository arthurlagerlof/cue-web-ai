export const EMBEDDING_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_TOKENIZER = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_PREPROCESSING = 'transformers.js feature-extraction;mean-pooling;l2-normalize';
export const EMBEDDING_REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
export const EMBEDDING_CACHE_VERSION = `${EMBEDDING_TOKENIZER}@${EMBEDDING_REVISION};q8;${EMBEDDING_PREPROCESSING}`;
