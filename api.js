/**
 * Pioneer API Proxy
 *
 * All calls from the frontend hit /api/* — this router:
 * 1. Checks session (user must be logged in)
 * 2. Loads their Pioneer Bearer token from Supabase
 * 3. Proxies the request to api-gateway.europe.es-pio.net
 * 4. Returns the response
 *
 * This means the Pioneer token NEVER touches the browser.
 */

const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../server');
const { getUserToken } = require('../db');
const { pioneerRequest } = require('../embark');

const PIONEER_BASE = process.env.PIONEER_BASE_URL || 'https://api-gateway.europe.es-pio.net/v1/pioneer';

// All API routes require auth
router.use(requireAuth);

// ── GET /api/inventory ───────────────────────────────────────
router.get('/inventory', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    const data = await pioneerRequest(pioneer_token, '/inventory');
    res.json(data);
  } catch (e) {
    console.error('[API] inventory error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/inventory/mutate ───────────────────────────────
router.post('/inventory/mutate', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    const data = await pioneerRequest(pioneer_token, '/inventory/v1/mutate', 'POST', req.body);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/offers/accept ──────────────────────────────────
router.post('/offers/accept', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    const data = await pioneerRequest(pioneer_token, '/offers/accept', 'POST', req.body);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/inventory/upgrade ─────────────────────────────
router.post('/inventory/upgrade', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    const data = await pioneerRequest(pioneer_token, '/inventory/upgrade', 'POST', req.body);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Generic proxy: GET /api/proxy?path=/whatever ─────────────
// Useful for hitting any Pioneer endpoint from the frontend
router.get('/proxy', async (req, res) => {
  const path = req.query.path;
  if (!path || !path.startsWith('/')) return res.status(400).json({ error: 'Invalid path' });
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    const data = await pioneerRequest(pioneer_token, path);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
