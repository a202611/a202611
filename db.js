const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role — bypasses RLS for backend writes
);

/**
 * Upsert a user record and store their Pioneer token.
 * Returns the internal user row.
 */
async function upsertUser({ platformId, platform, displayName, pioneerToken, tokenExpiresAt, embarkId }) {
  const { data, error } = await supabase
    .from('users')
    .upsert({
      platform_id:       platformId,
      platform:          platform,
      display_name:      displayName,
      pioneer_token:     pioneerToken,
      token_expires_at:  tokenExpiresAt,
      embark_id:         embarkId,
      updated_at:        new Date().toISOString(),
    }, {
      onConflict: 'platform_id,platform',
      returning: 'representation',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get a user's stored Pioneer token (refresh if needed).
 */
async function getUserToken(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('pioneer_token, token_expires_at, platform, platform_id')
    .eq('id', userId)
    .single();

  if (error) throw error;
  return data;
}

module.exports = { supabase, upsertUser, getUserToken };
