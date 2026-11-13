type GattCharacteristic = { value?: DataView | null; properties?: { write?: boolean; writeWithoutResponse?: boolean; notify?: boolean; indicate?: boolean }; startNotifications(): Promise<GattCharacteristic>; writeValueWithoutResponse?: (value: BufferSource) => Promise<void>; writeValue(value: BufferSource): Promise<void>; addEventListener(type: string, listener: (event: Event) => void): void; removeEventListener(type: string, listener: (event: Event) => void): void };
type GattService = { getCharacteristic(uuid: string): Promise<GattCharacteristic> };
type GattServer = { getPrimaryService(uuid: string): Promise<GattService> };
type BangleDevice = { name?: string | null; gatt?: { connected: boolean; connect(): Promise<GattServer>; disconnect(): void }; addEventListener(type: string, listener: () => void): void };
type BluetoothAPI = { requestDevice(options: { filters: { namePrefix: string }[]; optionalServices: string[] }): Promise<BangleDevice> };

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const HEADER_SIZE = 9;
const MAX_DISPLAY_BYTES = 512;
let nextMessageId = 1;

export class BangleConnection {
  private device?: BangleDevice;
  private characteristic?: GattCharacteristic;
  onCommand?: (command: string) => void;
  onTrigger?: () => void;
  onStatus?: (message: string) => void;
  onDiagnostic?: (message: string) => void;
  private incoming = new Uint8Array();
  private messages = new Map<number, { count: number; chunks: Map<number, Uint8Array>; timer: number }>();
  private seen = new Set<number>();
  private pendingAcks = new Map<number, (received: boolean) => void>();
  private rawTestResolver?: (received: boolean) => void;
  private rawTestBuffer = '';
  get connected() { return !!this.device?.gatt?.connected; }

