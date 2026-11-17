const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadNavigation(initialPath) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'navigation.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const events = [];
  const historyCalls = [];
  const window = {
    location: { pathname: initialPath },
    history: {
      replaceState: (_state, _title, url) => { historyCalls.push(['replace', url]); window.location.pathname = url; },
      pushState: (_state, _title, url) => { historyCalls.push(['push', url]); window.location.pathname = url; },
    },
    dispatchEvent: event => { events.push(event.type); },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, window, PopStateEvent: class { constructor(type) { this.type = type; } } });
  return { ...exports, window, events, historyCalls };
}

test('root and unknown paths are normalized to the landing route while /app opens directly', () => {
  const root = loadNavigation('/');
  assert.equal(root.getCurrentRoute(), '/landing');
  assert.deepEqual(root.historyCalls, [['replace', '/landing']]);

  const directApp = loadNavigation('/app');
  assert.equal(directApp.getCurrentRoute(), '/app');
  assert.deepEqual(directApp.historyCalls, []);

  const unknown = loadNavigation('/other');
  assert.equal(unknown.getCurrentRoute(), '/landing');
  assert.deepEqual(unknown.historyCalls, [['replace', '/landing']]);
});

test('client navigation updates history and dispatches a route change event', () => {
  const routing = loadNavigation('/landing');
  routing.navigateTo('/app');
  assert.deepEqual(routing.historyCalls, [['push', '/app']]);
  assert.deepEqual(routing.events, ['popstate']);
  routing.navigateTo('/app');
  assert.equal(routing.historyCalls.length, 1);
});

test('landing route defers application loading and requests BLE only from its connect action', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.tsx'), 'utf8');
  const landing = fs.readFileSync(path.join(__dirname, '..', 'src', 'Landing.tsx'), 'utf8');
  assert.match(main, /lazy\(\(\) => import\('\.\/App'\)\)/);
  assert.match(landing, /onClick=\{\(\) => void connectWatch\(\)\}/);
  assert.doesNotMatch(landing, /useEffect\([^)]*connectWatch/s);
});
