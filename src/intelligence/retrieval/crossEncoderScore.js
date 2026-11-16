export function crossEncoderScoreFromLogit(logit) {
  if (typeof logit !== 'number' || !Number.isFinite(logit)) throw new TypeError('Cross-encoder logit must be finite');
  return logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
}
