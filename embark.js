const axios = require('axios');

const EMBARK_AUTH_URL   = process.env.EMBARK_AUTH_URL   || 'https://auth.embark.net/oauth2/token';
const PIONEER_BASE_URL  = process.env.PIONEER_BASE_URL  || 'https://api-gateway.europe.es-pio.net/v1/pioneer';
const EMBARK_CLIENT_ID  = process.env.EMBARK_CLIENT_ID  || 'embark-pioneer';
const EMBARK_SECRET     = process.env.EMBARK_CLIENT_SECRET;

const PIONEER_HEADERS = {
  'Accept':                          '*/*',
  'x-embark-manifest-id':            '8916105720306122915',
  'x-embark-telemetry-uuid':         'd6fuae266on9i72dg9o0',
  'x-embark-telemetry-client-platform': '1',
  'Content-Type':                    'application/json',
  'User-Agent':                      'PioneerGame/pioneer_1.13.x-CL-1086629 (http-legacy) Windows/10.0.26200.1.256.64bit',
};

/**
 * Exchange a platform token for a Pioneer Bearer JWT.
 *
 * @param {string} providerName  - 'steam' | 'epic' | 'xbox' | 'playstation'
 * @param {string} providerToken - The platform-specific token/assertion
 * @param {string} nickname      - User's display name
 * @returns {{ access_token, expires_in, token_type }}
 */
async function exchangeForPioneerToken(providerName, providerToken, nickname = 'Player') {
  const params = new URLSearchParams({
    grant_type:             'client_credentials',
    external_provider_name: providerName,
    external_provider_token: providerToken,
    nick_name:              nickname,
    audience:               'https://pioneer.embark.net/',
    app_id:                 '1808500',
    tenancy:                'pioneer-live',
    client_id:              EMBARK_CLIENT_ID,
    client_secret:          EMBARK_SECRET,
  });

  const response = await axios.post(EMBARK_AUTH_URL, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'EmbarkGameBoot/1.0 (Windows; 10.0.26100.1.256.64bit)',
    },
  });

  if (response.data.error) {
    throw new Error(`Embark rejected token: ${response.data.error_description || response.data.error}`);
  }

  return response.data; // { access_token, expires_in, token_type, ... }
}

/**
 * Make an authenticated request to the Pioneer API.
 */
async function pioneerRequest(bearerToken, path, method = 'GET', body = null) {
  const url = `${PIONEER_BASE_URL}${path}`;
  const headers = {
    ...PIONEER_HEADERS,
    'Authorization':          `Bearer ${bearerToken}`,
    'x-embark-request-id':    generateRequestId(),
  };

  const config = { method, url, headers };
  if (body) config.data = body;

  const resp = await axios(config);
  return resp.data;
}

function generateRequestId() {
  return Math.random().toString(36).slice(2, 18).padEnd(16, '0');
}

/**
 * Parse expiry from JWT payload without verifying signature.
 * Returns a JS Date object.
 */
function parseTokenExpiry(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

module.exports = { exchangeForPioneerToken, pioneerRequest, parseTokenExpiry };
