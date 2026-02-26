/**
 * Steam → Embark Auth flow (corrected)
 *
 * Instead of doing our own Steam OpenID + manual token exchange,
 * we redirect the user through Embark's own Steam login flow.
 * Embark handles the Steam ticket internally and issues a Pioneer JWT.
 * We capture that JWT from the final redirect back to our callback.
 *
 * Flow:
 *   1. User hits /auth/steam
 *   2. We redirect to Embark's Steam login URL (auth.embark.net)
 *   3. Embark redirects to Steam, user logs in
 *   4. Steam redirects back to auth.embark.net
 *   5. Embark issues a Pioneer JWT and redirects to OUR callback with the token
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const axios   = require('axios');
const { parseTokenExpiry } = require('./embark');
const { upsertUser } = require('./db');

function getBase(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

// ── STEP 1: Redirect through Embark's Steam login ─────────────
router.get('/', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.steamState = state;

  const base = getBase(req);
  const returnTo = encodeURIComponent(`${base}/auth/steam/callback`);

  // This is the URL Embark uses for their own Steam login —
  // it goes Steam → auth.embark.net → back to us with the Pioneer token
  const embarkSteamUrl =
    `https://auth.embark.net/oauth2/authorize` +
    `?client_id=embark-pioneer` +
    `&response_type=token` +
    `&external_provider_name=steam` +
    `&redirect_uri=${returnTo}` +
    `&state=${state}`;

  console.log('[Steam] Redirecting to Embark Steam login:', embarkSteamUrl);
  res.redirect(embarkSteamUrl);
});

// ── STEP 2: Embark redirects back with token in URL fragment ──
// Tokens arrive as URL hash fragments (#access_token=...) which are
// not sent to the server — so we serve a small HTML page that extracts
// the fragment and POSTs it to our backend.
router.get('/callback', (req, res) => {
  // Check if token came as query param (some flows use this)
  const { access_token, state, error, code } = req.query;

  if (error) {
    console.error('[Steam] Embark returned error:', error);
    return res.redirect(`/?error=steam_embark_${encodeURIComponent(error)}`);
  }

  // Token in query string — handle directly
  if (access_token) {
    return handleToken(req, res, access_token);
  }

  // Token might be in URL fragment — serve JS to extract and POST it
  res.send(`<!DOCTYPE html>
<html>
<head><title>Authenticating...</title></head>
<body>
<script>
  // Extract token from hash fragment or query string
  const hash   = location.hash.slice(1);
  const params = new URLSearchParams(hash || location.search);
  const token  = params.get('access_token');
  const code   = params.get('code');
  const error  = params.get('error');

  if (error) {
    location.href = '/?error=steam_' + encodeURIComponent(error);
  } else if (token) {
    fetch('/auth/steam/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
      credentials: 'include'
    }).then(r => r.json()).then(d => {
      location.href = d.ok ? '/?auth=success' : '/?error=' + encodeURIComponent(d.error || 'unknown');
    });
  } else if (code) {
    fetch('/auth/steam/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      credentials: 'include'
    }).then(r => r.json()).then(d => {
      location.href = d.ok ? '/?auth=success' : '/?error=' + encodeURIComponent(d.error || 'unknown');
    });
  } else {
    // Nothing in fragment or query — show debug info
    document.body.innerHTML = '<pre>No token found.\\nHash: ' + location.hash + '\\nSearch: ' + location.search + '</pre>';
  }
</script>
<p>Completing login...</p>
</body>
</html>`);
});

// ── STEP 3a: Receive token POSTed from fragment extractor ─────
router.post('/token', async (req, res) => {
  const { access_token, code } = req.body;

  if (access_token) {
    try {
      await saveSession(req, access_token);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[Steam] saveSession error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (code) {
    // Exchange code for token via Embark
    try {
      const base = getBase(req);
      const resp = await axios.post('https://auth.embark.net/oauth2/token', new URLSearchParams({
        grant_type:   'authorization_code',
        code:          code,
        redirect_uri:  `${base}/auth/steam/callback`,
        client_id:     process.env.EMBARK_CLIENT_ID || 'embark-pioneer',
        client_secret: process.env.EMBARK_CLIENT_SECRET || '+GoAQg2vzgcohjnW0PKtfiMjLfvSTfcjsyJ8YqH3DuE=',
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      await saveSession(req, resp.data.access_token);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[Steam] code exchange error:', e.response?.data || e.message);
      return res.status(500).json({ error: JSON.stringify(e.response?.data || e.message) });
    }
  }

  res.status(400).json({ error: 'No token or code provided' });
});

// ── Helper: direct token in query string ──────────────────────
async function handleToken(req, res, token) {
  try {
    await saveSession(req, token);
    res.redirect('/?auth=success');
  } catch (e) {
    console.error('[Steam] handleToken error:', e.message);
    res.redirect(`/?error=${encodeURIComponent(e.message)}`);
  }
}

// ── Helper: save Pioneer token to DB + session ────────────────
async function saveSession(req, pioneerToken) {
  console.log('[Steam] Saving token, preview:', pioneerToken.slice(0, 40) + '...');

  const expiresAt = parseTokenExpiry(pioneerToken) || new Date(Date.now() + 3600000);

  let embarkId = null;
  let steamId  = null;
  try {
    const payload = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64url').toString());
    console.log('[Steam] JWT payload keys:', Object.keys(payload).join(', '));
    embarkId = payload.sub || null;
    steamId  = payload.steam_id || payload.ext?.steam_id || embarkId;
  } catch (e) {
    console.error('[Steam] JWT parse error:', e.message);
  }

  const user = await upsertUser({
    platformId:     steamId || embarkId || 'unknown',
    platform:       'steam',
    displayName:    `Steam_${(embarkId || 'player').slice(-6)}`,
    pioneerToken,
    tokenExpiresAt: expiresAt.toISOString(),
    embarkId,
  });

  req.session.userId      = user.id;
  req.session.platform    = 'steam';
  req.session.embarkId    = embarkId;
  req.session.displayName = user.display_name;

  console.log('[Steam] ✅ Session saved. Embark ID:', embarkId);
}

module.exports = router;
