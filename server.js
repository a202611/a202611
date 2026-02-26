require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');

const steamRouter = require('./steam');
const epicRouter  = require('./epic');
const xboxRouter  = require('./xbox');
const psnRouter   = require('./psn');
const apiRouter   = require('./api');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── TRUST RAILWAY'S REVERSE PROXY ───────────────────────────
// Without this, req.protocol is 'http' even though Railway serves https.
// Steam OpenID rejects http return_to URLs — this fixes that.
app.set('trust proxy', 1);

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ── STATIC FRONTEND ──────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── AUTH ROUTES ──────────────────────────────────────────────
app.use('/auth/steam', steamRouter);
app.use('/auth/epic',  epicRouter);
app.use('/auth/xbox',  xboxRouter);
app.use('/auth/psn',   psnRouter);

// ── PIONEER API PROXY ─────────────────────────────────────────
app.use('/api', apiRouter);

// ── SESSION STATUS ───────────────────────────────────────────
app.get('/me', requireAuth, (req, res) => {
  res.json({
    loggedIn:    true,
    userId:      req.session.userId,
    platform:    req.session.platform,
    embarkId:    req.session.embarkId,
    displayName: req.session.displayName,
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── HEALTH ───────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── CATCH-ALL → index.html ───────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

module.exports = { requireAuth };

app.listen(PORT, () => {
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`\n🚀 Pioneer Auth running on port ${PORT}`);
  console.log(`   URL: ${base}`);
  console.log(`   Steam callback: ${base}/auth/steam/callback`);
});
