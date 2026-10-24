const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const session = () => JSON.parse(localStorage.getItem('meet_session') || 'null');
const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB');
async function api(path, opts = {}) {
  const s = session();
  const res = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json();
  if (res.status === 401 && s) { localStorage.removeItem('meet_session'); route(); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function toast(m) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 3000); }
function header() {
  const s = session();
  $('#who').innerHTML = s ? `<span class="badge">👤 ${esc(s.user.username)}</span> <a href="#" id="lo">Log out</a>` : '';
  if (s) $('#lo').onclick = (e) => { e.preventDefault(); call?.leave(); localStorage.removeItem('meet_session'); location.hash = '#/'; route(); };
}
const genPass = () => [...crypto.getRandomValues(new Uint8Array(9))].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

// ================= Call (WebRTC mesh) =================
let call = null;
class Call {
  constructor(room, pass, cfg) {
    this.room = room; this.pass = pass; this.cfg = cfg;
    this.peers = new Map(); // socketId -> { pc, name, dc, polite }
    this.state = { mic: true, cam: true, screen: false };
    this.incoming = new Map();
  }
  async start() {
    this.key = await E2E.deriveKey(this.pass, this.room.id);
    try { this.local = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: true }); }
    catch { toast('Camera/mic unavailable – joining without media'); this.local = new MediaStream(); this.state.cam = this.state.mic = false; }
    this.camTrack = this.local.getVideoTracks()[0];
    addTile('local', session().user.username + ' (you)', this.local, true);
    this.socket = io({ auth: { token: session().token } });
    this.socket.on('connect_error', (e) => toast('Connection error: ' + e.message));
    this.socket.on('peer-joined', ({ id, username }) => { toast(`${username} joined`); this.peers.set(id, { name: username, pending: true }); });
    this.socket.on('peer-left', ({ id, username }) => { toast(`${username} left`); this.drop(id); });
    this.socket.on('signal', (m) => this.onSignal(m));
    this.socket.on('chat', (m) => this.onChat(m));
    this.socket.on('media-state', (s) => { const f = $(`#tile-${CSS.escape(s.id)} .flags`); if (f) f.textContent = (s.mic ? '' : '🔇') + (s.cam || s.screen ? '' : ' 📷✖') + (s.screen ? ' 🖥️' : ''); });
    this.socket.on('wb:stroke', (s) => wb.draw(s));
    this.socket.on('wb:clear', ({ by }) => { wb.clear(); toast(`${by} cleared the whiteboard`); });
    const r = await this.socket.emitWithAck('join', this.room.id);
    if (r.error) { toast(r.error); location.hash = '#/'; return; }
    this.self = r.self;
    r.strokes.forEach((s) => wb.draw(s));
    // mesh: the newcomer calls every existing peer
    for (const p of r.peers) this.connect(p.id, p.username, true);
  }
  connect(id, name, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.cfg.iceServers });
    const peer = { pc, name, polite: !initiator, makingOffer: false };
    this.peers.set(id, peer);
    this.local.getTracks().forEach((t) => pc.addTrack(t, this.local));
    if (!this.local.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    if (!this.local.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (e) => e.candidate && this.socket.emit('signal', { to: id, data: { candidate: e.candidate } });
    pc.ontrack = (e) => addTile(id, name, e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
    pc.onnegotiationneeded = async () => {
      try { peer.makingOffer = true; await pc.setLocalDescription(); this.socket.emit('signal', { to: id, data: { description: pc.localDescription } }); }
      finally { peer.makingOffer = false; }
    };
    if (initiator) this.setupDc(id, pc.createDataChannel('files', { ordered: true }));
    pc.ondatachannel = (e) => this.setupDc(id, e.channel);
    return peer;
  }
  // "perfect negotiation" pattern so renegotiation (e.g. screen share) is glare-safe
  async onSignal({ from, username, data }) {
    let peer = this.peers.get(from);
    if (!peer || !peer.pc) peer = this.connect(from, username, false);
    const pc = peer.pc;
    if (data.description) {
      const collision = data.description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignore = !peer.polite && collision;
      if (peer.ignore) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') { await pc.setLocalDescription(); this.socket.emit('signal', { to: from, data: { description: pc.localDescription } }); }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignore) console.warn(e); }
    }
  }
  drop(id) { const p = this.peers.get(id); p?.pc?.close(); this.peers.delete(id); $(`#tile-${CSS.escape(id)}`)?.remove(); }
  sendState() { this.socket.emit('media-state', this.state); }
  toggle(kind) {
    const tr = kind === 'mic' ? this.local.getAudioTracks()[0] : this.camTrack;
    if (!tr) return toast('No ' + (kind === 'mic' ? 'microphone' : 'camera'));
    tr.enabled = !tr.enabled; this.state[kind] = tr.enabled; this.sendState(); return tr.enabled;
  }
  async shareScreen() {
    if (this.state.screen) return this.stopScreen();
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return; }
    this.screenTrack = stream.getVideoTracks()[0];
    this.screenTrack.onended = () => this.stopScreen();
    await this.replaceVideo(this.screenTrack);
    this.state.screen = true; this.sendState();
    $('#tile-local').classList.add('screen'); $('#tile-local video').srcObject = stream; $('#scr').classList.add('on');
  }
  async stopScreen() {
    this.screenTrack?.stop(); this.screenTrack = null;
    await this.replaceVideo(this.camTrack || null);
    this.state.screen = false; this.sendState();
    $('#tile-local')?.classList.remove('screen'); if ($('#tile-local video')) $('#tile-local video').srcObject = this.local; $('#scr')?.classList.remove('on');
  }
  async replaceVideo(track) {
    for (const { pc } of this.peers.values()) {
      if (!pc) continue;
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video' || (s.track === null && pc.getTransceivers().find((t) => t.sender === s)?.receiver.track.kind === 'video'));
      if (sender) await sender.replaceTrack(track); else if (track) pc.addTrack(track, this.local);
    }
  }
  // ---- encrypted chat ----
  async sendChat(text) { this.socket.emit('chat', await E2E.encrypt(this.key, text)); }
  async onChat(m) {
    let text; try { text = await E2E.decrypt(this.key, m); } catch { text = '🔒 [message could not be decrypted – different room key]'; }
    chatLine(m.from, text, m.at);
  }
  // ---- file sharing over RTCDataChannel ----
  setupDc(id, dc) {
    dc.binaryType = 'arraybuffer';
    const peer = this.peers.get(id); peer.dc = dc;
    dc.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        if (m.t === 'meta') this.incoming.set(id, { ...m, chunks: [], got: 0, el: fileRow(`${m.name} from ${peer.name}`, m.size) });
        if (m.t === 'done') {
          const f = this.incoming.get(id); this.incoming.delete(id);
          const url = URL.createObjectURL(new Blob(f.chunks, { type: f.mime }));
          f.el.querySelector('.act').innerHTML = `<a class="btn" href="${url}" download="${esc(f.name)}">Download</a>`;
          toast(`📎 ${peer.name} shared ${f.name}`);
        }
      } else {
        const f = this.incoming.get(id); if (!f) return;
        f.chunks.push(e.data); f.got += e.data.byteLength; f.el.querySelector('progress').value = f.got / f.size;
      }
    };
  }
  async sendFile(file) {
    if (file.size > 50e6) return toast('Max file size is 50 MB');
    const targets = [...this.peers.values()].filter((p) => p.dc?.readyState === 'open');
    if (!targets.length) return toast('Nobody else is in the room yet');
    const row = fileRow(`${file.name} (sent to ${targets.length})`, file.size);
    const buf = await file.arrayBuffer(); const CH = 16 * 1024;
    for (const p of targets) p.dc.send(JSON.stringify({ t: 'meta', name: file.name, size: file.size, mime: file.type }));
    for (let o = 0; o < buf.byteLength; o += CH) {
      for (const p of targets) {
        if (p.dc.bufferedAmount > 1e6) await new Promise((r) => { p.dc.bufferedAmountLowThreshold = 256e3; p.dc.onbufferedamountlow = r; });
        p.dc.send(buf.slice(o, o + CH));
      }
      row.querySelector('progress').value = Math.min(1, (o + CH) / buf.byteLength);
    }
    for (const p of targets) p.dc.send(JSON.stringify({ t: 'done' }));
    row.querySelector('.act').textContent = '✅ sent';
  }
  leave() {
    this.socket?.emit('leave'); this.socket?.disconnect();
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.local?.getTracks().forEach((t) => t.stop()); this.screenTrack?.stop();
    document.body.classList.remove('inroom', 'wbbig'); $('#sec').hidden = true; call = null;
  }
}
function addTile(id, name, stream, muted) {
  let t = $(`#tile-${CSS.escape(id)}`);
  if (!t) {
    t = document.createElement('div'); t.className = 'tile'; t.id = 'tile-' + id;
    t.innerHTML = `<video autoplay playsinline ${muted ? 'muted' : ''}></video><span class="name">${esc(name)}</span><span class="flags"></span>`;
    $('#videos').appendChild(t);
  }
  const v = $('video', t); if (v.srcObject !== stream) v.srcObject = stream;
}
function chatLine(from, text, at) {
  const box = $('#msgs'); if (!box) return;
  box.insertAdjacentHTML('beforeend', `<div class="msg"><b>${esc(from)}</b> <span class="muted" style="font-size:11px">${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><div>${esc(text)}</div></div>`);
  box.scrollTop = box.scrollHeight;
}
function fileRow(label, size) {
  const d = document.createElement('div'); d.className = 'file';
  d.innerHTML = `<div style="flex:1"><div>📄 ${esc(label)}</div><span class="muted" style="font-size:12px">${fmtSize(size)}</span><progress value="0" max="1"></progress></div><div class="act" style="margin-left:10px">…</div>`;
  $('#files').appendChild(d); return d;
}

