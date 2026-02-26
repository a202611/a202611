const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { exchangeForPioneerToken, parseTokenExpiry } = require('./embark');
const { upsertUser } = require('./db');

const PSN_CLIENT_ID = process.env.PSN_CLIENT_ID || 'e7e9653f-5318-4151-bf4d-0fd61a9c9c4b';
const PSN_AUTH_URL  = 'https://my.account.sony.com/sonyacct/signin/';

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function generatePKCE() {
  const verifier  = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

router.get('/', (req, res) => {
  const { verifier, challenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));
  req.session.psnPkceVerifier = verifier;
  req.session.psnState        = state;

  const base = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url  = new URL(PSN_AUTH_URL);
  url.searchParams.set('access_type',           'offline');
  url.searchParams.set('client_id',             PSN_CLIENT_ID);
  url.searchParams.set('response_type',         'code');
  url.searchParams.set('scope',                 'openid id_token:psn.basic_claims');
  url.searchParams.set('state',                 state);
  url.searchParams.set('code_challenge',        challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri',          `${base}/auth/psn/callback`);
  url.searchParams.set('auth_ver',              'v3');
  res.redirect(url.toString());
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?error=psn_${error}`);
  if (state !== req.session.psnState) return res.redirect('/?error=psn_state_mismatch');

  try {
    const embarkResp   = await exchangeForPioneerToken('playstation', code);
    const pioneerToken = embarkResp.access_token;
    const expiresAt    = parseTokenExpiry(pioneerToken) || new Date(Date.now() + 3600000);

    let embarkId = null;
    try { embarkId = JSON.parse(Buffer.from(pioneerToken.split('.')[1], 'base64url').toString()).sub; } catch {}

    const user = await upsertUser({ platformId: embarkId || code.slice(0,16), platform:'playstation', displayName:'PSN Player', pioneerToken, tokenExpiresAt: expiresAt.toISOString(), embarkId });
    req.session.userId = user.id; req.session.platform = 'playstation'; req.session.embarkId = embarkId;
    res.redirect('/?auth=success');
  } catch (e) {
    console.error('[PSN]', e.message);
    res.redirect(`/?error=psn_pioneer_failed&detail=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
