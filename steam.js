/**
 * Steam OpenID 2.0 Auth Route
 *
 * Flow:
 *   GET /auth/steam          → redirect to Steam login
 *   GET /auth/steam/callback → Steam redirects here with openid assertion
 *                              → verify assertion → exchange for Pioneer token
 *                              → store in Supabase → redirect to frontend
 */

const express = require('express');
const router  = express.Router();
const openid  = require('openid');
const { exchangeForPioneerToken, parseTokenExpiry } = require('../embark');
const { upsertUser } = require('../db');

const STEAM_OPENID = 'https://steamcommunity.com/openid';

function getRelyingParty(req) {
  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  return new openid.RelyingParty(
    `${base}/auth/steam/callback`,  // return_to (must match exactly)
    base,                           // realm
    true,                           // stateless
    false,                          // strict mode
    []                              // extensions
  );
}

// ── STEP 1: Initiate Steam login ─────────────────────────────
router.get('/', (req, res) => {
  const rp = getRelyingParty(req);
  rp.authenticate(STEAM_OPENID, false, (err, authUrl) => {
    if (err || !authUrl) {
      console.error('Steam OpenID init error:', err);
      return res.redirect('/?error=steam_init_failed');
    }
    res.redirect(authUrl);
  });
});

// ── STEP 2: Steam callback ───────────────────────────────────
router.get('/callback', async (req, res) => {
  const rp = getRelyingParty(req);

  rp.verifyAssertion(req, async (err, result) => {
    if (err || !result?.authenticated) {
      console.error('Steam assertion failed:', err);
      return res.redirect('/?error=steam_auth_failed');
    }

    // Extract Steam ID from the claimed identifier
    // Format: https://steamcommunity.com/openid/id/76561198XXXXXXXXX
    const steamId = result.claimedIdentifier.split('/').pop();
    if (!steamId || !/^\d+$/.test(steamId)) {
      return res.redirect('/?error=invalid_steam_id');
    }

    console.log(`[Steam] Authenticated SteamID: ${steamId}`);

    try {
      // ── STEP 3: Exchange Steam OpenID token for Pioneer JWT ──
      // The claimedIdentifier IS the openid token Embark accepts
      const embarkResp = await exchangeForPioneerToken(
        'steam',
        result.claimedIdentifier,  // full openid URL as provider token
        `Player_${steamId.slice(-6)}`
      );

      const pioneerToken = embarkResp.access_token;
      const expiresAt    = parseTokenExpiry(pioneerToken) || 
                           new Date(Date.now() + (embarkResp.expires_in || 3600) * 1000);

      // Parse embark_id from the JWT if present
      let embarkId = null;
      try {
        const payload = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64').toString());
        embarkId = payload.sub || payload.embark_id || null;
      } catch {}

      // ── STEP 4: Store in Supabase ─────────────────────────────
      const user = await upsertUser({
        platformId:     steamId,
        platform:       'steam',
        displayName:    `Player_${steamId.slice(-6)}`,
        pioneerToken:   pioneerToken,
        tokenExpiresAt: expiresAt.toISOString(),
        embarkId:       embarkId,
      });

      // ── STEP 5: Set session → redirect to dashboard ───────────
      req.session.userId      = user.id;
      req.session.platform    = 'steam';
      req.session.platformId  = steamId;
      req.session.embarkId    = embarkId;
      req.session.displayName = user.display_name;

      console.log(`[Steam] Pioneer token obtained for ${steamId}, expires ${expiresAt.toISOString()}`);
      res.redirect('/?auth=success');

    } catch (e) {
      console.error('[Steam] Pioneer token exchange failed:', e.message);
      // If Embark rejects — maybe the OpenID assertion format needs adjustment
      // Fall back: store Steam ID, show user a message
      req.session.userId     = null;
      req.session.steamId    = steamId;
      res.redirect(`/?error=pioneer_exchange_failed&detail=${encodeURIComponent(e.message)}`);
    }
  });
});

module.exports = router;
