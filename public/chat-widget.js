/* Live chat widget (Socket.io). Add before </body>:
<script src="https://YOUR-API/chat-widget.js" data-api="https://YOUR-API" defer></script>
Optional data- attributes: title, initial, header, accent, avatar, label, welcome, chips ("A|B|C"), user-key */
(function () {
  var me = document.currentScript; if (!me) return;
  if (window.__lcLoaded) return; window.__lcLoaded = true;   // never start two widgets
  var A = function (k, d) { return me.getAttribute('data-' + k) || d; };
  var API = A('api', '');
  var C = {
    title: A('title', 'Biashara Loans Support'), initial: A('initial', 'B'),
    header: A('header', '#075e54'), accent: A('accent', '#25d366'), avatar: A('avatar', '#ff5a00'),
    label: A('label', 'Chat with us'),
    welcome: A('welcome', 'Hello 👋 Welcome to Biashara Loans. How can we help you today?'),
    chips: A('chips', '📝 Apply for a loan|📊 Loan status|💳 Repayment help|🙋 Talk to an agent').split('|'),
    userKey: A('user-key', 'user')
  };

  function load(cb, fail) {
    if (window.io) return cb();
    var s = document.createElement('script');
    s.src = API + '/socket.io/socket.io.js'; s.onload = cb;
    s.onerror = function () { s.remove(); if (fail) fail(); };
    document.head.appendChild(s);
  }
  init();   // always draw the chat button, even if the server is unreachable

  function init() {
    var vid = null;
    try { vid = localStorage.getItem('chat_vid'); } catch (_) {}
    if (!vid) {
      vid = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)) + '-v';
      try { localStorage.setItem('chat_vid', vid); } catch (_) {}
    }
    // Shim: the UI works immediately; the real socket attaches once the server answers
    var handlers = {}, real = null;
    var socket = {
      get connected() { return !!(real && real.connected); },
      on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); if (real) real.on(ev, fn); },
      emit: function () { if (real) real.emit.apply(real, arguments); }
    };
    function connectReal() {
      real = io(API, { auth: { visitorId: vid }, reconnection: true });
      Object.keys(handlers).forEach(function (ev) { handlers[ev].forEach(function (fn) { real.on(ev, fn); }); });
    }

    /* ---------- sounds (no audio files needed) ---------- */
    var AC = null;
    function unlock() {
      try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === 'suspended') AC.resume(); } catch (_) {}
    }
    ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });
    function beep(kind) {
      try {
        if (!AC || AC.state !== 'running') return;
        var t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
        o.type = 'sine';
        if (kind === 'send') { o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(920, t + 0.08); }
        else { o.frequency.setValueAtTime(880, t); o.frequency.setValueAtTime(1175, t + 0.13); }
        var d = kind === 'send' ? 0.14 : 0.32;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + 0.02);
      } catch (_) {}
    }

    /* ---------- styles ---------- */
    var css = document.createElement('style');
    css.textContent =
      '#lc-root,#lc-root *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
      '#lc-b{position:fixed;right:16px;bottom:84px;width:62px;height:62px;border-radius:50%;background:' + C.accent + ';border:0;cursor:pointer;z-index:99998;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.28);animation:lcp 2.4s infinite}' +
      '#lc-b svg{width:30px;height:30px;fill:#fff}' +
      '@keyframes lcp{0%{box-shadow:0 0 0 0 rgba(37,211,102,.55),0 6px 18px rgba(0,0,0,.28)}70%{box-shadow:0 0 0 16px rgba(37,211,102,0),0 6px 18px rgba(0,0,0,.28)}100%{box-shadow:0 0 0 0 rgba(37,211,102,0),0 6px 18px rgba(0,0,0,.28)}}' +
      '#lc-n{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#e53935;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff}' +
      '#lc-l{transition:opacity .45s ease;position:fixed;right:88px;bottom:98px;background:#fff;color:' + C.header + ';font-weight:600;font-size:15px;padding:10px 16px;border-radius:20px;box-shadow:0 4px 14px rgba(0,0,0,.18);z-index:99998;cursor:pointer}' +
      '#lc-w{position:fixed;right:16px;bottom:16px;width:380px;height:min(600px,calc(100vh - 32px));background:#efeae2;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;z-index:99999;color:#111}' +
      '#lc-w.on{display:flex}' +
      '#lc-h{background:' + C.header + ';color:#fff;padding:12px 14px;display:flex;align-items:center;gap:12px;flex:none}' +
      '#lc-x{background:none;border:0;color:#fff;font-size:24px;cursor:pointer;line-height:1;padding:4px}#lc-x .m{display:none}' +
      '#lc-av{width:44px;height:44px;border-radius:50%;background:' + C.avatar + ';color:#fff;font-weight:700;font-size:20px;display:flex;align-items:center;justify-content:center;flex:none}' +
      '#lc-t{font-weight:700;font-size:17px;line-height:1.2}#lc-s{font-size:13px;color:#b9f6ca;margin-top:2px}' +
      '#lc-m{flex:1;overflow-y:auto;padding:14px 12px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}' +
      '.lc-r{display:flex;flex-direction:column;margin:6px 0}.lc-r.me{align-items:flex-end}.lc-r.ag{align-items:flex-start}' +
      '.lc-bb{position:relative;max-width:82%;padding:9px 13px;border-radius:14px;font-size:16px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1.5px rgba(0,0,0,.13);cursor:pointer}' +
      '.me .lc-bb{background:#d9fdd3;border-top-right-radius:4px}.ag .lc-bb{background:#fff;border-top-left-radius:4px}' +
      '.lc-bb.del{color:#667781;font-style:italic;cursor:default;font-size:14px}' +
      '.lc-img{display:block;max-width:100%;width:220px;max-height:260px;object-fit:cover;border-radius:10px;margin:-2px 0 4px;background:#e8e8e8}' +
      '.lc-hr{position:absolute;bottom:-11px;right:8px;background:#fff;border-radius:12px;padding:1px 6px;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.25)}' +
      '.lc-tm{font-size:11px;color:#667781;margin:2px 4px 0}.lc-r.liked .lc-tm{margin-top:12px}' +
      '.lc-act{display:none;gap:8px;margin-top:6px}.lc-r.sel .lc-act{display:flex}' +
      '.lc-act button{border:0;background:#fff;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.2);color:#333}' +
      '.lc-act .dng{color:#c62828}' +
      '#lc-c{display:flex;gap:8px;overflow-x:auto;padding:10px 10px 6px;background:#fff;flex:none;scrollbar-width:none}#lc-c::-webkit-scrollbar{display:none}' +
      '.lc-ch{flex:none;border:1px solid ' + C.accent + ';background:#e9fbef;color:' + C.header + ';border-radius:20px;padding:8px 14px;font-size:14px;cursor:pointer;white-space:nowrap}' +
      '#lc-f{display:flex;gap:8px;align-items:flex-end;padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));background:#fff;flex:none}' +
      '#lc-p{background:none;border:0;font-size:24px;cursor:pointer;padding:4px 2px;flex:none}' +
      '#lc-i{flex:1;min-width:0;padding:11px 16px;border:1px solid #d1d7db;border-radius:22px;font-size:16px;line-height:1.35;outline:none;background:#fff;color:#111;resize:none;overflow-y:auto;max-height:120px;height:44px;display:block;font-family:inherit}#lc-i:focus{border-color:' + C.accent + '}' +
      '#lc-go{height:44px;background:' + C.accent + ';color:#fff;border:0;border-radius:24px;padding:12px 20px;font-weight:700;font-size:16px;cursor:pointer;flex:none}' +
      '#lc-v{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:100000;display:none;flex-direction:column;align-items:center;justify-content:center;padding:16px}#lc-v.on{display:flex}' +
      '#lc-v img{max-width:100%;max-height:78vh;border-radius:8px}#lc-v .bar{display:flex;gap:12px;margin-top:16px}' +
      '#lc-v button{border:0;border-radius:20px;padding:10px 20px;font-size:15px;font-weight:600;cursor:pointer}' +
      '@media(max-width:520px){#lc-w{right:0;left:0;top:0;bottom:0;width:100%;height:100%;border-radius:0}#lc-x .d{display:none}#lc-x .m{display:inline}#lc-l{right:84px;bottom:96px}#lc-b{bottom:80px}}';
    document.head.appendChild(css);

    var root = document.createElement('div'); root.id = 'lc-root';
    root.innerHTML =
      '<div id="lc-l">' + C.label + ' 💬</div>' +
      '<button id="lc-b" aria-label="Open chat"><svg viewBox="0 0 24 24"><path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 1-2z"/></svg><span id="lc-n"></span></button>' +
      '<div id="lc-w" role="dialog" aria-label="Live chat">' +
        '<div id="lc-h"><button id="lc-x" aria-label="Close chat"><span class="m">←</span><span class="d">✕</span></button>' +
        '<div id="lc-av"></div><div><div id="lc-t"></div><div id="lc-s">Connecting…</div></div></div>' +
        '<div id="lc-m"></div><div id="lc-c"></div>' +
        '<form id="lc-f" autocomplete="off"><button type="button" id="lc-p" aria-label="Send a photo">📎</button><input type="file" id="lc-file" accept="image/*" hidden>' +
        '<textarea id="lc-i" rows="1" placeholder="Type a message…" maxlength="1500" enterkeyhint="enter"></textarea><button id="lc-go" type="submit">Send</button></form>' +
      '</div>' +
      '<div id="lc-v"><img alt=""><div class="bar"><button id="lc-vs" style="background:' + C.accent + ';color:#fff">💾 Save</button><button id="lc-vc" style="background:#fff;color:#111">Close</button></div></div>';
    document.body.appendChild(root);

    var $ = function (id) { return document.getElementById(id); };
    $('lc-av').textContent = C.initial; $('lc-t').textContent = C.title;
    var w = $('lc-w'), m = $('lc-m'), els = {}, unread = 0, initialDone = false;

    function hhmm(d) { try { return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } }
    function status(ok, txt) { var s = $('lc-s'); s.textContent = txt; s.style.color = ok ? '#b9f6ca' : '#ffe0b2'; }
    function nearBottom() { return m.scrollHeight - m.scrollTop - m.clientHeight < 140; }
    function toBottom() { m.scrollTop = m.scrollHeight; }

    /* ---------- photo viewer + save ---------- */
    var viewUrl = '';
    function openViewer(url) { viewUrl = url; $('lc-v').querySelector('img').src = url; $('lc-v').classList.add('on'); }
    $('lc-vc').onclick = function () { $('lc-v').classList.remove('on'); };
    $('lc-vs').onclick = function () {
      fetch(viewUrl).then(function (r) { return r.blob(); }).then(function (b) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'photo-' + Date.now() + '.jpg';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      }).catch(function () { window.open(viewUrl, '_blank'); });
    };

    /* ---------- rendering ---------- */
    function closeSel() { Array.prototype.forEach.call(m.querySelectorAll('.lc-r.sel'), function (e) { e.classList.remove('sel'); }); }
    function render(x) {
      var mine = x.from === 'customer', r = els[x._id], isNew = !r;
      var wasSel = r && r.classList.contains('sel'), stick = nearBottom() || mine;
      if (!r) { r = document.createElement('div'); els[x._id] = r; m.appendChild(r); }
      r.innerHTML = '';
      var liked = x.liked && (x.liked.customer || x.liked.admin);
      r.className = 'lc-r ' + (mine ? 'me' : 'ag') + (liked && !x.deleted ? ' liked' : '') + (wasSel ? ' sel' : '');
      var b = document.createElement('div'); b.className = 'lc-bb';
      if (x.deleted) { b.className += ' del'; b.textContent = '🚫 This message was deleted'; r.appendChild(b); }
      else {
        if (x.image) {
          var im = document.createElement('img'); im.className = 'lc-img'; im.loading = 'lazy'; im.alt = 'Photo';
          var url = API + x.image; im.src = url;
          im.onclick = function (e) { e.stopPropagation(); openViewer(url); };
          im.onload = function () { if (stick) toBottom(); };
          b.appendChild(im);
        }
        if (x.text) { var t = document.createElement('div'); t.textContent = x.text; b.appendChild(t); }
        if (liked) { var h = document.createElement('span'); h.className = 'lc-hr'; h.textContent = '❤️'; b.appendChild(h); }
        b.onclick = function () { var was = r.classList.contains('sel'); closeSel(); if (!was) r.classList.add('sel'); };
        r.appendChild(b);
        var tm = document.createElement('div'); tm.className = 'lc-tm'; tm.textContent = hhmm(x.createdAt); r.appendChild(tm);
        var act = document.createElement('div'); act.className = 'lc-act';
        var lk = document.createElement('button'); lk.textContent = (x.liked && x.liked.customer) ? '💔 Unlike' : '❤️ Like';
        lk.onclick = function (e) { e.stopPropagation(); socket.emit('like', { id: x._id }); };
        var dl = document.createElement('button'); dl.className = 'dng'; dl.textContent = '🗑 Delete';
        var armed = false;
        dl.onclick = function (e) {
          e.stopPropagation();
          if (!armed) { armed = true; dl.textContent = 'Tap again to confirm'; setTimeout(function () { armed = false; dl.textContent = '🗑 Delete'; }, 3000); return; }
          socket.emit('delete', { id: x._id }, function (res) { if (!res || !res.ok) status(false, 'Could not delete — try again'); });
        };
        act.appendChild(lk); act.appendChild(dl); r.appendChild(act);
      }
      if (stick) toBottom();
      if (isNew && x.from === 'admin' && initialDone) {
        beep('recv');
        if (!w.classList.contains('on')) { unread++; var n = $('lc-n'); n.textContent = unread; n.style.display = 'flex'; }
      }
    }

    // welcome bubble + quick replies
    (function () {
      var r = document.createElement('div'); r.className = 'lc-r ag';
      var b = document.createElement('div'); b.className = 'lc-bb'; b.style.cursor = 'default'; b.textContent = C.welcome; r.appendChild(b); m.appendChild(r);
    })();
    C.chips.forEach(function (c) {
      c = c.trim(); if (!c) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'lc-ch'; b.textContent = c;
      b.onclick = function () { send({ text: c }); }; $('lc-c').appendChild(b);
    });

    /* ---------- socket events ---------- */
    socket.on('connect', function () {
      status(true, '● Online');
      socket.emit('history', null, function (list) { (list || []).forEach(render); initialDone = true; toBottom(); });
    });
    socket.on('disconnect', function () { status(false, 'Reconnecting…'); });
    socket.on('connect_error', function () { status(false, 'Reconnecting…'); });
    socket.on('msg', render);
    socket.on('msg:update', function (x) { if (els[x._id]) render(x); });
    socket.on('msg:remove', function (x) { var e = els[x._id]; if (e) { e.remove(); delete els[x._id]; } });

    /* ---------- sending ---------- */
    function userInfo() { try { return JSON.parse(localStorage.getItem(C.userKey) || '{}') || {}; } catch (_) { return {}; } }
    function send(p) {
      if (!socket.connected) { status(false, 'No connection — retrying…'); return false; }
      var u = userInfo(); p.name = u.name || u.fullName; p.phone = u.phone;
      socket.emit('msg', p, function (r) {
        if (r && r.ok) { beep('send'); status(true, '● Online'); }
        else status(false, (r && r.error) || 'Message not sent — please try again');
      });
      return true;
    }
    function compress(file, cb) {
      var fr = new FileReader();
      fr.onerror = function () { cb(new Error('read')); };
      fr.onload = function () {
        var img = new Image();
        img.onerror = function () { cb(new Error('image')); };
        img.onload = function () {
          var s = Math.min(1, 1280 / Math.max(img.width, img.height));
          var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
          var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
          var q = 0.8, d = c.toDataURL('image/jpeg', q);
          while (d.length > 2.2e6 && q > 0.4) { q -= 0.1; d = c.toDataURL('image/jpeg', q); }
          cb(null, d);
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    }
    $('lc-p').onclick = function () { $('lc-file').click(); };
    $('lc-file').onchange = function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (!/^image\//.test(f.type)) return status(false, 'Please choose a photo');
      if (f.size > 20 * 1024 * 1024) return status(false, 'Photo is too large');
      status(true, 'Sending photo…');
      compress(f, function (err, data) {
        if (err) return status(false, 'Could not read that photo');
        var i = $('lc-i'), cap = i.value.trim();
        if (send({ image: data, text: cap })) { i.value = ''; i.style.height = '44px'; }
      });
    };

    function open() {
      unlock(); w.classList.add('on'); $('lc-b').style.display = 'none'; $('lc-l').style.display = 'none'; labelDone = true; if (labelTimer) { clearTimeout(labelTimer); labelTimer = null; }
      unread = 0; $('lc-n').style.display = 'none';
      try { sessionStorage.setItem('lc_seen', '1'); } catch (_) {}
      toBottom(); fit();
      if (window.innerWidth > 520) $('lc-i').focus();
    }
    var shown = A('start-hidden', '') ? false : true;   // host page decides where the bubble is visible
    function close() { w.classList.remove('on'); $('lc-b').style.display = shown ? 'flex' : 'none'; document.body.style.overflow = ''; fit(); }
    var labelTimer = null, labelDone = false, LABEL_MS = (parseFloat(A('label-seconds', '4')) || 4) * 1000;
    function hideLabel() {
      var l = $('lc-l'); if (labelTimer) { clearTimeout(labelTimer); labelTimer = null; }
      l.style.opacity = '0'; setTimeout(function () { l.style.display = 'none'; }, 450);
    }
    function setVisible(v) {
      shown = !!v;
      if (w.classList.contains('on')) return;              // never hide a chat the customer has open
      $('lc-b').style.display = shown ? 'flex' : 'none';
      var l = $('lc-l');
      if (!shown) { l.style.display = 'none'; return; }
      if (labelDone) { l.style.display = 'none'; return; }
      var seen = false; try { seen = !!sessionStorage.getItem('lc_seen'); } catch (_) {}
      if (seen) { labelDone = true; l.style.display = 'none'; return; }
      if (labelTimer) return;                               // already counting down
      l.style.display = 'block'; l.style.opacity = '1';     // "Chat with us" shows briefly, then only the button stays
      labelTimer = setTimeout(function () { labelDone = true; labelTimer = null; hideLabel(); }, LABEL_MS);
    }
    $('lc-b').onclick = open; $('lc-l').onclick = open; $('lc-x').onclick = close;
    try { if (sessionStorage.getItem('lc_seen')) $('lc-l').style.display = 'none'; } catch (_) {}
    if (!shown) { $('lc-b').style.display = 'none'; $('lc-l').style.display = 'none'; }

    function fit() {  // keep the whole chat (incl. typing box) inside the visible area above the keyboard
      var vv = window.visualViewport;
      if (window.innerWidth <= 520 && w.classList.contains('on')) {
        var h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
        w.style.top = top + 'px'; w.style.height = h + 'px'; w.style.bottom = 'auto';
        document.body.style.overflow = 'hidden'; toBottom();
      } else { w.style.top = w.style.height = w.style.bottom = ''; }
    }
    if (window.visualViewport) { visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
    window.addEventListener('resize', fit);

    // Public API so the host page can open the chat or drop a message into it
    var pending = [];
    socket.on('connect', function () { while (pending.length) send({ text: pending.shift() }); });
    window.BiasharaChat = {
      open: open,
      close: close,
      setVisible: setVisible,
      send: function (text) { text = String(text || '').trim(); if (!text) return; if (!send({ text: text })) pending.push(text); },
      sendAndOpen: function (text) { this.send(text); open(); }
    };

    var inp = $('lc-i'), touch = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    function grow() { inp.style.height = '44px'; inp.style.height = Math.min(inp.scrollHeight + 2, 120) + 'px'; }
    function afterKeyboard() { [60, 250, 500].forEach(function (t) { setTimeout(function () { fit(); toBottom(); try { inp.scrollIntoView({ block: 'nearest' }); } catch (_) {} }, t); }); }
    inp.addEventListener('input', grow);
    inp.addEventListener('focus', afterKeyboard);
    inp.addEventListener('keydown', function (e) {   // desktop: Enter sends, Shift+Enter = new line. Phone: Enter = new line, use Send button
      if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); if ($('lc-f').requestSubmit) $('lc-f').requestSubmit(); else $('lc-go').click(); }
    });
    $('lc-f').onsubmit = function (e) {
      e.preventDefault(); var t = inp.value.trim();
      if (t && send({ text: t })) { inp.value = ''; grow(); }
      inp.focus();
    };

    function startConnect() {
      load(connectReal, function () { status(false, 'Chat offline — retrying…'); setTimeout(startConnect, 15000); });
    }
    startConnect();
    try { window.dispatchEvent(new Event('biashara-chat-ready')); } catch (_) {}
  }
})();
        
