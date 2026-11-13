// App state is private to this run and is released when Bangle.js removes the UI.
(function () {
  var BM_HEADER = 9, BM_BUFFER = [], BM_MESSAGES = {}, BM_SEEN = {}, BM_TIMERS = [], BM_MANUAL_ID = 0, BM_LAST_TRIGGER = 0, BM_DIAG = 'BLE idle';
  var BM_STORAGE = require('Storage');
  var BM_TEXT = BM_STORAGE.read('cue-memory.txt') || 'Waiting for a result', BM_PAGES = [BM_TEXT], BM_PAGE = 0;

  function bmSchedule(callback, delay) {
    var timer = setTimeout(function () {
      var index = BM_TIMERS.indexOf(timer);
      if (index >= 0) BM_TIMERS.splice(index, 1);
      callback();
    }, delay);
    BM_TIMERS.push(timer);
    return timer;
  }
  function bmCancel(timer) {
    clearTimeout(timer);
    var index = BM_TIMERS.indexOf(timer);
    if (index >= 0) BM_TIMERS.splice(index, 1);
  }
  function bmLog(message) {
    BM_DIAG = message;
  }
  function bmFrame(type, id, index, count, payload) {
    var bytes = [0x42, 0x4d, 1, type, id & 255, id >> 8, index, count, payload.length].concat(payload);
    Bluetooth.write(String.fromCharCode.apply(null, bytes));
  }
  function bmLayout(text) {
    var width = Math.max(10, Math.floor(g.getWidth() / 12)), lines = [];
    var words = [];
    text.split(/\s+/).forEach(function (word) { while (word.length > width) { words.push(word.slice(0, width)); word = word.slice(width); } if (word) words.push(word); });
    words.forEach(function (word) {
      var line = lines.length ? lines[lines.length - 1] : '';
      if (!lines.length || (line.length && line.length + word.length + 1 > width)) lines.push(word);
      else lines[lines.length - 1] = line ? line + ' ' + word : word;
    });
    var rows = Math.max(1, Math.floor((g.getHeight() - 40) / 18)); BM_PAGES = [];
    for (var i = 0; i < lines.length; i += rows) BM_PAGES.push(lines.slice(i, i + rows).join('\n'));
    if (!BM_PAGES.length) BM_PAGES = ['']; BM_PAGE = 0;
  }
  function bmDraw() {
    g.clear(); g.setFont('6x8', 2); g.setFontAlign(-1, -1);
    g.drawString('Memory ' + (BM_PAGE + 1) + '/' + BM_PAGES.length, 4, 4);
    BM_PAGES[BM_PAGE].split('\n').forEach(function (line, index) { g.drawString(line, 4, 28 + index * 18); });
    g.setFont('6x8', 1); g.drawString(BM_DIAG.slice(0, 28), 4, g.getHeight() - 24);
    g.drawString('Tap: trigger  Swipe: pages', 4, g.getHeight() - 12);
  }
  function bmReceive(data) {
    bmLog('RX: ' + data.replace(/[^ -~]/g, '?'));
    bmDraw();
    if (data === 'TEST' || data === 'TEST\n' || data === 'TEST\r\n') {
      BM_TEXT = 'TEST'; bmLayout(BM_TEXT); bmLog('DISPLAY TEST'); bmDraw();
      Bluetooth.write('ACK:TEST\n'); bmLog('ACK:TEST sent'); bmDraw();
      return;
    }
    for (var i = 0; i < data.length; i++) BM_BUFFER.push(data.charCodeAt(i) & 255);
    while (BM_BUFFER.length >= BM_HEADER) {
      if (BM_BUFFER[0] !== 0x42 || BM_BUFFER[1] !== 0x4d || BM_BUFFER[2] !== 1) { BM_BUFFER.shift(); continue; }
      var length = BM_BUFFER[8]; if (BM_BUFFER.length < BM_HEADER + length) return;
      var frame = BM_BUFFER.splice(0, BM_HEADER + length), type = frame[3];
      var id = frame[4] | (frame[5] << 8), index = frame[6], count = frame[7], payload = frame.slice(BM_HEADER);
      bmLog('FRAME t' + type + ' id' + id + ' ' + (index + 1) + '/' + count + ' p' + payload.length);
      bmDraw();
      if (type !== 2 || !count || count > 52 || index >= count) continue;
      if (BM_SEEN[id]) { bmFrame(3, id, 0, 1, [0]); continue; }
      var message = BM_MESSAGES[id];
      if (!message) {
        message = BM_MESSAGES[id] = { count: count, chunks: {}, received: 0 };
        message.timeout = bmSchedule(function () { delete BM_MESSAGES[id]; }, 10000);
      }
      if (message.count !== count || message.chunks[index]) continue;
      message.bytes = (message.bytes || 0) + payload.length;
      if (message.bytes > 512) { bmCancel(message.timeout); delete BM_MESSAGES[id]; continue; }
      message.chunks[index] = payload; message.received++;
      if (message.received === count) {
        bmCancel(message.timeout); delete BM_MESSAGES[id]; BM_SEEN[id] = true;
        (function (seenId) { bmSchedule(function () { delete BM_SEEN[seenId]; }, 60000); })(id);
        var bytes = []; for (var chunk = 0; chunk < count; chunk++) bytes = bytes.concat(message.chunks[chunk]);
        var binary = String.fromCharCode.apply(null, bytes);
        try { BM_TEXT = decodeURIComponent(escape(binary)); } catch (e) { BM_TEXT = binary; }
        BM_STORAGE.write('cue-memory.txt', BM_TEXT);
        bmLayout(BM_TEXT); bmLog('DISPLAY id' + id + ' ' + BM_TEXT.length + ' chars'); bmDraw();
        bmLog('ACK TX id' + id); bmFrame(3, id, 0, 1, [0]);
      }
    }
  }
  function bmSwipe(direction) {
    if (direction > 0) BM_PAGE = Math.min(BM_PAGES.length - 1, BM_PAGE + 1);
    else BM_PAGE = Math.max(0, BM_PAGE - 1); bmDraw();
  }
  function bmTouch() {
    var now = Date.now();
    if (now - BM_LAST_TRIGGER < 2500) return;
    BM_LAST_TRIGGER = now;
    try {
      var id = (BM_MANUAL_ID = (BM_MANUAL_ID + 1) & 65535);
      bmFrame(1, id, 0, 1, [1]);
      Bangle.buzz(70);
    } catch (e) {}
  }
  function bmCleanup() {
    Bluetooth.removeListener('data', bmReceive);
    while (BM_TIMERS.length) clearTimeout(BM_TIMERS.pop());
    BM_MESSAGES = {}; BM_SEEN = {}; BM_BUFFER = [];
  }

  LoopbackA.setConsole(true);
  Bangle.setUI({ mode: 'custom', back: Bangle.showClock, btn: function () { Bangle.showClock(); }, touch: bmTouch, swipe: bmSwipe, redraw: bmDraw, remove: bmCleanup });
  Bluetooth.on('data', bmReceive);
  bmLayout(BM_TEXT); bmLog('BLE READY'); bmDraw();
  Bluetooth.write('BM_BLE_READY\n');
})();