  async connect() {
    if (!('bluetooth' in navigator)) throw new Error('Web Bluetooth is unavailable. Use a supported Chromium browser over HTTPS or localhost.');
    const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothAPI }).bluetooth;
    if (!bluetooth) throw new Error('Web Bluetooth is unavailable in this browser.');
    this.device = await bluetooth.requestDevice({ filters: [{ namePrefix: 'Bangle.js' }], optionalServices: [UART_SERVICE] });
    this.device.addEventListener('gattserverdisconnected', () => { this.characteristic = undefined; this.onStatus?.('Watch disconnected'); });
    const server = await this.device.gatt?.connect();
    if (!server) throw new Error('Could not establish a GATT connection.');
    const service = await server.getPrimaryService(UART_SERVICE);
    const tx = await service.getCharacteristic(UART_TX);
    this.characteristic = await service.getCharacteristic(UART_RX);
    this.onDiagnostic?.(`GATT ready: service ${UART_SERVICE}; write ${UART_RX} ${JSON.stringify(this.characteristic.properties)}; notify ${UART_TX} ${JSON.stringify(tx.properties)}`);
    tx.addEventListener('characteristicvaluechanged', event => {
      const value = (event.target as unknown as GattCharacteristic).value;
      if (!value) return;
      const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      this.onDiagnostic?.(`TX notification (${data.length} bytes): ${Array.from(data, byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
      if (this.rawTestResolver) {
        this.rawTestBuffer = (this.rawTestBuffer + new TextDecoder().decode(data)).slice(-256);
        if (this.rawTestBuffer.includes('ACK:TEST')) {
          this.onDiagnostic?.('Raw diagnostic ACK received: ACK:TEST');
          this.rawTestResolver(true);
        }
      }
      this.parseFrames(data);
    });
    await tx.startNotifications();
    this.onDiagnostic?.('Notifications enabled on UART TX');
    return this.device.name ?? 'Bangle.js';
  }

  private parseFrames(data: Uint8Array) {
    const joined = new Uint8Array(this.incoming.length + data.length);
    joined.set(this.incoming); joined.set(data, this.incoming.length); this.incoming = joined;
    while (this.incoming.length >= HEADER_SIZE) {
      if (this.incoming[0] !== 0x42 || this.incoming[1] !== 0x4d || this.incoming[2] !== 1) { this.incoming = this.incoming.slice(1); continue; }
      const size = this.incoming[8];
      if (this.incoming.length < HEADER_SIZE + size) return;
      const type = this.incoming[3], id = this.incoming[4] | this.incoming[5] << 8;
      const index = this.incoming[6], count = this.incoming[7];
      const payload = this.incoming.slice(HEADER_SIZE, HEADER_SIZE + size); this.incoming = this.incoming.slice(HEADER_SIZE + size);
      if (type === 3 && count === 1 && index === 0 && payload.length === 1) {
        this.onDiagnostic?.(`ACK frame: id=${id}, status=${payload[0]}, waiting=${this.pendingAcks.has(id)}`);
        this.pendingAcks.get(id)?.(payload[0] === 0);
        continue;
      }
      if (type !== 1 || count !== 1 || index !== 0 || payload.length !== 1 || payload[0] !== 1 || this.seen.has(id)) continue;
      let message = this.messages.get(id);
      if (!message) { message = { count, chunks: new Map(), timer: window.setTimeout(() => this.messages.delete(id), 10000) }; this.messages.set(id, message); }
      if (message.count !== count) continue;
      message.chunks.set(index, payload);
      if (message.chunks.size === count) {
        window.clearTimeout(message.timer); this.messages.delete(id); this.seen.add(id);
        if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
        void this.sendFrame(3, id, new Uint8Array([0]));
        this.onTrigger?.();
      }
    }
  }

  private async sendFrame(type: number, id: number, payload: Uint8Array) {
    if (!this.characteristic) return;
    const frame = new Uint8Array(HEADER_SIZE + payload.length);
    frame.set([0x42, 0x4d, 1, type, id & 255, id >> 8, 0, 1, payload.length]); frame.set(payload, HEADER_SIZE);
    if (this.characteristic.writeValueWithoutResponse) await this.characteristic.writeValueWithoutResponse(frame);
    else await this.characteristic.writeValue(frame);
  }

  async installWatchApp(appSource: string, onProgress: (message: string) => void) {
    if (!this.characteristic) throw new Error('Connect the Bangle.js before installing the app.');
    const rx = this.characteristic;
    const tx = await this.device!.gatt!.connect().then(server => server.getPrimaryService(UART_SERVICE)).then(service => service.getCharacteristic(UART_TX));
    let output = '';
    let waiters: Array<{ token: string; resolve: () => void; reject: (error: Error) => void; timer: number }> = [];
    const onData = (event: Event) => {
      const value = (event.target as unknown as GattCharacteristic).value;
      if (!value) return;
      output += new TextDecoder().decode(value);
      if (output.length > 4096) output = output.slice(-4096);
      waiters = waiters.filter(waiter => {
        if (output.includes(waiter.token)) { window.clearTimeout(waiter.timer); waiter.resolve(); return false; }
        if (/Uncaught|SyntaxError|ReferenceError|TypeError/.test(output)) { window.clearTimeout(waiter.timer); waiter.reject(new Error(output.slice(-500))); return false; }
        return true;
      });
    };
    tx.addEventListener('characteristicvaluechanged', onData);
    await tx.startNotifications();

    const write = async (text: string) => {
      const bytes = new TextEncoder().encode(text);
      for (let offset = 0; offset < bytes.length; offset += 20) {
        const chunk = bytes.slice(offset, offset + 20);
        if (rx.writeValueWithoutResponse) await rx.writeValueWithoutResponse(chunk);
        else await rx.writeValue(chunk);
      }
    };
    const waitFor = (token: string) => new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`Timed out waiting for watch response: ${token}`)), 12000);
      waiters.push({ token, resolve, reject, timer });
      if (output.includes(token)) { window.clearTimeout(timer); waiters = waiters.filter(waiter => waiter.token !== token); resolve(); }
    });
    const command = async (code: string, token: string) => {
      output = '';
      const response = waitFor(token);
      await write(`\x10${code};print(${JSON.stringify(token)})\n`);
      await response;
      output = '';
    };

    try {
      onProgress('Restarting into the Espruino console…');
      output = '';
      const prompt = waitFor('>');
      await write('\x03\x10reset();\n');
      await prompt;
      const files = [
        { name: 'cue.app.js', content: appSource },
        { name: 'cue.info', content: JSON.stringify({ id: 'cue-memory', name: 'Cue', type: 'app', src: 'cue.app.js', version: '0.1.0', files: 'cue.app.js,cue.info' }) },
      ];
      for (const file of files) {
        onProgress(`Uploading ${file.name}…`);
        const chunkSize = 48;
        for (let offset = 0; offset < file.content.length; offset += chunkSize) {
          const part = file.content.slice(offset, offset + chunkSize);
          const token = `BM_${files.indexOf(file)}_${offset}`;
          const size = offset === 0 ? `,0,${file.content.length}` : `,${offset}`;
          await command(`require('Storage').write(${JSON.stringify(file.name)},${JSON.stringify(part)}${size})`, token);
        }
        let checksum = 0;
        for (let index = 0; index < file.content.length; index++) checksum = (checksum + file.content.charCodeAt(index)) >>> 0;
        await command(`var s=require('Storage').read(${JSON.stringify(file.name)}),n=0;for(var i=0;i<s.length;i++)n=(n+s.charCodeAt(i))>>>0;if(s.length!==${file.content.length}||n!==${checksum})throw new Error('File verification failed')`, `BM_VERIFY_${files.indexOf(file)}`);
      }
      onProgress('Launching app and waiting for its BLE READY signal…');
      output = '';
      const appReady = waitFor('BM_BLE_READY');
      await write('\x10load("cue.app.js")\n');
      await appReady;
      onProgress('App launched: BLE READY received. Confirm the watch displays BLE READY before sending TEST.');
    } finally {
      waiters.forEach(waiter => { window.clearTimeout(waiter.timer); waiter.reject(new Error('Installation ended.')); });
      tx.removeEventListener('characteristicvaluechanged', onData);
    }
  }

  async sendRawTest() {
    if (!this.characteristic) throw new Error('Connect the Bangle.js before sending the raw BLE test.');
    if (this.rawTestResolver) throw new Error('A raw BLE test is already in progress.');
    this.rawTestBuffer = '';
    let resolveRaw!: (received: boolean) => void;
    const acknowledged = new Promise<boolean>(resolve => {
      resolveRaw = resolve;
      const timer = window.setTimeout(() => {
        this.rawTestResolver = undefined;
        this.onDiagnostic?.('Timed out waiting for raw ACK:TEST');
        resolve(false);
      }, 2500);
      this.rawTestResolver = received => {
        window.clearTimeout(timer);
        this.rawTestResolver = undefined;
        resolve(received);
      };
    });
    const bytes = new TextEncoder().encode('TEST');
    this.onDiagnostic?.(`Writing raw UART text to ${UART_RX}: ${Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
    try {
      if (this.characteristic.writeValueWithoutResponse) await this.characteristic.writeValueWithoutResponse(bytes);
      else await this.characteristic.writeValue(bytes);
    } catch (error) {
      resolveRaw(false);
      throw error;
    }
    if (!(await acknowledged)) throw new Error('No ACK:TEST returned from the watch.');
  }

  async sendDisplayText(text: string) {
    if (!this.characteristic) throw new Error('Connect the Bangle.js before sending display text.');
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_DISPLAY_BYTES) throw new Error('Watch display text exceeds 512 UTF-8 bytes.');
    const chunkSize = 10;
    const id = nextMessageId++ & 0xffff, count = Math.max(1, Math.ceil(bytes.length / chunkSize));
    this.onDiagnostic?.(`Sending ${bytes.length} UTF-8 bytes as ${count} frame(s), id=${id}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      this.onDiagnostic?.(`Delivery attempt ${attempt + 1}/3, id=${id}`);
      const acknowledged = new Promise<boolean>(resolve => {
        const timer = window.setTimeout(() => {
          this.pendingAcks.delete(id);
          this.onDiagnostic?.(`ACK timeout for id=${id}`);
          resolve(false);
        }, 2500);
        this.pendingAcks.set(id, received => {
          window.clearTimeout(timer);
          this.pendingAcks.delete(id);
          resolve(received);
        });
      });
      for (let i = 0; i < count; i++) {
        if (!this.characteristic) throw new Error('Watch disconnected before receiving the result.');
        const payload = bytes.slice(i * chunkSize, (i + 1) * chunkSize);
        const frame = new Uint8Array(HEADER_SIZE + payload.length);
        frame.set([0x42, 0x4d, 1, 2, id & 255, id >> 8, i, count, payload.length]); frame.set(payload, HEADER_SIZE);
        if (this.characteristic.writeValueWithoutResponse) await this.characteristic.writeValueWithoutResponse(frame);
        else await this.characteristic.writeValue(frame);
        this.onDiagnostic?.(`Wrote RX frame id=${id}, chunk=${i + 1}/${count}, bytes=${Array.from(frame, byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
        if (i + 1 < count) await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      if (await acknowledged) return;
    }
    throw new Error('Watch did not acknowledge the result after 3 delivery attempts.');
  }

  async send(message: string) {
    if (!this.characteristic) return;
    const data = new TextEncoder().encode(`${message}\n`);
    if (this.characteristic.writeValueWithoutResponse) await this.characteristic.writeValueWithoutResponse(data);
    else await this.characteristic.writeValue(data);
  }

  disconnect() { this.device?.gatt?.disconnect(); this.device = undefined; this.characteristic = undefined; }
}