// ================= Whiteboard =================
const wb = {
  color: '#111827', size: 4, erase: false, strokes: [],
  init(canvas) {
    this.c = canvas; this.ctx = canvas.getContext('2d');
    const fit = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * devicePixelRatio; canvas.height = r.height * devicePixelRatio; this.redraw(); };
    new ResizeObserver(fit).observe(canvas);
    let cur = null;
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return [+((e.clientX - r.left) / r.width).toFixed(4), +((e.clientY - r.top) / r.height).toFixed(4)]; };
    canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); cur = { color: this.color, size: this.size, erase: this.erase, points: [pt(e)] }; };
    canvas.onpointermove = (e) => { if (!cur) return; cur.points.push(pt(e)); this.seg(cur, cur.points.length - 2); };
    canvas.onpointerup = () => { if (!cur) return; if (cur.points.length === 1) cur.points.push(cur.points[0]); this.strokes.push(cur); call?.socket.emit('wb:stroke', cur); cur = null; };
  },
  seg(s, i) {
    const { ctx, c } = this; if (!ctx || i < 0) return;
    const [a, b] = [s.points[i], s.points[i + 1]];
    ctx.strokeStyle = s.erase ? '#ffffff' : s.color; ctx.lineWidth = (s.erase ? s.size * 4 : s.size) * devicePixelRatio; ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a[0] * c.width, a[1] * c.height); ctx.lineTo(b[0] * c.width, b[1] * c.height); ctx.stroke();
  },
  draw(s) { this.strokes.push(s); for (let i = 0; i < s.points.length - 1; i++) this.seg(s, i); },
  redraw() { if (!this.ctx) return; this.ctx.clearRect(0, 0, this.c.width, this.c.height); for (const s of this.strokes) for (let i = 0; i < s.points.length - 1; i++) this.seg(s, i); },
  clear() { this.strokes = []; this.redraw(); },
};

