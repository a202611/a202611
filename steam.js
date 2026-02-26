/**
 * Steam OpenID 2.0 Auth Route
 *
 * GET /auth/steam          → redirect user to Steam login page
 * GET /auth/steam/callback → Steam posts back here → verify → exchange for Pioneer JWT
 */

const express  = require('express');
const router   = express.Router();
const openid   = require('openid');
const { exchangeForPioneerToken, parseTokenExpiry } = require('./embark');
const { upsertUser } = require('./db');

const STEAM_PROVIDER = 'https://steamcommunity.com/openid';

function getBase(req) {
  // Always prefer the explicit BASE_URL env var (set this in Railway!)
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, ''); // strip trailing slash
  }
  // Fallback: trust X-Forwarded-Proto from Railway's proxy
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function makeRelyingParty(req) {
  const base = getBase(req);
  console.log(`[Steam] RelyingParty base: ${base}`);
  return new openid.RelyingParty(
    `${base}/auth/steam/callback`,  // return_to — must be https on Railway
    base,                           // realm
    true,                           // stateless
    false,                          // strict
    []                              // extensions
  );
}

// ── STEP 1: Kick off Steam login ─────────────────────────────
router.get('/', (req, res) => {
  const rp = makeRelyingParty(req);
  rp.authenticate(STEAM_PROVIDER, false, (err, authUrl) => {
    if (err || !authUrl) {
      console.error('[Steam] init error:', err);
      return res.redirect('/?error=steam_init_failed');
    }
    res.redirect(authUrl);
  });
});

// ── STEP 2: Steam redirects back here ────────────────────────
router.get('/callback', async (req, res) => {
  const rp = makeRelyingParty(req);

  rp.verifyAssertion(req, async (err, result) => {
    if (err || !result?.authenticated) {
      console.error('[Steam] assertion failed:', err?.message);
      return res.redirect('/?error=steam_auth_failed');
    }

    // claimedIdentifier = "https://steamcommunity.com/openid/id/76561198XXXXXXXXX"
    const steamId = result.claimedIdentifier?.split('/').pop();
    if (!steamId || !/^\d+$/.test(steamId)) {
      return res.redirect('/?error=invalid_steam_id');
    }

    console.log(`[Steam] SteamID: ${steamId}`);

    try {
      // Exchange the Steam OpenID identifier for a Pioneer Bearer JWT
      const embarkResp = await exchangeForPioneerToken(
        'steam',
        result.claimedIdentifier,
        `Player_${steamId.slice(-6)}`
      );

      const pioneerToken = embarkResp.access_token;
      const expiresAt    = parseTokenExpiry(pioneerToken)
        || new Date(Date.now() + (embarkResp.expires_in || 3600) * 1000);

      // Pull embark_id out of the JWT payload (sub claim)
      let embarkId = null;
      try {
        const payload = JSON.parse(
          Buffer.from(pioneerToken.split('.')[1], 'base64url').toString()
        );
        embarkId = payload.sub || null;
      } catch {}

      const user = await upsertUser({
        platformId:     steamId,
        platform:       'steam',
        displayName:    `Player_${steamId.slice(-6)}`,
        pioneerToken,
        tokenExpiresAt: expiresAt.toISOString(),
        embarkId,
      });

      req.session.userId      = user.id;
      req.session.platform    = 'steam';
      req.session.platformId  = steamId;
      req.session.embarkId    = embarkId;
      req.session.displayName = user.display_name;

      console.log(`[Steam] ✅ Token obtained. Embark ID: ${embarkId}`);
      res.redirect('/?auth=success');

    } catch (e) {
      console.error('[Steam] Pioneer exchange error:', e.message);
      res.redirect(`/?error=pioneer_exchange_failed&detail=${encodeURIComponent(e.message)}`);
    }
  });
});

module.exports = router;
