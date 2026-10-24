const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// In production set JWT_SECRET in the environment. A random per-process secret is used otherwise.
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const hash = (pw) => bcrypt.hashSync(pw, 10);
const check = (pw, h) => bcrypt.compareSync(pw, h);
const sign = (user) => jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '7d' });
const verify = (token) => jwt.verify(token, SECRET);

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try { req.user = verify(token); next(); } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

function validCreds(b) {
  const u = String(b?.username || '').trim();
  const p = String(b?.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(u)) return { error: 'Username must be 3-20 letters, numbers or _' };
  if (p.length < 6) return { error: 'Password must be at least 6 characters' };
  return { u, p };
}

module.exports = { hash, check, sign, verify, requireAuth, validCreds };
