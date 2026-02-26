/**
 * Steam auth — proxy approach
 *
 * We act as a proxy through Embark's own Steam OAuth flow.
 * The server-side makes all requests (keeping cookies), then
 * extracts the Pioneer JWT from Embark's session.
 *
 * Flow:
 *  1. GET /auth/steam         → initiate Steam OpenID (OUR server is return_to)
 *  2. Steam → GET /auth/steam/callback with openid params
 *  3. Forward those exact openid params to auth.embark.net/oauth2/authorize
 *  4. Follow Embark's redirects server-side, capture session cookie
 *  5. POST auth.embark.net/oauth2/token with that cookie → Pioneer JWT
 */

const express  = require('express');
const router   = express.Router();
const openid   = require('openid');
const axios    = require('axios');
const { parseTokenExpiry } = require('./embark');
const { upsertUser } = require('./db');

function getBase(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function makeRelyingParty(req) {
  const base = getBase(req);
  // return_to must point back to US — but we set realm to auth.embark.net
  // so Steam trusts the domain
  return new openid.RelyingParty(
    `${base}/auth/steam/callback`,
    base,
    true,   // stateless
    false,  // strict
    []
  );
}

// ── STEP 1: Start Steam OpenID — our server as return_to ──────
router.get('/', (req, res) => {
  const rp = makeRelyingParty(req);
  rp.authenticate('https://steamcommunity.com/openid', false, (err, authUrl) => {
    if (err || !authUrl) {
      console.error('[Steam] OpenID init error:', err);
      return res.redirect('/?error=steam_init_failed');
    }
    console.log('[Steam] → Steam login URL:', authUrl);
    res.redirect(authUrl);
  });
});

// ── STEP 2: Steam posts back here with openid params ──────────
router.get('/callback', async (req, res) => {
  const rp = makeRelyingParty(req);

  rp.verifyAssertion(req, async (err, result) => {
    if (err || !result?.authenticated) {
      console.error('[Steam] assertion failed:', err?.message);
      return res.redirect('/?error=steam_assertion_failed');
    }

    const steamId = result.claimedIdentifier?.split('/').pop();
    console.log('[Steam] Verified SteamID:', steamId);

    // ── STEP 3: Forward OpenID params to Embark ───────────────
    // Build the exact URL Embark expects — all openid.* params forwarded
    const state = req.session.steamState || Math.random().toString(36).slice(2);
    req.session.steamState = state;

    // Collect all openid params from the callback
    const openidParams = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (k.startsWith('openid.') || k === 'state') {
        openidParams[k] = v;
      }
    }

    // Override return_to to point to Embark (this is what they expect)
    openidParams['openid.return_to'] =
      `https://auth.embark.net/oauth2/authorize?external_provider_name=steam&state=${state}`;

    const embarkAuthorizeUrl =
      `https://auth.embark.net/oauth2/authorize?` +
      `external_provider_name=steam&state=${state}&` +
      Object.entries(openidParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

    console.log('[Steam] → Embark authorize URL (first 200):', embarkAuthorizeUrl.slice(0, 200));

    try {
      // Make the request server-side so we capture cookies
      const embarkResp = await axios.get(embarkAuthorizeUrl, {
        maxRedirects: 10,
        withCredentials: true,
        validateStatus: s => s < 500,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/html, */*',
        },
      });

      console.log('[Steam] Embark authorize status:', embarkResp.status);
      console.log('[Steam] Embark authorize headers:', JSON.stringify(embarkResp.headers).slice(0, 300));
      console.log('[Steam] Embark authorize body:', JSON.stringify(embarkResp.data).slice(0, 300));

      // Extract cookies from Embark's response
      const setCookies = embarkResp.headers['set-cookie'] || [];
      console.log('[Steam] Embark cookies:', setCookies.map(c => c.split(';')[0]).join(', '));

      // Store cookies in session for the token exchange step
      req.session.embarkCookies = setCookies.map(c => c.split(';')[0]).join('; ');
      req.session.embarkState   = state;
      req.session.steamId       = steamId;

      // If Embark returned a token directly in the response body
      if (embarkResp.data?.access_token) {
        return finalize(req, res, embarkResp.data.access_token, steamId);
      }

      // ── STEP 4: Exchange session for Pioneer JWT ──────────────
      await exchangeWithCookies(req, res, steamId, setCookies, state);

    } catch (e) {
      console.error('[Steam] Embark authorize error:', e.message);
      if (e.response) {
        console.error('[Steam] Response status:', e.response.status);
        console.error('[Steam] Response body:', JSON.stringify(e.response.data).slice(0, 400));
      }
      res.redirect(`/?error=embark_authorize_failed&detail=${encodeURIComponent(e.message)}`);
    }
  });
});

async function exchangeWithCookies(req, res, steamId, setCookies, state) {
  const cookieStr = setCookies.map(c => c.split(';')[0]).join('; ');

  console.log('[Steam] Attempting token exchange with cookies:', cookieStr.slice(0, 100));

  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    state:          state,
    client_id:      process.env.EMBARK_CLIENT_ID     || 'embark-pioneer',
    client_secret:  process.env.EMBARK_CLIENT_SECRET || '+GoAQg2vzgcohjnW0PKtfiMjLfvSTfcjsyJ8YqH3DuE=',
    audience:       'https://pioneer.embark.net/',
    app_id:         '1808500',
    tenancy:        'pioneer-live',
  });

  try {
    const tokenResp = await axios.post(
      'https://auth.embark.net/oauth2/token',
      params.toString(),
      {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Cookie':         cookieStr,
          'User-Agent':    'EmbarkGameBoot/1.0 (Windows; 10.0.26100.1.256.64bit)',
        },
        validateStatus: s => true,
      }
    );

    console.log('[Steam] Token exchange status:', tokenResp.status);
    console.log('[Steam] Token exchange body:', JSON.stringify(tokenResp.data).slice(0, 300));

    if (tokenResp.data?.access_token) {
      return finalize(req, res, tokenResp.data.access_token, steamId);
    }

    // Show what we got for debugging
    res.redirect(
      `/?error=no_pioneer_token&detail=${encodeURIComponent(JSON.stringify(tokenResp.data).slice(0, 200))}`
    );

  } catch (e) {
    console.error('[Steam] Token exchange error:', e.message);
    res.redirect(`/?error=token_exchange_failed&detail=${encodeURIComponent(e.message)}`);
  }
}

async function finalize(req, res, pioneerToken, steamId) {
  const expiresAt = parseTokenExpiry(pioneerToken) || new Date(Date.now() + 3600000);

  let embarkId = null;
  try {
    const payload = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64url').toString());
    console.log('[Steam] Pioneer JWT sub:', payload.sub, '| aud:', payload.aud);
    embarkId = payload.sub || null;
  } catch {}

  const user = await upsertUser({
    platformId:     steamId || embarkId || 'unknown',
    platform:       'steam',
    displayName:    `Steam_${steamId?.slice(-6) || 'player'}`,
    pioneerToken,
    tokenExpiresAt: expiresAt.toISOString(),
    embarkId,
  });

  req.session.userId      = user.id;
  req.session.platform    = 'steam';
  req.session.embarkId    = embarkId;
  req.session.displayName = user.display_name;

  console.log('[Steam] ✅ Auth complete. Embark ID:', embarkId);
  res.redirect('/?auth=success');
}

module.exports = router;