// ================= Views =================
const views = {
  async home() {
    const rooms = await api('/rooms');
    $('#view').innerHTML = `<div class="row between"><h1>Meeting rooms</h1></div><div class="grid">
    <div class="card"><h3>➕ New room</h3><input id="rn" placeholder="Room name, e.g. Daily standup"><button class="btn" id="rc" style="margin-top:10px">Create & join</button><p class="err" id="err"></p></div>
    ${rooms.map((r) => `<div class="card"><h3>${esc(r.name)}</h3><p class="muted">by ${esc(r.creator)} · ${r.online} online</p><code class="muted">${r.id}</code><div style="margin-top:10px"><a class="btn" href="#/r/${r.id}">Join</a></div></div>`).join('')}</div>
    <div class="card" style="margin-top:20px"><h3>🔒 How your call is protected</h3><ul class="muted"><li>Audio, video and files go peer-to-peer and are encrypted by WebRTC (DTLS-SRTP / DTLS-SCTP).</li><li>Chat messages are AES-256-GCM encrypted in your browser with a key derived (PBKDF2) from the room passphrase. The server only relays ciphertext.</li><li>Passwords are hashed with bcrypt; API and signaling use JWT.</li></ul></div>`;
    $('#rc').onclick = async () => { try { const r = await api('/rooms', { method: 'POST', body: { name: $('#rn').value } }); location.hash = `#/r/${r.id}/${genPass()}`; } catch (e) { $('#err').textContent = e.message; } };
  },
  async r(id, pass) {
    const room = await api('/rooms/' + id);
    if (!pass) {
      $('#view').innerHTML = `<div class="card auth"><h2>Join “${esc(room.name)}”</h2><p class="muted">Enter the room passphrase from your invite link. It is used to decrypt chat and never leaves your browser.</p><input id="pp" placeholder="Room passphrase"><button class="btn" id="pj" style="margin-top:10px;width:100%">Join call</button></div>`;
      $('#pj').onclick = () => $('#pp').value.trim() && (location.hash = `#/r/${id}/${encodeURIComponent($('#pp').value.trim())}`);
      return;
    }
    pass = decodeURIComponent(pass);
    const cfg = await api('/config');
    document.body.classList.add('inroom'); $('#sec').hidden = false;
    $('#view').innerHTML = `<div class="room"><div class="stage"><div class="row between"><div><b style="font-size:18px">${esc(room.name)}</b> <span class="muted">· room ${room.id}</span></div><button class="btn ghost" id="inv">🔗 Copy invite link</button></div>
      <div class="videos" id="videos"></div>
      <div class="controls"><button class="ctl" id="mic" title="Mute">🎤</button><button class="ctl" id="cam" title="Camera">📷</button><button class="ctl" id="scr" title="Share screen">🖥️</button><button class="ctl" id="wbb" title="Whiteboard">✏️</button><button class="ctl leave" id="lv">Leave</button></div></div>
      <div class="panel"><div class="tabs"><button data-t="chat" class="act">💬 Chat</button><button data-t="files">📎 Files</button><button data-t="board">🖍️ Whiteboard</button></div>
      <div class="pane" data-p="chat"><div class="lock">🔒 End-to-end encrypted (AES-256-GCM)</div><div class="msgs" id="msgs"></div><div class="row"><input id="ci" placeholder="Message everyone…" maxlength="1000"><button class="btn" id="cs">Send</button></div></div>
      <div class="pane" data-p="files" hidden><div class="lock">🔒 Sent peer-to-peer over encrypted WebRTC data channels</div><label class="btn" style="text-align:center">Choose a file to share<input type="file" id="fi" hidden></label><div id="files" class="msgs"></div></div>
      <div class="pane" data-p="board" hidden><div class="wbtools">${['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed'].map((c, i) => `<span style="background:${c}" data-c="${c}" class="${i ? '' : 'sel'}"></span>`).join('')}<button class="btn ghost" id="er" style="padding:4px 10px">Eraser</button><button class="btn danger" id="wc" style="padding:4px 10px;margin-left:auto">Clear</button></div><div class="wbwrap"><canvas id="wb"></canvas></div></div></div></div>`;
    const tab = (t) => { document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('act', b.dataset.t === t)); document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.p !== t)); document.body.classList.toggle('wbbig', t === 'board'); };
    document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => tab(b.dataset.t)));
    wb.strokes = []; wb.init($('#wb'));
    document.querySelectorAll('[data-c]').forEach((s) => (s.onclick = () => { wb.color = s.dataset.c; wb.erase = false; document.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('sel', x === s)); }));
    $('#er').onclick = () => (wb.erase = !wb.erase);
    $('#wc').onclick = () => call?.socket.emit('wb:clear');
    call = new Call(room, pass, cfg);
    await call.start();
    $('#mic').onclick = () => $('#mic').classList.toggle('off', call.toggle('mic') === false);
    $('#cam').onclick = () => $('#cam').classList.toggle('off', call.toggle('cam') === false);
    if (!call.state.mic) $('#mic').classList.add('off'); if (!call.state.cam) $('#cam').classList.add('off');
    $('#scr').onclick = () => call.shareScreen();
    $('#wbb').onclick = () => tab('board');
    $('#lv').onclick = () => { call.leave(); location.hash = '#/'; };
    $('#inv').onclick = () => { navigator.clipboard?.writeText(location.href); toast('Invite link copied (contains the room key)'); };
    const send = () => { if ($('#ci').value.trim()) { call.sendChat($('#ci').value.trim()); $('#ci').value = ''; } };
    $('#cs').onclick = send; $('#ci').onkeydown = (e) => e.key === 'Enter' && send();
    $('#fi').onchange = () => { const f = $('#fi').files[0]; if (f) call.sendFile(f); $('#fi').value = ''; };
  },
  login() {
    $('#view').innerHTML = `<div class="card auth"><div style="text-align:center;font-size:48px">🎥</div><h2 id="t" style="text-align:center">Log in to MeetUp</h2><label>Username</label><input id="u"><label>Password</label><input id="p" type="password"><p class="err" id="err"></p><button class="btn" id="go" style="width:100%">Log in</button><p class="muted" style="text-align:center">New here? <a href="#" id="sw">Create an account</a></p></div>`;
    let mode = 'login';
    $('#sw').onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; $('#t').textContent = mode === 'login' ? 'Log in to MeetUp' : 'Create your account'; $('#go').textContent = mode === 'login' ? 'Log in' : 'Sign up'; $('#sw').textContent = mode === 'login' ? 'Create an account' : 'Log in'; };
    const go = async () => { try { const s = await api('/' + mode, { method: 'POST', body: { username: $('#u').value, password: $('#p').value } }); localStorage.setItem('meet_session', JSON.stringify(s)); route(); } catch (e) { $('#err').textContent = e.message; } };
    $('#go').onclick = go; $('#p').onkeydown = (e) => e.key === 'Enter' && go();
  },
};
function route() {
  if (call) call.leave();
  header();
  if (!session()) return views.login();
  const [name, ...args] = location.hash.slice(2).split('/');
  Promise.resolve().then(() => (name === 'r' ? views.r(...args) : views.home())).catch((e) => ($('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`));
}
window.onhashchange = route; route();
