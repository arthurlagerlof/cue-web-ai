// App state is private to this run and is released when Bangle.js removes the UI.
(function () {
  var BM_HEADER = 9, BM_BUFFER = [], BM_MESSAGES = {}, BM_SEEN = {}, BM_TIMERS = [];
  var BM_MANUAL_ID = 0, BM_STATE = 'home', BM_DOCUMENT, BM_LOADING_ID;
  var BM_PAGE_LAYOUTS = [], BM_PAGE = 0, BM_SCROLL = 0;
  var BM_CONTEXT = '', BM_PRESS;
  var BM_ACTIONS = {}, BM_ACTION_ROWS = [];
  var BM_CONFIRM_ACTION = '__cue_confirm', BM_CANCEL_ACTION = '__cue_cancel', BM_RESTART_ACTION = '__cue_restart';
  var BM_CONNECTED = false;
  var BM_SCREEN_WIDTH = g.getWidth(), BM_SCREEN_HEIGHT = g.getHeight();
  var BM_STORAGE = require('Storage');

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
    if (timer === undefined) return;
    clearTimeout(timer);
    var index = BM_TIMERS.indexOf(timer);
    if (index >= 0) BM_TIMERS.splice(index, 1);
  }
  function bmSetState(state, context) {
    BM_PRESS = undefined;
    if (state === 'home' || state === 'thinking' || state === 'loading') BM_DOCUMENT = undefined;
    BM_STATE = state;
    BM_CONTEXT = context || '';
    BM_SCROLL = 0;
    bmDraw();
  }
  function bmFrame(type, id, index, count, payload) {
    var bytes = [0x42, 0x4d, 1, type, id & 255, id >> 8, index, count, payload.length].concat(payload);
    var frame = '';
    for (var i = 0; i < bytes.length; i++) frame += String.fromCharCode(bytes[i]);
    Bluetooth.write(frame);
  }
  function bmSendTrigger() {
    try {
      BM_MANUAL_ID = (BM_MANUAL_ID + 1) & 65535;
      bmFrame(1, BM_MANUAL_ID, 0, 1, [1]);
      Bangle.buzz(70);
      bmSetState('thinking', 'Preparing your last 10 seconds');
    } catch (error) {
      bmSetState('error', 'Could not send request: ' + error);
    }
  }
  function bmSendAction(actionId) {
    var payload;
    try { payload = bmEncodeUtf8(actionId); }
    catch (error) { bmSetState('error', 'Action could not be encoded.'); return; }
    if (!payload.length || payload.length > 255) {
      bmSetState('error', 'Action could not be sent.');
      return;
    }
    try {
      bmFrame(4, (Date.now() & 65535), 0, 1, payload);
      Bangle.buzz(50);
    } catch (error) {
      bmSetState('error', 'Could not send action: ' + error);
    }
  }
  function bmEncodeUtf8(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        var low = text.charCodeAt(i + 1);
        if (low < 0xDC00 || low > 0xDFFF) throw new Error('Invalid Unicode surrogate');
        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        i++;
      } else if (code >= 0xDC00 && code <= 0xDFFF) throw new Error('Invalid Unicode surrogate');
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
      else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
      else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    }
    return bytes;
  }
  function bmDecodeUtf8(bytes) {
    if (typeof E !== 'undefined' && E.toString) {
      var ascii = true;
      for (var j = 0; j < bytes.length; j++) {
        if (bytes[j] >= 128) { ascii = false; break; }
      }
      if (ascii) return E.toString(bytes);
    }
    var result = '';
    for (var i = 0; i < bytes.length;) {
      var first = bytes[i++], code;
      if (first < 0x80) code = first;
      else if (first >= 0xC2 && first <= 0xDF && i < bytes.length) {
        var second = bytes[i++];
        if ((second & 0xC0) !== 0x80) throw new Error('Invalid UTF-8 continuation byte');
        code = ((first & 0x1F) << 6) | (second & 0x3F);
      } else if (first >= 0xE0 && first <= 0xEF && i + 1 < bytes.length) {
        var second = bytes[i++], third = bytes[i++];
        if ((second & 0xC0) !== 0x80 || (third & 0xC0) !== 0x80 ||
            (first === 0xE0 && second < 0xA0) || (first === 0xED && second >= 0xA0)) {
          throw new Error('Invalid UTF-8 sequence');
        }
        code = ((first & 0x0F) << 12) | ((second & 0x3F) << 6) | (third & 0x3F);
      } else if (first >= 0xF0 && first <= 0xF4 && i + 2 < bytes.length) {
        var second = bytes[i++], third = bytes[i++], fourth = bytes[i++];
        if ((second & 0xC0) !== 0x80 || (third & 0xC0) !== 0x80 || (fourth & 0xC0) !== 0x80 ||
            (first === 0xF0 && second < 0x90) || (first === 0xF4 && second >= 0x90)) {
          throw new Error('Invalid UTF-8 sequence');
        }
        code = ((first & 7) << 18) | ((second & 0x3F) << 12) | ((third & 0x3F) << 6) | (fourth & 0x3F);
      } else throw new Error('Invalid UTF-8 sequence');
      if (code <= 0xFFFF) result += String.fromCharCode(code);
      else {
        code -= 0x10000;
        result += String.fromCharCode(0xD800 | (code >> 10), 0xDC00 | (code & 0x3FF));
      }
    }
    return result;
  }
  function bmSetDocument(text) {
    var parsed;
    BM_DOCUMENT = undefined;
    BM_ACTIONS = {};
    BM_PAGE_LAYOUTS = [];
    try { parsed = JSON.parse(text); } catch (error) { parsed = undefined; }
    if (parsed && (parsed.schema === 'cue.display' || parsed.schema === 'cue.watch.display') && parsed.version === 1 && parsed.pages instanceof Array) {
      BM_DOCUMENT = parsed;
      (parsed.actions || []).forEach(function (action) { BM_ACTIONS[action.id] = action; });
      BM_CONTEXT = parsed.message || parsed.title || '';
      if (!parsed.message && (parsed.state === 'empty' || parsed.state === 'error' || parsed.state === 'success')) {
        var summary = bmSummary(parsed.pages[0] && parsed.pages[0].elements || []);
        if (summary) BM_CONTEXT = summary;
      }
      if (parsed.state === 'loading') BM_STATE = 'thinking';
      else if (parsed.state === 'confirmation_required') BM_STATE = 'confirmation';
      else if (parsed.state === 'clarification_required') BM_STATE = 'clarification';
      else if (parsed.state === 'empty' || !parsed.pages.length) BM_STATE = 'empty';
      else if (parsed.state === 'error') BM_STATE = 'error';
      else if (parsed.state === 'success') BM_STATE = 'success';
      else BM_STATE = 'result';
      parsed.pages.forEach(function (page) {
        var layout = { rows: [], cursor: 0 };
        if (page.title) bmAddText(layout, page.title, { role: 'heading', spacing: 'small' });
        bmAddElements(layout, page.elements || [], 0);
        BM_PAGE_LAYOUTS.push(layout);
      });
    } else if ((parsed && (parsed.schema === 'cue.display' || parsed.schema === 'cue.watch.display'))
      || /^\s*\{\s*"schema"\s*:\s*"cue\.(watch\.)?display"/.test(text)) {
      bmSetState('error', 'Could not parse display document.');
      return false;
    } else {
      BM_STATE = 'result';
      var layout = { rows: [], cursor: 0 };
      String(text).split('\n').forEach(function (line) { bmAddText(layout, line, { role: 'body' }); });
      BM_PAGE_LAYOUTS.push(layout);
    }
    if (!BM_PAGE_LAYOUTS.length) BM_PAGE_LAYOUTS.push({ rows: [], cursor: 0 });
    BM_PAGE = 0;
    BM_SCROLL = 0;
    bmDraw();
    return true;
  }
  function bmSummary(elements) {
    var lines = [];
    elements.forEach(function (element) {
      if (!element) return;
      if (element.type === 'text' && element.text) lines.push(element.text);
      else if (element.type === 'container') lines = lines.concat([bmSummary(element.children || [])]);
      else if (element.type === 'list') (element.items || []).forEach(function (item) {
        if (item.title) lines.push(item.title);
        if (item.description) lines.push(item.description);
      });
      else if (element.type === 'image') {
        (BM_DOCUMENT.assets || []).forEach(function (asset) {
          if (asset.id === element.assetId && asset.alt) lines.push(asset.alt);
        });
      } else if (element.type === 'icon' && element.name) lines.push(element.name);
      else if (element.type === 'action' && element.label) lines.push(element.label);
    });
    return lines.join(' ');
  }
  function bmFontSize(options) {
    var style = options.style || {}, role = options.role || 'body';
    var size = style.size === 'large' ? 18 : style.size === 'small' ? 10 : role === 'heading' ? 17 : role === 'caption' ? 10 : role === 'label' ? 12 : 13;
    if (style.emphasis === 'strong' && size < 18) size++;
    return size;
  }
  function bmAddText(layout, text, options) {
    options = options || {};
    var size = options.size || bmFontSize(options), indent = options.indent || 0;
    var align = options.align || (options.style && options.style.align) || 'start';
    var spacing = options.spacing || (options.style && options.style.spacing) || 'medium';
    var gap = spacing === 'none' ? 0 : spacing === 'small' ? 3 : spacing === 'large' ? 10 : 6;
    var left = 10 + indent, right = BM_SCREEN_WIDTH - 10;
    g.setFont('Vector', size);
    var maxWidth = right - left, height = Math.max(size + 3, g.getFontHeight() + 2);
    layout.cursor += gap;
    String(text).split('\n').forEach(function (sourceLine) {
      if (!sourceLine) {
        layout.rows.push({ text: '', y: layout.cursor, height: height, size: size, align: align });
        layout.cursor += height;
        return;
      }
      var current = '';
      sourceLine.split(/\s+/).forEach(function (word) {
        while (g.stringWidth(word) > maxWidth && word.length > 1) {
          var part = '';
          while (word.length && g.stringWidth(part + word.charAt(0)) <= maxWidth) {
            part += word.charAt(0);
            word = word.slice(1);
          }
          if (!part) { part = word.charAt(0); word = word.slice(1); }
          if (current) {
            bmAddRow(layout, current, options, size, height, align, indent);
            current = '';
          }
          bmAddRow(layout, part, options, size, height, align, indent);
        }
        if (!word) return;
        var candidate = current ? current + ' ' + word : word;
        if (current && g.stringWidth(candidate) > maxWidth) {
          bmAddRow(layout, current, options, size, height, align, indent);
          current = word;
        } else current = candidate;
      });
      if (current) bmAddRow(layout, current, options, size, height, align, indent);
    });
    layout.cursor += gap;
  }
  function bmAddRow(layout, text, options, size, height, align, indent) {
    var row = {
      text: text,
      y: layout.cursor,
      height: height,
      size: size,
      align: align,
      indent: indent || 0,
      type: options.type || 'text',
      actionId: options.actionId,
      bullet: !!options.bullet
    };
    layout.rows.push(row);
    layout.cursor += height;
  }
  function bmAddElements(layout, elements, indent) {
    elements.forEach(function (element) {
      if (!element) return;
      if (element.type === 'text') {
        bmAddText(layout, element.text || '', {
          role: element.role || 'body',
          style: element.style || {},
          indent: indent
        });
      } else if (element.type === 'container') {
        var extra = element.layout === 'column' ? 0 : 4;
        bmAddElements(layout, element.children || [], indent + extra);
      } else if (element.type === 'list') {
        (element.items || []).forEach(function (item) {
          bmAddText(layout, item.title || '', { role: 'body', indent: indent + 10, bullet: true, spacing: 'small' });
          if (item.description) bmAddText(layout, item.description, { role: 'caption', indent: indent + 10, spacing: 'none' });
          if (item.actionId && BM_ACTIONS[item.actionId]) {
            bmAddText(layout, BM_ACTIONS[item.actionId].label || 'Open', {
              role: 'label',
              indent: indent + 10,
              actionId: item.actionId,
              spacing: 'small'
            });
          }
        });
      } else if (element.type === 'divider') {
        layout.rows.push({ type: 'divider', y: layout.cursor + 3, height: 8, indent: indent });
        layout.cursor += 14;
      } else if (element.type === 'icon') {
        bmAddText(layout, element.name || 'icon', { role: 'caption', indent: indent + 12, type: 'icon', spacing: 'small' });
      } else if (element.type === 'image') {
        var assetAlt = 'Image unavailable';
        (BM_DOCUMENT.assets || []).forEach(function (asset) {
          if (asset.id === element.assetId) assetAlt = asset.alt || assetAlt;
        });
        bmAddText(layout, assetAlt, { role: 'caption', indent: indent + 20, type: 'image', spacing: 'small' });
      } else if (element.type === 'action' && BM_ACTIONS[element.actionId]) {
        bmAddText(layout, element.label || BM_ACTIONS[element.actionId].label || 'Open', {
          role: 'label',
          indent: indent,
          actionId: element.actionId,
          spacing: 'small'
        });
      }
    });
  }
  function bmLogo() {
    g.setColor(0, 0, 0);
    g.fillCircle(11, 12, 3);
    g.setFont('Vector', 13);
    g.setFontAlign(-1, -1);
    g.drawString('Cue.', 20, 5);
    if (BM_DOCUMENT && BM_DOCUMENT.title) {
      var title = BM_DOCUMENT.title;
      g.setFont('Vector', 9);
      while (title.length > 1 && g.stringWidth(title) > BM_SCREEN_WIDTH - 64) title = title.slice(0, title.length - 2) + '…';
      g.setFontAlign(1, -1);
      g.drawString(title, BM_SCREEN_WIDTH - 8, 8);
    }
  }
  function bmDrawHome() {
    g.setFont('Vector', 13);
    g.setFontAlign(-1, -1);
    g.drawString('Cue.', 12, 10);
    g.fillCircle(BM_SCREEN_WIDTH / 2, 73, 7);
    g.setFontAlign(0, -1);
    g.setFont('Vector', 13);
    g.drawString('Tap for last 10 seconds', BM_SCREEN_WIDTH / 2, 111);
  }
  function bmDrawThinking() {
    bmLogo();
    g.fillCircle(BM_SCREEN_WIDTH / 2, 63, 5);
    g.setFont('Vector', 16);
    g.setFontAlign(0, -1);
    g.drawString('THINKING...', BM_SCREEN_WIDTH / 2, 81);
    if (BM_CONTEXT) {
      g.setFont('Vector', 11);
      bmDrawWrappedCentered(BM_CONTEXT, BM_SCREEN_WIDTH / 2, 108, BM_SCREEN_WIDTH - 32, 3);
    }
  }
  function bmDrawWrappedCentered(text, centerX, y, maxWidth, maxLines) {
    var lines = [], current = '';
    g.setFont('Vector', 11);
    String(text).split(/\s+/).forEach(function (word) {
      var candidate = current ? current + ' ' + word : word;
      if (current && g.stringWidth(candidate) > maxWidth) {
        lines.push(current);
        current = word;
      } else current = candidate;
    });
    if (current) lines.push(current);
    g.setFontAlign(0, -1);
    for (var i = 0; i < lines.length && i < maxLines; i++) g.drawString(lines[i], centerX, y + i * 15);
  }
  function bmDrawState(label, context) {
    bmLogo();
    g.fillCircle(BM_SCREEN_WIDTH / 2, 63, 5);
    g.setFont('Vector', 16);
    g.setFontAlign(0, -1);
    g.drawString(label, BM_SCREEN_WIDTH / 2, 81);
    if (context) {
      g.setFont('Vector', 11);
      bmDrawWrappedCentered(context, BM_SCREEN_WIDTH / 2, 108, BM_SCREEN_WIDTH - 32, 3);
    }
  }
  function bmDrawRows() {
    var layout = BM_PAGE_LAYOUTS[BM_PAGE] || { rows: [], cursor: 0 };
    var top = 34, bottom = BM_STATE === 'confirmation' ? 128 : BM_STATE === 'clarification' ? BM_SCREEN_HEIGHT - 34 : 150;
    var viewportHeight = bottom - top;
    var maxScroll = Math.max(0, layout.cursor - viewportHeight);
    BM_SCROLL = Math.max(0, Math.min(maxScroll, BM_SCROLL));
    BM_ACTION_ROWS = [];
    layout.rows.forEach(function (row) {
      var y = top + row.y - BM_SCROLL;
      if (y + row.height < top || y > bottom) return;
      if (row.type === 'divider') {
        g.drawLine(12 + (row.indent || 0), y, BM_SCREEN_WIDTH - 12, y);
        return;
      }
      var x = 10 + (row.indent || 0);
      if (row.bullet) {
        g.fillCircle(x + 2, y + 7, 1);
        x += 8;
      }
      if (row.type === 'icon') {
        g.drawRect(x, y + 1, x + 7, y + 8);
        x += 12;
      } else if (row.type === 'image') {
        g.drawRect(x, y + 1, x + 13, y + 12);
        x += 18;
      }
      g.setFont('Vector', row.size || 12);
      g.setFontAlign(row.align === 'center' ? 0 : row.align === 'end' ? 1 : -1, -1);
      var drawX = row.align === 'center' ? BM_SCREEN_WIDTH / 2 : row.align === 'end' ? BM_SCREEN_WIDTH - 10 : x;
      g.drawString(row.text, drawX, y);
      if (row.actionId) {
        var width = g.stringWidth(row.text);
        var left = row.align === 'center' ? drawX - width / 2 : row.align === 'end' ? drawX - width : drawX;
        g.drawLine(left, y + (row.height || 12) - 2, left + width, y + (row.height || 12) - 2);
        BM_ACTION_ROWS.push({ actionId: row.actionId, x1: left - 6, x2: left + width + 6, y1: y - 2, y2: y + row.height });
      }
    });
  }
  function bmDrawResult() {
    bmLogo();
    bmDrawRows();
    if (BM_PAGE_LAYOUTS.length > 1) {
      g.setFont('Vector', 9);
      g.setFontAlign(0, -1);
      g.drawString((BM_PAGE + 1) + ' / ' + BM_PAGE_LAYOUTS.length, BM_SCREEN_WIDTH / 2, BM_SCREEN_HEIGHT - 12);
    }
  }
  function bmDrawConfirmation() {
    bmDrawResult();
    g.setFont('Vector', 11);
    g.setFontAlign(-1, -1);
    g.drawString('Cancel', 28, 143);
    g.setFontAlign(1, -1);
    g.drawString('Confirm', BM_SCREEN_WIDTH - 28, 143);
    g.drawLine(20, 158, 70, 158);
    g.drawLine(BM_SCREEN_WIDTH - 70, 158, BM_SCREEN_WIDTH - 20, 158);
  }
  function bmDraw() {
    g.clear(1);
    g.setColor(0, 0, 0);
    g.setFontAlign(-1, -1);
    if (!BM_CONNECTED) bmDrawState('DISCONNECTED', 'Connect Cue over Bluetooth.');
    else if (BM_STATE === 'home') bmDrawHome();
    else if (BM_STATE === 'thinking') bmDrawThinking();
    else if (BM_STATE === 'loading') bmDrawState('LOADING...', 'Response ready. Sending to watch.');
    else if (BM_STATE === 'confirmation') bmDrawConfirmation();
    else if (BM_STATE === 'clarification') {
      bmDrawResult();
      g.setFont('Vector', 9);
      g.setFontAlign(-1, -1);
      g.drawString('Start over', 10, BM_SCREEN_HEIGHT - 25);
      g.setFontAlign(1, -1);
      g.drawString('Speak instead', BM_SCREEN_WIDTH - 10, BM_SCREEN_HEIGHT - 25);
    }
    else if (BM_STATE === 'empty') bmDrawState('NO RESULTS', BM_CONTEXT);
    else if (BM_STATE === 'error') bmDrawState('ERROR', BM_CONTEXT);
    else if (BM_STATE === 'success') bmDrawState('SUCCESS', BM_CONTEXT);
    else bmDrawResult();
  }
  function bmReceive(data) {
    if (data === 'TEST' || data === 'TEST\n' || data === 'TEST\r\n') {
      bmSetDocument('TEST');
      Bluetooth.write('ACK:TEST\n');
      return;
    }
    for (var i = 0; i < data.length; i++) BM_BUFFER.push(data.charCodeAt(i) & 255);
    while (BM_BUFFER.length >= BM_HEADER) {
      if (BM_BUFFER[0] !== 0x42 || BM_BUFFER[1] !== 0x4d || BM_BUFFER[2] !== 1) { BM_BUFFER.shift(); continue; }
      var length = BM_BUFFER[8];
      if (BM_BUFFER.length < BM_HEADER + length) return;
      var frame = BM_BUFFER.splice(0, BM_HEADER + length), type = frame[3];
      var id = frame[4] | (frame[5] << 8), index = frame[6], count = frame[7], payload = frame.slice(BM_HEADER);
      if (type === 5 && index === 0 && count === 1 && payload.length === 1 && payload[0] === 1) {
        bmSetState('thinking');
        continue;
      }
      if (type === 6 && index === 0 && count === 1 && payload.length === 1 && payload[0] === 1) {
        bmFrame(6, id, 0, 1, [1]);
        continue;
      }
      if (type !== 2 || !count || count > 245 || index >= count) continue;
      if (BM_SEEN[id]) { bmFrame(3, id, 0, 1, [0]); continue; }
      var message = BM_MESSAGES[id];
      if (!message) {
        message = BM_MESSAGES[id] = { count: count, chunks: {}, received: 0, bytes: 0 };
        if (count > 1) {
          BM_LOADING_ID = id;
          bmSetState('loading');
        }
      }
      if (message.count !== count || message.chunks[index]) continue;
      bmCancel(message.timeout);
      (function (messageId, currentMessage) {
        currentMessage.timeout = bmSchedule(function () {
          delete BM_MESSAGES[messageId];
          if (BM_STATE === 'loading' && BM_LOADING_ID === messageId) bmSetState('error', 'Transfer timed out. Retrying may help.');
        }, 10000);
      })(id, message);
      message.bytes += payload.length;
      if (message.bytes > 2450) { bmCancel(message.timeout); delete BM_MESSAGES[id]; continue; }
      message.chunks[index] = payload;
      message.received++;
      if (message.received === count) {
        bmCancel(message.timeout);
        delete BM_MESSAGES[id];
        var bytes = new Uint8Array(message.bytes), offset = 0;
        for (var chunk = 0; chunk < count; chunk++) {
          bytes.set(message.chunks[chunk], offset);
          offset += message.chunks[chunk].length;
        }
        message = undefined;
        frame = undefined;
        payload = undefined;
        var text;
        try { text = bmDecodeUtf8(bytes); }
        catch (error) { bmSetState('error', 'Received text could not be decoded.'); bmFrame(3, id, 0, 1, [1]); continue; }
        bytes = undefined;
        if (!bmSetDocument(text)) { bmFrame(3, id, 0, 1, [1]); continue; }
        BM_STORAGE.write('cue-memory.txt', text);
        BM_SEEN[id] = true;
        (function (seenId) { bmSchedule(function () { delete BM_SEEN[seenId]; }, 60000); })(id);
        bmFrame(3, id, 0, 1, [0]);
      }
    }
  }
  function bmSwipe(direction) {
    if (!BM_CONNECTED) return;
    if (BM_STATE !== 'result' && BM_STATE !== 'confirmation' && BM_STATE !== 'clarification') return;
    var next = direction < 0 ? BM_PAGE + 1 : BM_PAGE - 1;
    if (next < 0 || next >= BM_PAGE_LAYOUTS.length) return;
    BM_PAGE = next;
    BM_SCROLL = 0;
    bmDraw();
  }
  function bmTap(button, xy) {
    if (!BM_CONNECTED || !xy) return;
    if (BM_STATE !== 'home' && xy.x < 52 && xy.y < 28) {
      bmSetState('home');
      return;
    }
    if (BM_STATE === 'home') {
      if (xy.y >= 42 && xy.y <= 144 && xy.x >= 18 && xy.x <= BM_SCREEN_WIDTH - 18) bmSendTrigger();
      return;
    }
    if (BM_STATE === 'confirmation') {
      if (xy.y >= 134 && xy.y <= 166) {
        if (xy.x < BM_SCREEN_WIDTH / 2) bmSendAction(BM_CANCEL_ACTION);
        else bmSendAction(BM_CONFIRM_ACTION);
      }
      return;
    }
    if (BM_STATE === 'clarification') {
      if (xy.y >= BM_SCREEN_HEIGHT - 34) {
        if (xy.x < BM_SCREEN_WIDTH / 2) bmSendAction(BM_RESTART_ACTION);
        else bmSendTrigger();
        return;
      }
      for (var optionIndex = 0; optionIndex < BM_ACTION_ROWS.length; optionIndex++) {
        var optionRow = BM_ACTION_ROWS[optionIndex];
        if (xy.x >= optionRow.x1 && xy.x <= optionRow.x2 && xy.y >= optionRow.y1 && xy.y <= optionRow.y2) {
          bmSendAction(optionRow.actionId);
          return;
        }
      }
      bmSendTrigger();
      return;
    }
    if (BM_STATE !== 'result') return;
    for (var i = 0; i < BM_ACTION_ROWS.length; i++) {
      var row = BM_ACTION_ROWS[i];
      if (xy.x >= row.x1 && xy.x <= row.x2 && xy.y >= row.y1 && xy.y <= row.y2) {
        bmSendAction(row.actionId);
        return;
      }
    }
  }
  function bmDrag(event) {
    if (!BM_CONNECTED) return;
    if (event.b && !BM_PRESS) {
      BM_PRESS = { x: event.x, y: event.y, lastY: event.y };
      return;
    }
    if (event.b && BM_PRESS) {
      var dx = event.x - BM_PRESS.x, dy = event.y - BM_PRESS.y;
      if ((BM_STATE === 'result' || BM_STATE === 'confirmation') && Math.abs(dy) >= Math.abs(dx)) {
        BM_SCROLL -= event.y - BM_PRESS.lastY;
        BM_PRESS.lastY = event.y;
        bmDraw();
      }
      return;
    }
    if (!event.b && BM_PRESS) BM_PRESS = undefined;
  }
  function bmConnected() {
    BM_CONNECTED = true;
    bmDraw();
  }
  function bmDisconnected() {
    BM_CONNECTED = false;
    BM_PRESS = undefined;
    while (BM_TIMERS.length) clearTimeout(BM_TIMERS.pop());
    BM_MESSAGES = {};
    BM_SEEN = {};
    BM_BUFFER = [];
    if (BM_STATE === 'thinking' || BM_STATE === 'loading') bmSetState('home');
    else bmDraw();
  }
  function bmCleanup() {
    Bluetooth.removeListener('data', bmReceive);
    NRF.removeListener('connect', bmConnected);
    NRF.removeListener('disconnect', bmDisconnected);
    Bangle.removeListener('drag', bmDrag);
    Bangle.removeListener('touch', bmTap);
    BM_PRESS = undefined;
    while (BM_TIMERS.length) clearTimeout(BM_TIMERS.pop());
    BM_MESSAGES = {};
    BM_SEEN = {};
    BM_BUFFER = [];
  }

  LoopbackA.setConsole(true);
  Bangle.setUI({ mode: 'custom', back: Bangle.showClock, btn: Bangle.showClock, swipe: bmSwipe, redraw: bmDraw, remove: bmCleanup });
  Bangle.on('drag', bmDrag);
  Bangle.on('touch', bmTap);
  Bluetooth.on('data', bmReceive);
  NRF.on('connect', bmConnected);
  NRF.on('disconnect', bmDisconnected);
  BM_CONNECTED = NRF.getSecurityStatus().connected;
  bmDraw();
  Bluetooth.write('BM_BLE_READY\n');
})();
