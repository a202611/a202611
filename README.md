# PIONEER AUTH — ARC Raiders Dashboard Backend

Full-stack OAuth → Pioneer JWT server for ARC Raiders.
Users log in with Steam/Epic/Xbox/PSN — your backend exchanges their platform token for a Pioneer Bearer JWT and proxies all Pioneer API calls server-side.

## Architecture

```
User browser                Your Server                  External APIs
────────────                ───────────                  ─────────────
Click "Login with Steam" →  GET /auth/steam          →   Steam OpenID
                        ←   Redirect to Steam login
Log in on Steam         →   GET /auth/steam/callback
                            POST auth.embark.net/oauth2/token  →  Embark Auth
                        ←   Pioneer Bearer JWT stored in Supabase
                            Session cookie set
Dashboard loads         →   GET /api/inventory
                            (loads stored token from DB)  →  es-pio.net
                        ←   Inventory JSON returned
```

## Setup

### 1. Supabase

1. Go to https://supabase.com → New Project
2. Dashboard → SQL Editor → paste contents of `supabase-schema.sql` → Run
3. Settings → API → copy:
   - Project URL → `SUPABASE_URL`
   - `service_role` key (NOT anon) → `SUPABASE_SERVICE_KEY`

### 2. Environment

```bash
cp .env.example .env
# Fill in:
#   BASE_URL          → your domain (http://localhost:3000 for dev)
#   SESSION_SECRET    → random string: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   SUPABASE_URL      → from Supabase
#   SUPABASE_SERVICE_KEY → from Supabase
# Leave Embark/Epic/Xbox/PSN values as-is (already extracted from game)
```

### 3. Install & Run

```bash
npm install
npm run dev        # development (auto-restart)
npm start          # production
```

Visit http://localhost:3000

## Deploy to Railway (free tier, recommended)

1. Push this folder to a GitHub repo
2. https://railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway dashboard (same as .env)
4. Railway gives you a URL → set `BASE_URL` to that URL
5. Redeploy

## Deploy to Vercel

Vercel is for serverless — this Express app needs a small adapter:

```bash
npm install -g vercel
vercel
```

Add env vars in Vercel dashboard. Note: sessions won't persist across
serverless instances — swap `express-session` for a Redis/Supabase-backed
session store for production Vercel deploys.

## Platform Notes

### Steam ✅ (most reliable)
Uses Steam OpenID 2.0. Your server is the `return_to` target.
The OpenID claimed identifier is passed to Embark as the provider token.
This is the same mechanism as `main.rs` but via web OAuth instead of DLL.

### Epic Games ⚠️ (needs testing)
Uses the same Epic client_id from the game URLs.
The auth code is passed directly to Embark's token endpoint.
Embark may need an Epic *access token* rather than an auth code —
if exchange fails, you'll need to add an intermediate step to exchange
the Epic code for an Epic access token first (requires Epic client_secret
which Embark's game binary would have).

### Xbox ⚠️ (needs testing)
Same situation as Epic — Microsoft auth code passed to Embark.
Xbox flow uses PKCE, and the redirect_uri must be registered with
Microsoft's app (Embark's registered app, ba970d97...).
The redirect_uri mismatch may cause issues — if so, route through
Embark's own Xbox redirect URI: https://auth.embark.net/oauth2/authorize/xbox

### PlayStation ⚠️ (needs testing)  
Same caveats as Xbox/Epic. Sony's redirect_uri enforcement is strict.

## Token Refresh

Pioneer JWTs expire (typ. 1-24 hours). To refresh:
1. Check `token_expires_at` before each API call
2. If expired, re-run the platform OAuth flow
3. Or implement a background job that refreshes tokens before expiry

The `/me` endpoint returns the current user's session.
Frontend should redirect to login if `/me` returns 401.

## File Structure

```
pioneer-auth/
├── src/
│   ├── server.js          # Express app, session, routes
│   ├── embark.js          # Embark token exchange + Pioneer API proxy
│   ├── db.js              # Supabase client + user helpers
│   └── routes/
│       ├── steam.js       # Steam OpenID auth
│       ├── epic.js        # Epic Games OAuth
│       ├── xbox.js        # Xbox/Microsoft OAuth
│       ├── psn.js         # PlayStation OAuth
│       └── api.js         # Pioneer API proxy (all /api/* routes)
├── public/
│   └── index.html         # Frontend dashboard
├── supabase-schema.sql    # Run this in Supabase SQL editor
├── .env.example           # Copy to .env and fill in
└── package.json
```
