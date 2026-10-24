const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { openDb } = require('./db');
const { iceServers, MAX_PEERS } = require('./config');
const { hash, check, sign, verify, requireAuth, validCreds } = require('./auth');

function createApp({ dbFile } = {}) {
  const db = openDb(dbFile);
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e6 });
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- auth ----------
  app.post('/api/register', (req, res) => {
    const v = validCreds(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(v.u)) return res.status(409).json({ error: 'Username taken' });
    const r = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(v.u, hash(v.p));
    const user = { id: Number(r.lastInsertRowid), username: v.u };
    res.status(201).json({ token: sign(user), user });
  });
  app.post('/api/login', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body?.username || ''));
    if (!row || !check(String(req.body?.password || ''), row.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: sign(row), user: { id: row.id, username: row.username } });
  });

  app.get('/api/config', requireAuth, (_req, res) => res.json({ iceServers: iceServers(), maxPeers: MAX_PEERS }));

  // ---------- rooms ----------
  const live = new Map(); // roomId -> Map(socketId -> {userId, username})
  const boards = new Map(); // roomId -> array of whiteboard strokes (kept in memory for late joiners)
  const roomInfo = (r) => ({ ...r, online: live.get(r.id)?.size || 0 });
  app.get('/api/rooms', requireAuth, (_req, res) => res.json(db.prepare('SELECT r.*, u.username creator FROM rooms r JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC').all().map(roomInfo)));
  app.post('/api/rooms', requireAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 50) return res.status(400).json({ error: 'Room name must be 1-50 characters' });
    const id = crypto.randomBytes(5).toString('hex');
    db.prepare('INSERT INTO rooms (id, name, created_by) VALUES (?,?,?)').run(id, name, req.user.id);
    res.status(201).json(roomInfo(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)));
  });
  app.get('/api/rooms/:id', requireAuth, (req, res) => {
    const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Room not found' });
    res.json(roomInfo(r));
  });

  // ---------- signaling ----------
  io.use((socket, next) => { try { socket.user = verify(socket.handshake.auth?.token); next(); } catch { next(new Error('unauthorized')); } });
  io.on('connection', (socket) => {
    let roomId = null;
    const leave = () => {
      if (!roomId) return;
      const peers = live.get(roomId);
      peers?.delete(socket.id);
      socket.to(roomId).emit('peer-left', { id: socket.id, username: socket.user.username });
      if (peers && !peers.size) { live.delete(roomId); boards.delete(roomId); }
      socket.leave(roomId); roomId = null;
    };
    socket.on('join', (id, ack) => {
      if (typeof ack !== 'function') return;
      if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id)) return ack({ error: 'Room not found' });
      const peers = live.get(id) || new Map();
      if (peers.size >= MAX_PEERS) return ack({ error: `Room is full (max ${MAX_PEERS})` });
      leave();
      const existing = [...peers].map(([sid, p]) => ({ id: sid, username: p.username }));
      peers.set(socket.id, { userId: socket.user.id, username: socket.user.username });
      live.set(id, peers); roomId = id; socket.join(id);
      socket.to(id).emit('peer-joined', { id: socket.id, username: socket.user.username });
      ack({ ok: true, self: socket.id, peers: existing, strokes: boards.get(id) || [] });
    });
    // relay SDP offers/answers and ICE candidates to one peer in the same room
    socket.on('signal', ({ to, data } = {}) => {
      if (!roomId || !live.get(roomId)?.has(to)) return;
      io.to(to).emit('signal', { from: socket.id, username: socket.user.username, data });
    });
    // chat: payload is AES-GCM ciphertext produced in the browser; the server only relays it
    socket.on('chat', (msg = {}) => {
      if (!roomId || typeof msg.ct !== 'string' || typeof msg.iv !== 'string' || msg.ct.length > 20000) return;
      io.to(roomId).emit('chat', { from: socket.user.username, ct: msg.ct, iv: msg.iv, at: Date.now() });
    });
    socket.on('media-state', (state = {}) => roomId && socket.to(roomId).emit('media-state', { id: socket.id, mic: !!state.mic, cam: !!state.cam, screen: !!state.screen }));
    // whiteboard
    socket.on('wb:stroke', (s = {}) => {
      if (!roomId || !Array.isArray(s.points) || s.points.length > 2000) return;
      const stroke = { color: String(s.color || '#000').slice(0, 9), size: Math.min(Number(s.size) || 3, 40), points: s.points, erase: !!s.erase };
      const list = boards.get(roomId) || []; list.push(stroke); if (list.length > 3000) list.shift(); boards.set(roomId, list);
      socket.to(roomId).emit('wb:stroke', stroke);
    });
    socket.on('wb:clear', () => { if (!roomId) return; boards.set(roomId, []); io.to(roomId).emit('wb:clear', { by: socket.user.username }); });
    socket.on('leave', leave);
    socket.on('disconnect', leave);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.locals.db = db;
  return { app, server, io };
}
module.exports = { createApp };
