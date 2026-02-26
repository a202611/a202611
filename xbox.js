/**
 * Xbox (Microsoft Live) OAuth Route
 *
 * Flow:
 *   GET /auth/xbox          → redirect to Microsoft login (PKCE)
 *   GET /auth/xbox/callback → Microsoft redirects with ?code=...
 *                             → pass code to Embark as Xbox provider token
 *                             → store Pioneer JWT → redirect to frontend
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { exchangeForPioneerToken, parseTokenExpiry } = require('../embark');
const { upsertUser } = require('../db');

const XBOX_CLIENT_ID = process.env.XBOX_CLIENT_ID || 'ba970d97-14cb-40e6-aa28-dd8f271adc9c';
const XBOX_AUTH_URL  = 'https://login.live.com/oauth20_authorize.srf';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generatePKCE() {
  const verifier  = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── STEP 1: Redirect to Microsoft ────────────────────────────
router.get('/', (req, res) => {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  req.session.xboxPkceVerifier = verifier;
  req.session.xboxState        = state;

  const base     = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirect  = `${base}/auth/xbox/callback`;

  const url = new URL(XBOX_AUTH_URL);
  url.searchParams.set('access_type',           'offline');
  url.searchParams.set('client_id',             XBOX_CLIENT_ID);
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('scope',                 'openid XboxLive.signin XboxLive.offline_access');
  url.searchParams.set('state',                 state);
  url.searchParams.set('code_challenge',        challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri',          redirect);

  res.redirect(url.toString());
});

// ── STEP 2: Xbox callback ─────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.redirect(`/?error=xbox_${error}`);
  if (state !== req.session.xboxState) return res.redirect('/?error=xbox_state_mismatch');

  try {
    const embarkResp = await exchangeForPioneerToken('xbox', code);

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
      platform:       'xbox',
      displayName:    'Xbox Player',
      pioneerToken,
      tokenExpiresAt: expiresAt.toISOString(),
      embarkId,
    });

    req.session.userId      = user.id;
    req.session.platform    = 'xbox';
    req.session.embarkId    = embarkId;
    req.session.displayName = user.display_name;

    res.redirect('/?auth=success');

  } catch (e) {
    console.error('[Xbox] Pioneer exchange failed:', e.message);
    res.redirect(`/?error=xbox_pioneer_failed&detail=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
