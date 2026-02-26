/**
 * Steam auth via id.embark.games (correct flow)
 *
 * 1. GET  /auth/steam           → redirect to id.embark.games/api/auth/login?provider=steam
 * 2. User logs in on Steam
 * 3. GET  /auth/steam/callback  → call id.embark.games/api/auth/session to get Embark token
 * 4. POST auth.embark.net/oauth2/token with embark token → Pioneer JWT
 * 5. Store Pioneer JWT in Supabase, set session
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

// ── STEP 1: Redirect to Embark's Steam login ─────────────────
router.get('/', (req, res) => {
  const base     = getBase(req);
  const callback = encodeURIComponent(`${base}/auth/steam/callback`);

  // id.embark.games handles the full Steam OpenID flow internally
  const loginUrl = `https://id.embark.games/api/auth/login?provider=steam&skip_link=false&link_code=&redirect_to=${callback}`;

  console.log('[Steam] → Embark login URL:', loginUrl);
  res.redirect(loginUrl);
});

// ── STEP 2: Embark redirects back here after Steam login ──────
router.get('/callback', async (req, res) => {
  const { error } = req.query;
  if (error) {
    console.error('[Steam] callback error param:', error);
    return res.redirect(`/?error=steam_${encodeURIComponent(error)}`);
  }

  console.log('[Steam] callback hit, query:', JSON.stringify(req.query));

  // Serve a page that:
  // 1. Calls id.embark.games/api/auth/session (needs the cookie Embark just set)
  // 2. POSTs the accessToken back to our server
  res.send(`<!DOCTYPE html>
<html>
<head><title>Completing login...</title>
<style>body{background:#080b0f;color:#00e5ff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style>
</head>
<body>
<div id="msg">Completing Steam authentication...</div>
<script>
async function complete() {
  try {
    // Fetch Embark session — cookie from id.embark.games must be present
    const sessionResp = await fetch('https://id.embark.games/api/auth/session', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    if (!sessionResp.ok) {
      throw new Error('Session fetch failed: ' + sessionResp.status);
    }

    const session = await sessionResp.json();
    console.log('Embark session:', JSON.stringify(session));

    if (!session.accessToken) {
      throw new Error('No accessToken in session: ' + JSON.stringify(session));
    }

    // POST the Embark token to our backend for Pioneer exchange
    const exchangeResp = await fetch('/auth/steam/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        embarkToken:   session.accessToken,
        embarkUserId:  session.embarkUserId,
      })
    });

    const result = await exchangeResp.json();
    if (result.ok) {
      location.href = '/?auth=success';
    } else {
      document.getElementById('msg').textContent = 'Error: ' + result.error;
      setTimeout(() => location.href = '/?error=' + encodeURIComponent(result.error), 2000);
    }
  } catch(e) {
    console.error('Auth completion error:', e);
    document.getElementById('msg').textContent = 'Error: ' + e.message;
    setTimeout(() => location.href = '/?error=' + encodeURIComponent(e.message), 3000);
  }
}
complete();
</script>
</body>
</html>`);
});

// ── STEP 3: Receive Embark token, exchange for Pioneer JWT ────
router.post('/exchange', async (req, res) => {
  const { embarkToken, embarkUserId } = req.body;

  if (!embarkToken) {
    return res.status(400).json({ error: 'No embarkToken provided' });
  }

  console.log('[Steam] Exchanging Embark token for Pioneer JWT...');
  console.log('[Steam] embarkUserId:', embarkUserId);
  console.log('[Steam] embarkToken preview:', embarkToken.slice(0, 60) + '...');

  try {
    // Exchange the Embark identity token for a Pioneer-specific JWT
    const params = new URLSearchParams({
      grant_type:              'client_credentials',
      external_provider_name:  'embark',        // using Embark token as provider
      external_provider_token:  embarkToken,
      nick_name:               'Player',
      audience:                'https://pioneer.embark.net/',
      app_id:                  '1808500',
      tenancy:                 'pioneer-live',
      client_id:               process.env.EMBARK_CLIENT_ID  || 'embark-pioneer',
      client_secret:           process.env.EMBARK_CLIENT_SECRET || '+GoAQg2vzgcohjnW0PKtfiMjLfvSTfcjsyJ8YqH3DuE=',
    });

    let pioneerToken;

    try {
      const resp = await axios.post(
        process.env.EMBARK_AUTH_URL || 'https://auth.embark.net/oauth2/token',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'EmbarkGameBoot/1.0 (Windows; 10.0.26100.1.256.64bit)' } }
      );
      console.log('[Steam] Pioneer exchange response:', JSON.stringify(resp.data).slice(0, 200));
      pioneerToken = resp.data.access_token;
    } catch (exchangeErr) {
      // Log the error but also try using the Embark token directly against Pioneer API
      console.error('[Steam] Pioneer exchange failed:', exchangeErr.response?.status, JSON.stringify(exchangeErr.response?.data));
      console.log('[Steam] Trying Embark token directly against Pioneer API...');

      // Test if the embarkToken itself works on Pioneer API
      const testResp = await axios.get(
        `${process.env.PIONEER_BASE_URL || 'https://api-gateway.europe.es-pio.net/v1/pioneer'}/inventory`,
        {
          headers: {
            'Authorization': `Bearer ${embarkToken}`,
            'Accept': '*/*',
            'Content-Type': 'application/json',
            'User-Agent': 'PioneerGame/pioneer_1.13.x-CL-1086629 (http-legacy) Windows/10.0.26200.1.256.64bit',
            'x-embark-manifest-id': '8916105720306122915',
            'x-embark-telemetry-uuid': 'd6fuae266on9i72dg9o0',
            'x-embark-telemetry-client-platform': '1',
          }
        }
      );
      console.log('[Steam] Direct Pioneer test status:', testResp.status);
      // If we get here, embarkToken works directly!
      pioneerToken = embarkToken;
    }

    if (!pioneerToken) {
      throw new Error('No Pioneer token obtained');
    }

    const expiresAt = parseTokenExpiry(pioneerToken) || new Date(Date.now() + 3600000);

    let embarkId = embarkUserId || null;
    try {
      const payload = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64url').toString());
      console.log('[Steam] Pioneer JWT payload keys:', Object.keys(payload).join(', '));
      embarkId = payload.sub || embarkId;
    } catch {}

    const user = await upsertUser({
      platformId:     embarkUserId || embarkId || 'unknown',
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

    console.log('[Steam] ✅ Auth complete. Embark ID:', embarkId);
    res.json({ ok: true });

  } catch (e) {
    console.error('[Steam] /exchange error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
