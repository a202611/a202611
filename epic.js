/**
 * Epic Games OAuth Route
 *
 * Flow:
 *   GET /auth/epic          → redirect to Epic login (PKCE)
 *   GET /auth/epic/callback → Epic redirects with ?code=... 
 *                             → exchange code for Epic token
 *                             → exchange Epic token for Pioneer JWT
 *                             → store in Supabase → redirect to frontend
 *
 * NOTE: Epic uses PKCE (code_challenge). The client_id is Embark's registered
 * Epic app ID. We don't have the client_secret for this app — so the code 
 * exchange below attempts the auth_code→Pioneer flow directly via Embark.
 * If Embark's token endpoint accepts Epic auth codes (not just access tokens),
 * this works. Otherwise you'd need Epic's access token first.
 */

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const axios    = require('axios');
const { exchangeForPioneerToken, parseTokenExpiry } = require('../embark');
const { upsertUser } = require('../db');

const EPIC_CLIENT_ID   = process.env.EPIC_CLIENT_ID || 'xyza7891WuWzdl5bGEEJhwVpka3OdC7u';
const EPIC_AUTH_URL    = 'https://www.epicgames.com/id/authorize';
const EPIC_TOKEN_URL   = 'https://api.epicgames.dev/epic/oauth/v2/token';

// PKCE helpers
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier  = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── STEP 1: Redirect to Epic ─────────────────────────────────
router.get('/', (req, res) => {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  // Store PKCE verifier in session for callback
  req.session.epicPkceVerifier = verifier;
  req.session.epicState        = state;

  const base     = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirect  = `${base}/auth/epic/callback`;

  const url = new URL(EPIC_AUTH_URL);
  url.searchParams.set('client_id',             EPIC_CLIENT_ID);
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('scope',                 'basic_profile');
  url.searchParams.set('state',                 state);
  url.searchParams.set('code_challenge',        challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri',          redirect);

  res.redirect(url.toString());
});

// ── STEP 2: Epic callback ─────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?error=epic_${error}`);
  if (state !== req.session.epicState) return res.redirect('/?error=epic_state_mismatch');

  const base    = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirect = `${base}/auth/epic/callback`;

  try {
    // ── Try: exchange code directly with Embark ───────────────
    // Embark's token endpoint may accept Epic auth codes as external_provider_token
    const embarkResp = await exchangeForPioneerToken('epic', code);

    const pioneerToken = embarkResp.access_token;
    const expiresAt    = parseTokenExpiry(pioneerToken) ||
                         new Date(Date.now() + (embarkResp.expires_in || 3600) * 1000);

    let embarkId = null;
    try {
      const payload = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64').toString());
      embarkId = payload.sub || null;
    } catch {}

    const user = await upsertUser({
      platformId:     embarkId || code.slice(0, 16),
      platform:       'epic',
      displayName:    'Epic Player',
      pioneerToken,
      tokenExpiresAt: expiresAt.toISOString(),
      embarkId,
    });

    req.session.userId      = user.id;
    req.session.platform    = 'epic';
    req.session.embarkId    = embarkId;
    req.session.displayName = user.display_name;

    res.redirect('/?auth=success');

  } catch (e) {
    console.error('[Epic] Pioneer exchange failed:', e.message);
    res.redirect(`/?error=epic_pioneer_failed&detail=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
