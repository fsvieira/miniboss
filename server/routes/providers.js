const express = require('express');
const router = express.Router();
const { DatabaseAPI, DatabaseConnection } = require('../services/db');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

/**
 * Refreshes the pricing catalog of a provider (never throws).
 * @param {Object} provider
 * @param {{force?: boolean}} [options]
 */
async function refreshPricingCatalog(provider, options = {}) {
  const { refreshModelPricing } = require('../services/ai/pricing');
  return refreshModelPricing({
    provider,
    providerId: provider.id,
    force: options.force === true,
  });
}

// GET all providers
router.get('/', (req, res) => {
  const providers = db.getAllProviders().map(p => ({
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    is_active: p.is_active,
    created_at: p.created_at,
    updated_at: p.updated_at
  }));
  res.json(providers);
});

// GET active provider
router.get('/active', (req, res) => {
  const activeProviders = db.getActiveProviders();
  const provider = activeProviders.length > 0 ? activeProviders[0] : null;
  if (provider) {
    res.json({
      id: provider.id,
      name: provider.name,
      base_url: provider.base_url,
      is_active: provider.is_active,
      created_at: provider.created_at,
      updated_at: provider.updated_at
    });
  } else {
    res.json(null);
  }
});

// GET single provider
router.get('/:id', (req, res) => {
  const provider = db.getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  res.json({
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    is_active: provider.is_active,
    created_at: provider.created_at,
    updated_at: provider.updated_at
  });
});

// POST new provider
router.post('/', (req, res) => {
  const { name, apiKey, baseURL } = req.body;
  if (!name || !baseURL) return res.status(400).json({ error: 'Name and baseURL are required' });

  const provider = db.createProvider({
    name,
    api_key: apiKey || '',
    base_url: baseURL,
    is_active: false
  });

  res.status(201).json({
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    is_active: provider.is_active,
    created_at: provider.created_at,
    updated_at: provider.updated_at
  });
});

// PUT update provider
router.put('/:id', (req, res) => {
  const { name, apiKey, baseURL } = req.body;
  const existing = db.getProvider(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Provider not found' });

  const data = {};
  if (name !== undefined) data.name = name;
  if (apiKey !== undefined) data.api_key = apiKey;
  if (baseURL !== undefined) data.base_url = baseURL;

  const updated = db.updateProvider(req.params.id, data);
  if (!updated) return res.status(404).json({ error: 'Provider not found' });

  // The provider changed (credentials or endpoint): its pricing catalog is
  // probably stale — refresh it in the background.
  if (data.api_key !== undefined || data.base_url !== undefined) {
    refreshPricingCatalog(updated).catch(() => {});
  }

  res.json({
    id: updated.id,
    name: updated.name,
    base_url: updated.base_url,
    is_active: updated.is_active,
    created_at: updated.created_at,
    updated_at: updated.updated_at
  });
});

// DELETE provider
router.delete('/:id', (req, res) => {
  db.deleteProvider(req.params.id);
  res.status(204).send();
});

// POST set active provider
router.post('/:id/activate', (req, res) => {
  const provider = db.setActiveProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  // Refresh the pricing catalog in the background: a provider outage must never
  // block the activation.
  refreshPricingCatalog(provider).catch(() => {});

  res.json({
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    is_active: provider.is_active,
    created_at: provider.created_at,
    updated_at: provider.updated_at
  });
});

// POST refresh the pricing catalog of a provider
router.post('/:id/refresh-pricing', async (req, res) => {
  const provider = db.getProvider(req.params.id);
  if (!provider) return res.status(404).json({ error: 'Provider not found' });

  const result = await refreshPricingCatalog(provider, { force: true });
  if (!result.ok) {
    return res.status(502).json({
      error: result.error || 'Failed to refresh pricing catalog',
      stale: true,
    });
  }

  res.json({
    success: true,
    models: Array.isArray(result.models) ? result.models.length : 0,
  });
});

module.exports = router;