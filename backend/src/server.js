// src/server.js
import express     from 'express';
import cors        from 'cors';
import helmet      from 'helmet';
import compression from 'compression';
import rateLimit   from 'express-rate-limit';
import { randomBytes } from 'crypto';
import routes      from './routes.js';
import { initDb, users } from './db.js';
import { initAuth, needsSetup, setup, login, logout, validateToken, hashPassword, verifyPassword, revokeUserSessions } from './auth.js';

// ── STRUCTURED LOGGER ─────────────────────────────────────
// Single place to format log lines — swap for a real logger later if needed.
function log(level, msg, fields = {}) {
  const ts     = new Date().toISOString();
  const extras = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ');
  console[level === 'error' ? 'error' : 'log'](`[${ts}] [${level.toUpperCase()}] ${msg}${extras ? ' ' + extras : ''}`);
}

const PORT = process.env.PORT || 3000;

const app = express();

// ── COOKIE HELPER (no external dependency) ────────────────
function parseCookie(header, name) {
  if (!header) return null;
  const entry = header.split(';').find(s => s.trim().startsWith(name + '='));
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : null;
}
const SESSION_COOKIE = 'flujo_session';
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'Strict',
  secure:   process.env.NODE_ENV === 'production',
  path:     '/api/events',   // narrow scope — only sent with SSE endpoint
};

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:"],
      connectSrc:  ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────
// Exact-match only — startsWith would allow https://allowed.evil.com to pass
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || 'http://localhost:8080').split(',').map(s => s.trim())
);
app.use(cors({
  origin: (origin, cb) => (!origin || allowedOrigins.has(origin)) ? cb(null, true) : cb(new Error('CORS')),
  methods: ['GET', 'PUT', 'POST', 'DELETE'],
}));

app.use(express.json({ limit: '1mb' }));

// ── REQUEST ID + STRUCTURED LOGGER ───────────────────────
app.use((req, res, next) => {
  req.id = randomBytes(4).toString('hex');   // 8-char hex — cheap, no uuid dep
  req._startMs = Date.now();
  res.setHeader('X-Request-Id', req.id);
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/events')) return next(); // skip SSE heartbeat spam
  res.on('finish', () => {
    const ms   = Date.now() - req._startMs;
    const user = req.user || '-';
    log('info', 'request', { id: req.id, method: req.method, path: req.path, user, status: res.statusCode, ms });
  });
  next();
});

// ── PUBLIC ENDPOINTS (no token required) ─────────────────
// Rate-limit health to prevent enumeration / DDoS
const healthLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
app.get('/api/health', healthLimiter, (_req, res) => {
  res.json({
    ok:            true,
    setupRequired: needsSetup(),
    loginRequired: !needsSetup(),
  });
});

// Password complexity: min 8 chars, at least one letter and one digit/special char
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8)
    return 'password must be at least 8 characters';
  if (!/[a-zA-Z]/.test(password))
    return 'password must contain at least one letter';
  if (!/[0-9!@#$%^&*()_+\-=[\]{};:,.<>?]/.test(password))
    return 'password must contain at least one number or special character';
  return null;
}

// Setup: one-time admin account creation (only works while setupToken is alive)
const setupLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/setup', setupLimiter, (req, res) => {
  if (!needsSetup())
    return res.status(409).json({ error: 'Setup already completed' });
  const { setupToken, username, password } = req.body ?? {};
  if (!setupToken || !username || !password)
    return res.status(400).json({ error: 'setupToken, username and password required' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const token = setup(String(setupToken), String(username).trim(), String(password));
  if (!token)
    return res.status(401).json({ error: 'Invalid setup token' });
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTS).json({ ok: true, token });
});

// Login — only failed attempts count against the limit (skipSuccessfulRequests)
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders:  false,
});
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  const token = login(String(username), String(password));
  if (!token)
    return res.status(401).json({ error: 'Invalid credentials' });
  res.cookie(SESSION_COOKIE, token, COOKIE_OPTS).json({ ok: true, token });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-flujo-token'] || parseCookie(req.headers.cookie, SESSION_COOKIE);
  if (token) logout(token);
  res.clearCookie(SESSION_COOKIE, { path: COOKIE_OPTS.path }).json({ ok: true });
});

// ── TOKEN AUTH MIDDLEWARE ─────────────────────────────────
// All remaining /api/* routes require a valid session token.
// Sets req.user = userId (integer) so routes scope data per user.
app.use('/api', (req, res, next) => {
  const token  = req.headers['x-flujo-token'] || parseCookie(req.headers.cookie, SESSION_COOKIE);
  const userId = validateToken(token);
  if (!userId)
    return res.status(401).json({ error: 'Login required' });
  req.user = userId;
  next();
});

// ── RATE LIMIT (authenticated routes) ─────────────────────
// Must be registered before any route handlers so all /api/* routes are covered
app.use('/api', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api/import', rateLimit({ windowMs: 10 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false }));

// Current user info (used by frontend to get username + role after login)
app.get('/api/me', (req, res) => {
  const row = users.getByIdPublic(req.user);
  res.json({ username: row?.username || '', role: row?.role || 'user' });
});

// ── ADMIN — user management (admin role required) ─────────
const requireAdmin = (req, res, next) => {
  const row = users.getByIdPublic(req.user);
  if (row?.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  next();
};

// List all users (no passwords)
app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(users.getAll());
});

// Create a new user — role is always 'user', not selectable
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (typeof username !== 'string' || username.length < 2 || username.length > 80)
    return res.status(400).json({ error: 'username must be 2–80 characters' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (users.getByUsernamePublic(username.trim()))
    return res.status(409).json({ error: 'Username already exists' });
  const hash = hashPassword(password);
  const row  = users.create(username.trim(), hash, 'user');
  res.status(201).json({ id: row.id, username: row.username, role: row.role, created_at: row.created_at });
});

// Delete a user (admin cannot delete themselves)
app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const target = users.getByUsernamePublic(req.params.username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  users.delete(target.id);
  revokeUserSessions(target.id);
  res.json({ ok: true });
});

// Change own password (any authenticated user)
app.post('/api/user/password', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'currentPassword and newPassword required' });
    const row = users.getById(req.user);
    if (!row) return res.status(404).json({ error: 'User not found' });
    if (!verifyPassword(currentPassword, row.password))
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    const pwErr = validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    users.updatePassword(req.user, hashPassword(newPassword));
    res.json({ ok: true });
  } catch (e) {
    log('error', 'password change failed', { id: req.id, user: req.user, msg: e.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── ROUTES ────────────────────────────────────────────────
app.use('/api', routes);
app.use('/api/*path', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── ERROR ─────────────────────────────────────────────────
// Log full error internally; never expose internal details to the client
app.use((err, req, res, _next) => {
  log('error', 'unhandled error', { id: req.id, method: req.method, path: req.path, msg: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────
initDb();
initAuth(); // must run after initDb — checks user count and may print setup token
app.listen(PORT, '0.0.0.0', () => console.log(`[flujo-api] :${PORT}`));
