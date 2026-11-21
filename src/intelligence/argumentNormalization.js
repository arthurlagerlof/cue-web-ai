import { schemaForPrompt, validateArguments } from './toolRegistry.js';

const responseProperties = new Set(['status', 'arguments', 'missing', 'ambiguous', 'provenance']);
const provenanceValues = new Set(['current_user_request', 'previous_conversation', 'model_extracted', 'model_generated', 'inferred']);

export function validateFormats(schema, value, path = '$', errors = []) {
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [name, child] of Object.entries(value)) {
      if (schema.properties?.[name]) validateFormats(schema.properties[name], child, `${path}.${name}`, errors);
    }
  } else if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateFormats(schema.items, item, `${path}[${index}]`, errors));
  } else if (typeof value === 'string') {
    if (schema.format === 'date') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
      if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) errors.push(`${path}: expected a valid ISO date`);
    } else if (schema.format === 'date-time') {
      const datePart = value.slice(0, 10);
      const calendarDate = /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? new Date(`${datePart}T00:00:00Z`) : undefined;
      if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || Number.isNaN(Date.parse(value))
        || !calendarDate || Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== datePart) {
        errors.push(`${path}: expected an ISO date-time with an explicit timezone`);
      }
    } else if (schema.format === 'time' && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
      errors.push(`${path}: expected an ISO time`);
    } else if (schema.format === 'duration' && !/^P(?=\d|T)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?D)?(?:T(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value)) {
      errors.push(`${path}: expected an ISO duration`);
    } else if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push(`${path}: expected an email address`);
    } else if (schema.format === 'uri' && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(value)) {
      errors.push(`${path}: expected an absolute URI`);
    }
  }
  return errors;
}

export function shouldNormalizeArguments({ tool, request, originalRequest, resolution }) {
  if (resolution.complete) return false;
  const text = `${originalRequest ?? ''}\n${request ?? ''}`.trim();
  if (!text) return false;
  if (tool.id === 'anki.create_card') {
    const explicitCardTask = /\b(?:create|make|write|generate)\b.{0,30}\b(?:flash\s*card|anki card|study card)\b/i.test(text);
    const hasTopicOrSource = /\b(?:about|on|topic|based on|from|what is|why does|how does|invent|generate)\b/i.test(text) || text.split(/\s+/).length >= 9;
    return explicitCardTask && hasTopicOrSource;
  }
  if (tool.id === 'calendar.create_event') {
    const hasDate = /\b(?:today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[/-]\d{1,2})\b/i.test(text);
    const hasExplicitTime = /\b(?:at\s+)?\d{1,2}(?::\d{2}|\s*[ap]m)\b/i.test(text);
    return hasDate && hasExplicitTime && resolution.missing.some(name => ['title', 'location'].includes(name));
  }
  return resolution.missing.length === 0 && resolution.ambiguous.length > 0;
}

export function buildArgumentNormalizationPrompt({
  originalRequest,
  request,
  conversation = [],
  tool,
  deterministicArguments = {},
  missing = [],
  ambiguous = [],
  providerEvidence = [],
  includeProviderEvidence = true,
  timeZone,
  currentDate,
}) {
  return [
    'Respond as quickly as possible. Minimize internal reasoning; do not deliberate over alternatives or include analysis. Return the required JSON directly.',
    'Handle arguments only for the selected tool; never choose or execute an action.',
    'Return one JSON object with status, arguments, missing, ambiguous, provenance; no markdown or extra keys. Follow the supplied schema and preserve explicit values. Never invent user-specific facts, dates, times, people, or IDs.',
    'For a request to create a flashcard about a topic, or an explicit request to invent its content, generate concise front/back content from the topic or general knowledge instead of asking for it. Mark generated content model_generated; it must be reviewed by the user. For other fields, use only supplied facts.',
    JSON.stringify({
      originalRequest,
      currentRequest: request,
      recentConversation: conversation,
      selectedTool: { id: tool.id, name: tool.name, description: tool.description, inputSchema: schemaForPrompt(tool.parameters) },
      deterministicArguments,
      missing,
      ambiguous,
      providerEvidence: includeProviderEvidence ? providerEvidence : [],
      timeZone,
      currentDate,
    }),
  ].join('\n');
}

