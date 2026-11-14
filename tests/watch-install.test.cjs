const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function createInstaller(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bluetooth.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const files = new Map();
  const commands = [];
  let listener;
  let input = '';
  let connected = true;
  const tx = {
    properties: { notify: true },
    startNotifications: async () => tx,
    addEventListener: (type, callback) => { if (type === 'characteristicvaluechanged') listener = callback; },
    removeEventListener: (type, callback) => { if (listener === callback) listener = undefined; },
  };
  const notify = text => {
    if (!listener) return;
    const bytes = new TextEncoder().encode(text);
    listener({ target: { value: new DataView(bytes.buffer) } });
  };
  const storage = {
    write(name, data, offset, length) {
      if (length !== undefined) files.set(name, Buffer.alloc(length, 255));
      const file = files.get(name);
      if (!file || offset + data.length > file.length) throw new Error('Invalid storage write');
      for (let i = 0; i < data.length; i++) {
        const byte = data.charCodeAt(i);
        if (file[offset + i] !== 255 && file[offset + i] !== byte) throw new Error('File already written with different data');
        file[offset + i] = byte;
      }
    },
    read(name, offset, length) {
      const file = files.get(name);
      if (!file) return undefined;
      const result = Buffer.from(file.subarray(offset || 0, length === undefined ? file.length : offset + length));
      if (options.corruptVerification && name === 'cue.app.js' && offset === 512 && result.length) result[0] ^= 1;
      return result.toString('latin1');
    },
  };
  const watch = vm.createContext({ require: () => storage, print: value => notify(`${value}\r\n`) });
  const rx = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(chunk) {
      input += new TextDecoder().decode(chunk);
      let end;
      while ((end = input.indexOf('\n')) !== -1) {
        const line = input.slice(0, end).replace(/[\x03\x10]/g, '');
        input = input.slice(end + 1);
        commands.push(line);
        if (line === 'reset();') { notify('>'); continue; }
        if (line === 'load("cue.app.js")') { notify('BM_BLE_READY\r\n'); continue; }
        if (options.echoWithoutReply && line.includes('BM_VERIFY_0_SIZE')) {
          notify(`>${line}\r\n`);
          continue;
        }
        try { vm.runInContext(line, watch); }
        catch (error) { notify(`Uncaught ${error}\r\n`); }
      }
    },
    writeValue: async () => {},
  };
  const service = { getCharacteristic: async uuid => uuid.includes('0002-') ? rx : tx };
  const server = { getPrimaryService: async () => service };
  const device = { name: 'Bangle.js test', gatt: { get connected() { return connected; }, connect: async () => server, disconnect: () => { connected = false; } }, addEventListener: () => {} };
  const exports = {};
  const context = {
    exports, TextEncoder, TextDecoder, Uint8Array, DataView, Map, Set,
    navigator: { bluetooth: { requestDevice: async () => device } },
    window: { setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, 250)), clearTimeout },
  };
  vm.runInNewContext(compiled, context);
  return { connection: new exports.BangleConnection(), files, commands };
}

test('installer uploads and verifies the actual UTF-8 watch app using byte offsets', async () => {
  const { connection, files, commands } = createInstaller();
  const source = fs.readFileSync(path.join(__dirname, '..', 'watch', 'bangle-app.js'), 'utf8');
  assert.ok(Buffer.byteLength(source) > source.length);
  await connection.connect();
  await connection.installWatchApp(source, () => {});
  assert.deepEqual(files.get('cue.app.js'), Buffer.from(source, 'utf8'));
  assert.equal(JSON.parse(files.get('cue.info').toString('utf8')).src, 'cue.app.js');
  const checks = commands.filter(command => command.includes('BM_VERIFY_0_'));
  assert.ok(checks.length > 1);
  assert.ok(checks.some(command => command.includes("read(\"cue.app.js\",512,512)")));
  assert.ok(commands.some(command => command.includes('\\xe2\\x80\\xa6')));
});

test('installer reports corrupted storage and does not launch', async () => {
  const { connection, commands } = createInstaller({ corruptVerification: true });
  await connection.connect();
  await assert.rejects(connection.installWatchApp('a'.repeat(1024), () => {}), /File verification failed: checksum/);
  assert.ok(!commands.some(command => command.startsWith('load(')));
});

test('installer does not accept a token echoed as part of a command', async () => {
  const { connection, commands } = createInstaller({ echoWithoutReply: true });
  await connection.connect();
  await assert.rejects(connection.installWatchApp('test', () => {}), /Timed out waiting for watch response: BM_VERIFY_0_SIZE/);
  assert.ok(!commands.some(command => command.startsWith('load(')));
});
