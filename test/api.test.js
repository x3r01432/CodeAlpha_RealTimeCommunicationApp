const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io: ioc } = require('socket.io-client');
process.env.MAX_PEERS = '3';
const { createApp } = require('../src/app');
const E2E = require('../public/crypto');

let app, server, io, url, roomId; const T = {};
const as = (u) => ({ Authorization: `Bearer ${T[u]}` });
const connect = (u) => new Promise((res, rej) => { const s = ioc(url, { auth: { token: T[u] }, reconnection: false, forceNew: true }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const once = (s, ev) => new Promise((r) => s.once(ev, r));
before(async () => {
  
  ({ app, server, io } = createApp({ dbFile: ':memory:' }));
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
  for (const u of ['steven', 'ana', 'lee', 'zoe']) T[u] = (await request(app).post('/api/register').send({ username: u, password: 'password1' })).body.token;
});
after(() => { io.close(); server.close(); });

test('auth: bcrypt hash stored, bad login rejected', async () => {
  assert.match(app.locals.db.prepare("SELECT password_hash h FROM users WHERE username='steven'").get().h, /^\$2/);
  assert.strictEqual((await request(app).post('/api/login').send({ username: 'steven', password: 'nope' })).status, 401);
  assert.strictEqual((await request(app).get('/api/rooms')).status, 401);
});
test('config exposes public STUN servers', async () => {
  const r = await request(app).get('/api/config').set(as('steven'));
  assert.ok(r.body.iceServers[0].urls.some((u) => u.startsWith('stun:')));
});
test('create and list rooms', async () => {
  assert.strictEqual((await request(app).post('/api/rooms').set(as('steven')).send({ name: '' })).status, 400);
  const r = await request(app).post('/api/rooms').set(as('steven')).send({ name: 'Team standup' });
  assert.strictEqual(r.status, 201); roomId = r.body.id;
  assert.match(roomId, /^[0-9a-f]{10}$/);
  assert.strictEqual((await request(app).get('/api/rooms').set(as('ana'))).body[0].name, 'Team standup');
});
test('socket requires a valid JWT', async () => {
  const s = ioc(url, { auth: { token: 'bad' }, reconnection: false, forceNew: true });
  assert.strictEqual((await once(s, 'connect_error')).message, 'unauthorized'); s.close();
});
test('signaling: join, peer list, offer relay, chat, whiteboard, room limit, leave', async () => {
  const a = await connect('steven'), b = await connect('ana');
  assert.deepStrictEqual((await a.emitWithAck('join', 'nope')), { error: 'Room not found' });
  const ja = await a.emitWithAck('join', roomId);
  assert.deepStrictEqual(ja.peers, []);
  const joined = once(a, 'peer-joined');
  const jb = await b.emitWithAck('join', roomId);
  assert.deepStrictEqual(jb.peers.map((p) => p.username), ['steven']);
  assert.strictEqual((await joined).username, 'ana');

  // new peer sends offer to existing peer (mesh)
  const got = once(a, 'signal');
  b.emit('signal', { to: ja.self, data: { type: 'offer', sdp: 'v=0' } });
  const sig = await got;
  assert.strictEqual(sig.from, jb.self); assert.strictEqual(sig.data.type, 'offer');

  // encrypted chat is relayed as opaque ciphertext
  const key = await E2E.deriveKey('s3cret', roomId);
  const chatB = once(b, 'chat');
  a.emit('chat', await E2E.encrypt(key, 'hello team'));
  const m = await chatB;
  assert.notStrictEqual(m.ct, 'hello team');
  assert.strictEqual(await E2E.decrypt(await E2E.deriveKey('s3cret', roomId), m), 'hello team');
  await assert.rejects(E2E.decrypt(await E2E.deriveKey('wrong', roomId), m));

  // whiteboard strokes broadcast and replayed for late joiners
  const st = once(b, 'wb:stroke');
  a.emit('wb:stroke', { color: '#ff0000', size: 4, points: [[0, 0], [10, 10]] });
  assert.deepStrictEqual((await st).points, [[0, 0], [10, 10]]);
  const c = await connect('lee');
  const jc = await c.emitWithAck('join', roomId);
  assert.strictEqual(jc.strokes.length, 1);
  assert.strictEqual(jc.peers.length, 2);

  // room limit (MAX_PEERS=3)
  const d = await connect('zoe');
  assert.match((await d.emitWithAck('join', roomId)).error, /full/);

  const left = once(a, 'peer-left');
  c.close();
  assert.strictEqual((await left).username, 'lee');
  [a, b, d].forEach((s) => s.close());
});
test('signals cannot be sent to sockets outside the room', async () => {
  const a = await connect('steven'), z = await connect('zoe');
  let leaked = false; z.on('signal', () => (leaked = true));
  await a.emitWithAck('join', roomId);
  a.emit('signal', { to: z.id, data: { type: 'offer' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(leaked, false);
  a.close(); z.close();
});
