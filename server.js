require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const steamRouter = require('./routes/steam');
const epicRouter  = require('./routes/epic');
const xboxRouter  = require('./routes/xbox');
const psnRouter   = require('./routes/psn');
const apiRouter   = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: process.env.BASE_URL, credentials: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
  }
}));

// ── STATIC FRONTEND ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── AUTH ROUTES ──────────────────────────────────────────────
app.use('/auth/steam', steamRouter);
app.use('/auth/epic',  epicRouter);
app.use('/auth/xbox',  xboxRouter);
app.use('/auth/psn',   psnRouter);

// ── PIONEER API PROXY ────────────────────────────────────────
app.use('/api', apiRouter);

// ── SESSION STATUS (frontend polls this) ────────────────────
app.get('/me', requireAuth, async (req, res) => {
  res.json({
    loggedIn: true,
    userId:   req.session.userId,
    platform: req.session.platform,
    embarkId: req.session.embarkId,
    displayName: req.session.displayName,
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── MIDDLEWARE EXPORT ────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

module.exports = { requireAuth };

app.listen(PORT, () => {
  console.log(`\n🚀 Pioneer Auth running on http://localhost:${PORT}`);
  console.log(`   Steam  → ${process.env.BASE_URL}/auth/steam`);
  console.log(`   Epic   → ${process.env.BASE_URL}/auth/epic`);
  console.log(`   Xbox   → ${process.env.BASE_URL}/auth/xbox`);
  console.log(`   PSN    → ${process.env.BASE_URL}/auth/psn\n`);
});
