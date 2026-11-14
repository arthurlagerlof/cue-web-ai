import { validateArguments } from '../intelligence/toolRegistry.js';

const roles = new Set(['heading', 'body', 'caption', 'label']);
const layouts = new Set(['column', 'row', 'grid']);
const states = new Set(['loading', 'ready', 'success', 'empty', 'error', 'confirmation_required']);
const knownElements = new Set(['text', 'image', 'icon', 'container', 'list', 'divider', 'action']);

function add(errors, path, message) { errors.push(`${path}: ${message}`); }

function validateElement(element, path, errors, actionIds, assetIds) {
  if (!element || typeof element !== 'object' || Array.isArray(element)) { add(errors, path, 'expected an element object'); return; }
  if (!knownElements.has(element.type)) { add(errors, `${path}.type`, `unsupported component type '${String(element.type)}'`); return; }
  switch (element.type) {
    case 'text':
      if (typeof element.text !== 'string') add(errors, `${path}.text`, 'expected a string');
      if (element.role !== undefined && !roles.has(element.role)) add(errors, `${path}.role`, 'unsupported text role');
      if (element.style !== undefined) {
        if (!element.style || typeof element.style !== 'object' || Array.isArray(element.style)) add(errors, `${path}.style`, 'expected a style object');
        else {
          const allowed = { size: ['small', 'medium', 'large'], align: ['start', 'center', 'end'], spacing: ['none', 'small', 'medium', 'large'], emphasis: ['normal', 'strong', 'muted'] };
          for (const [key, value] of Object.entries(element.style)) if (!allowed[key] || !allowed[key].includes(value)) add(errors, `${path}.style.${key}`, 'unsupported semantic style token');
        }
      }
      break;
    case 'image':
      if (typeof element.assetId !== 'string' || !assetIds.has(element.assetId)) add(errors, `${path}.assetId`, 'references an unknown asset');
      if (element.fit !== undefined && !['contain', 'cover'].includes(element.fit)) add(errors, `${path}.fit`, 'expected contain or cover');
      break;
    case 'icon':
      if (typeof element.name !== 'string' || !element.name) add(errors, `${path}.name`, 'expected a non-empty icon name');
      break;
    case 'container':
      if (!layouts.has(element.layout)) add(errors, `${path}.layout`, 'unsupported layout');
      if (!Array.isArray(element.children)) add(errors, `${path}.children`, 'expected an array');
      else element.children.forEach((child, index) => validateElement(child, `${path}.children[${index}]`, errors, actionIds, assetIds));
      break;
    case 'list':
      if (!Array.isArray(element.items)) add(errors, `${path}.items`, 'expected an array');
      else element.items.forEach((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string') add(errors, itemPath, 'each item requires string id and title');
        else if (item.actionId !== undefined && !actionIds.has(item.actionId)) add(errors, `${itemPath}.actionId`, 'references an unknown action');
      });
      break;
    case 'action':
      if (typeof element.label !== 'string') add(errors, `${path}.label`, 'expected a string');
      if (!actionIds.has(element.actionId)) add(errors, `${path}.actionId`, 'references an unknown action');
      break;
  }
}

export function validateDisplayDocument(document, { registry } = {}) {
  const errors = [];
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { valid: false, errors: ['$: expected an object'] };
  if (document.schema !== 'cue.display') add(errors, '$.schema', 'expected cue.display');
  if (document.version !== 1) add(errors, '$.version', 'unsupported display document version');
  for (const key of ['id', 'title']) if (typeof document[key] !== 'string' || (key === 'id' && !document[key])) add(errors, `$.${key}`, 'expected a string');
  if (!document.source || typeof document.source.app !== 'string' || typeof document.source.name !== 'string') add(errors, '$.source', 'requires app and name strings');
  if (!states.has(document.state)) add(errors, '$.state', 'unsupported document state');
  if (!Array.isArray(document.pages)) add(errors, '$.pages', 'expected an array');
  if (!Array.isArray(document.actions)) add(errors, '$.actions', 'expected an array');
  if (!Array.isArray(document.assets)) add(errors, '$.assets', 'expected an array');
  const actionIds = new Set();
  if (Array.isArray(document.actions)) document.actions.forEach((action, index) => {
    if (!action || typeof action.id !== 'string' || !action.id || typeof action.toolId !== 'string' || !action.toolId || !action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) add(errors, `$.actions[${index}]`, 'requires id, toolId, and object arguments');
    else if (actionIds.has(action.id)) add(errors, `$.actions[${index}].id`, 'duplicate action id');
    else {
      actionIds.add(action.id);
      if (registry) {
        const tool = registry.get(action.toolId);
        if (!tool) add(errors, `$.actions[${index}].toolId`, 'references an unregistered tool');
        else {
          const result = validateArguments(tool.parameters, action.arguments);
          if (!result.valid) add(errors, `$.actions[${index}].arguments`, 'does not match the registered tool schema');
        }
      }
    }
  });
  const assetIds = new Set();
  if (Array.isArray(document.assets)) document.assets.forEach((asset, index) => {
    if (!asset || typeof asset.id !== 'string' || !asset.id || typeof asset.mimeType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(asset.mimeType) || typeof asset.alt !== 'string') add(errors, `$.assets[${index}]`, 'requires id, mimeType, and alt');
    else if (assetIds.has(asset.id)) add(errors, `$.assets[${index}].id`, 'duplicate asset id');
    else {
      assetIds.add(asset.id);
      for (const dimension of ['width', 'height']) if (asset[dimension] !== undefined && (!Number.isInteger(asset[dimension]) || asset[dimension] < 1)) add(errors, `$.assets[${index}].${dimension}`, 'expected a positive integer');
    }
  });
  if (Array.isArray(document.pages)) document.pages.forEach((page, index) => {
    if (!page || typeof page.id !== 'string' || !page.id || !Array.isArray(page.elements)) add(errors, `$.pages[${index}]`, 'requires id and elements');
    else page.elements.forEach((element, elementIndex) => validateElement(element, `$.pages[${index}].elements[${elementIndex}]`, errors, actionIds, assetIds));
  });
  return { valid: errors.length === 0, errors };
}

export function assertDisplayDocument(document, options) {
  const result = validateDisplayDocument(document, options);
  if (!result.valid) throw new TypeError(`Invalid Cue Display Document: ${result.errors.join('; ')}`);
  return document;
}

/** @param {{id: string, title: string, source: {app: string, name: string}, state?: string, elements?: any[], actions?: any[], assets?: any[], pageTitle?: string, message?: string, metadata?: object}} options */
export function createDisplayDocument({ id, title, source, state = 'ready', elements = [], actions = [], assets = [], pageTitle, message, metadata }) {
  const document = { schema: 'cue.display', version: 1, id, title, source, state, pages: [{ id: `${id}-page-1`, ...(pageTitle ? { title: pageTitle } : {}), elements }], actions, assets, ...(message ? { message } : {}), ...(metadata ? { metadata } : {}) };
  return assertDisplayDocument(document);
}
