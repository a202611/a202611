/**
 * Pioneer API Proxy — all /api/* calls go through here server-side.
 * The Bearer token never touches the browser.
 */

const express = require('express');
const router  = express.Router();

// requireAuth is exported from server.js — lazy require to avoid circular dep
function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

const { getUserToken }    = require('./db');
const { pioneerRequest }  = require('./embark');

router.use(requireAuth);

router.get('/inventory', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    res.json(await pioneerRequest(pioneer_token, '/inventory'));
  } catch (e) {
    console.error('[API] inventory:', e.message);
    res.status(502).json({ error: e.message });
  }
});

router.post('/inventory/mutate', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    res.json(await pioneerRequest(pioneer_token, '/inventory/v1/mutate', 'POST', req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/offers/accept', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    res.json(await pioneerRequest(pioneer_token, '/offers/accept', 'POST', req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

router.post('/inventory/upgrade', async (req, res) => {
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    res.json(await pioneerRequest(pioneer_token, '/inventory/upgrade', 'POST', req.body));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Generic proxy: GET /api/proxy?path=/some/endpoint
router.get('/proxy', async (req, res) => {
  const p = req.query.path;
  if (!p || !p.startsWith('/')) return res.status(400).json({ error: 'Invalid path' });
  try {
    const { pioneer_token } = await getUserToken(req.session.userId);
    res.json(await pioneerRequest(pioneer_token, p));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
