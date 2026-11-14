// App state is private to this run and is released when Bangle.js removes the UI.
(function () {
  var BM_HEADER = 9, BM_BUFFER = [], BM_MESSAGES = {}, BM_SEEN = {}, BM_TIMERS = [], BM_MANUAL_ID = 0, BM_LAST_TRIGGER = 0, BM_DIAG = 'BLE idle', BM_HOLDING = false, BM_HOLD_TIMER;
  var BM_STORAGE = require('Storage');
  var BM_TEXT = BM_STORAGE.read('cue-memory.txt') || 'Waiting for a result', BM_PAGES = [BM_TEXT], BM_PAGE = 0, BM_DOCUMENT, BM_ACTIVE_ACTION;

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
    var lines = [], parsed;
    BM_DOCUMENT = undefined; BM_ACTIVE_ACTION = undefined;
    try { parsed = JSON.parse(text); } catch (e) { parsed = undefined; }
    if (parsed && parsed.schema === 'cue.display' && parsed.version === 1 && parsed.pages instanceof Array) {
      BM_DOCUMENT = parsed;
      lines.push(parsed.title || 'Cue result');
      if (parsed.state) lines.push('State: ' + parsed.state);
      function walk(element) {
        if (!element) return;
        if (element.type === 'text') lines.push(element.text || '');
        else if (element.type === 'icon') lines.push('Icon: ' + element.name);
        else if (element.type === 'image') {
          var alt = 'Image unavailable';
          (parsed.assets || []).forEach(function (asset) { if (asset.id === element.assetId) alt = asset.alt || alt; });
          lines.push('Image: ' + alt);
        } else if (element.type === 'container') (element.children || []).forEach(walk);
        else if (element.type === 'list') (element.items || []).forEach(function (item) {
          lines.push(item.title || ''); if (item.description) lines.push(item.description);
          if (item.actionId) (parsed.actions || []).forEach(function (action) { if (action.id === item.actionId) { lines.push('Tap: ' + (action.label || 'Open')); if (!BM_ACTIVE_ACTION) BM_ACTIVE_ACTION = action; } });
        });
        else if (element.type === 'divider') lines.push('----------------');
        else if (element.type === 'action') {
          var action;
          (parsed.actions || []).forEach(function (candidate) { if (candidate.id === element.actionId) action = candidate; });
          if (action) { lines.push('Tap: ' + (element.label || action.label || 'Open')); if (!BM_ACTIVE_ACTION) BM_ACTIVE_ACTION = action; }
        }
      }
      parsed.pages.forEach(function (page) { if (page.title) lines.push(page.title); (page.elements || []).forEach(walk); });
    } else lines = String(text).split('\n');
    var width = Math.max(10, Math.floor(g.getWidth() / 12)), wrapped = [];
    lines.forEach(function (line) {
      var words = [], current = '';
      String(line).split(/\s+/).forEach(function (word) { while (word.length > width) { words.push(word.slice(0, width)); word = word.slice(width); } if (word) words.push(word); });
      words.forEach(function (word) {
        if (current && current.length + word.length + 1 > width) { wrapped.push(current); current = ''; }
        current = current ? current + ' ' + word : word;
      });
      wrapped.push(current);
    });
    var rows = Math.max(1, Math.floor((g.getHeight() - 72) / 18)); BM_PAGES = [];
    for (var i = 0; i < wrapped.length; i += rows) BM_PAGES.push(wrapped.slice(i, i + rows).join('\n'));
    if (!BM_PAGES.length) BM_PAGES = ['']; BM_PAGE = 0;
  }
  function bmDraw() {
    g.clear(); g.setFont('6x8', 2); g.setFontAlign(-1, -1);
    g.drawString('Page ' + (BM_PAGE + 1) + '/' + BM_PAGES.length, 4, 4);
    BM_PAGES[BM_PAGE].split('\n').forEach(function (line, index) { g.drawString(line, 4, 28 + index * 18); });
    g.setFont('6x8', 1);
    g.drawString(BM_ACTIVE_ACTION ? ('Tap to: ' + (BM_ACTIVE_ACTION.label || 'Open')).slice(0, 26) : BM_DIAG.slice(0, 28), 4, g.getHeight() - 52);
    var buttonY = g.getHeight() - 40;
    g.setColor(0.2, 0.2, 0.2); g.fillRect(4, buttonY, g.getWidth() - 4, g.getHeight() - 3);
    g.setColor(1, 1, 1); g.drawString(BM_HOLDING ? 'Release to trigger' : 'Hold to trigger', 12, buttonY + 8);
    g.drawString('Swipe: pages', 4, g.getHeight() - 12);
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
      if (type !== 2 || !count || count > 245 || index >= count) continue;
      if (BM_SEEN[id]) { bmFrame(3, id, 0, 1, [0]); continue; }
      var message = BM_MESSAGES[id];
      if (!message) {
        message = BM_MESSAGES[id] = { count: count, chunks: {}, received: 0 };
        message.timeout = bmSchedule(function () { delete BM_MESSAGES[id]; }, 10000);
      }
      if (message.count !== count || message.chunks[index]) continue;
      message.bytes = (message.bytes || 0) + payload.length;
      if (message.bytes > 2450) { bmCancel(message.timeout); delete BM_MESSAGES[id]; continue; }
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
  function bmTouch(button, xy) {
    if (!BM_ACTIVE_ACTION || !xy || xy.y >= g.getHeight() - 56) return;
    var encoded = unescape(encodeURIComponent(BM_ACTIVE_ACTION.id)), payload = [];
    for (var i = 0; i < encoded.length; i++) payload.push(encoded.charCodeAt(i) & 255);
    if (!payload.length || payload.length > 255) return;
    bmFrame(4, (Date.now() & 65535), 0, 1, payload);
    Bangle.buzz(50); bmLog('Action sent'); bmDraw();
  }
  function bmSendTrigger() {
    if (!BM_HOLDING) return;
    BM_HOLDING = false;
    if (BM_HOLD_TIMER) { bmCancel(BM_HOLD_TIMER); BM_HOLD_TIMER = undefined; }
    var now = Date.now();
    if (now - BM_LAST_TRIGGER < 2500) { bmDraw(); return; }
    BM_LAST_TRIGGER = now;
    try {
      var id = (BM_MANUAL_ID = (BM_MANUAL_ID + 1) & 65535);
      bmFrame(1, id, 0, 1, [1]);
      Bangle.buzz(70);
    } catch (e) {}
    bmDraw();
  }
  function bmDrag(event) {
    var buttonY = g.getHeight() - 40;
    if (event.b && !BM_HOLDING && event.y >= buttonY) {
      BM_HOLDING = true;
      BM_HOLD_TIMER = bmSchedule(bmSendTrigger, 5 * 60 * 1000);
      Bangle.buzz(30); bmDraw();
    } else if (!event.b && BM_HOLDING) bmSendTrigger();
  }
  function bmCleanup() {
    Bluetooth.removeListener('data', bmReceive);
    Bangle.removeListener('drag', bmDrag);
    Bangle.removeListener('touch', bmTouch);
    BM_HOLDING = false;
    while (BM_TIMERS.length) clearTimeout(BM_TIMERS.pop());
    BM_MESSAGES = {}; BM_SEEN = {}; BM_BUFFER = [];
  }

  LoopbackA.setConsole(true);
  Bangle.setUI({ mode: 'custom', back: Bangle.showClock, btn: function () { Bangle.showClock(); }, swipe: bmSwipe, redraw: bmDraw, remove: bmCleanup });
    Bangle.on('drag', bmDrag);
    Bangle.on('touch', bmTouch);
    Bluetooth.on('data', bmReceive);
  bmLayout(BM_TEXT); bmLog('BLE READY'); bmDraw();
  Bluetooth.write('BM_BLE_READY\n');
})();