export function validateNormalizedResponse(responseText, { tool, deterministicArguments = {} }) {
  let response;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new TypeError('The normalizer response was not valid JSON.');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || Object.keys(response).some(key => !responseProperties.has(key))) {
    throw new TypeError('The normalizer response has an invalid shape.');
  }
  if (!['resolved', 'needs_clarification', 'insufficient_information'].includes(response.status)) {
    throw new TypeError('The normalizer returned an unsupported status.');
  }
  if (!response.arguments || typeof response.arguments !== 'object' || Array.isArray(response.arguments)
    || !Array.isArray(response.missing) || !Array.isArray(response.ambiguous)
    || !response.missing.every(item => typeof item === 'string')
    || !response.ambiguous.every(item => typeof item === 'string')
    || !response.provenance || typeof response.provenance !== 'object' || Array.isArray(response.provenance)) {
    throw new TypeError('The normalizer response is missing typed result fields.');
  }
  const properties = tool.parameters?.properties ?? {};
  const allowedNames = new Set(Object.keys(properties));
  if ([...response.missing, ...response.ambiguous].some(name => !allowedNames.has(name))) {
    throw new TypeError('The normalizer identified an unsupported missing or ambiguous argument.');
  }
  if (new Set(response.missing).size !== response.missing.length || new Set(response.ambiguous).size !== response.ambiguous.length) {
    throw new TypeError('The normalizer returned duplicate missing or ambiguous fields.');
  }
  for (const [name, value] of Object.entries(response.arguments)) {
    if (!(name in properties)) throw new TypeError(`The normalizer returned unsupported argument: ${name}`);
    const validation = validateArguments(properties[name], value, `$.${name}`);
    if (!validation.valid) throw new TypeError(`The normalizer returned an invalid ${name}: ${validation.errors.join('; ')}`);
    const formatErrors = validateFormats(properties[name], value, `$.${name}`);
    if (formatErrors.length) throw new TypeError(`The normalizer returned an invalid ${name}: ${formatErrors.join('; ')}`);
    const provenance = response.provenance[name];
    if (!provenanceValues.has(provenance)) throw new TypeError(`The normalizer returned invalid provenance for ${name}.`);
    const existing = deterministicArguments[name];
    if (existing && ['current_user_request', 'previous_conversation'].includes(existing.source) && JSON.stringify(existing.value) !== JSON.stringify(value)) {
      throw new TypeError(`The normalizer attempted to replace an explicit ${name} value.`);
    }
  }
  for (const name of Object.keys(response.provenance)) {
    if (!(name in response.arguments) || !provenanceValues.has(response.provenance[name])) {
      throw new TypeError(`The normalizer returned unsupported provenance for ${name}.`);
    }
  }
  const mergedArguments = Object.fromEntries(Object.entries(deterministicArguments).map(([name, field]) => [name, field.value]));
  Object.assign(mergedArguments, response.arguments);
  if (response.status === 'resolved') {
    if (response.missing.length || response.ambiguous.length) throw new TypeError('A resolved result cannot report missing or ambiguous fields.');
    const validation = validateArguments(tool.parameters, mergedArguments);
    if (!validation.valid) throw new TypeError(`The normalizer result does not satisfy the tool schema: ${validation.errors.join('; ')}`);
  }
  return { ...response, arguments: mergedArguments };
}

export async function normalizeArgumentsWithModel(input, { generate, maxAttempts = 2, includeProviderEvidence = true }) {
  if (typeof generate !== 'function') throw new TypeError('A model generation function is required.');
  const basePrompt = buildArgumentNormalizationPrompt({ ...input, includeProviderEvidence });
  let prompt = basePrompt;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const output = await generate(prompt);
    try {
      return validateNormalizedResponse(output, input);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) prompt = `${basePrompt}\nCorrect the previous invalid response. Validation error: ${error.message}`;
    }
  }
  throw lastError ?? new Error('The model could not normalize the arguments.');
}
