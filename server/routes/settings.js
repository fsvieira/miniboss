const express = require('express');
const router = express.Router();
const { DatabaseAPI, DatabaseConnection } = require('../services/db');

// Database API instance
const connection = new DatabaseConnection();
const db = new DatabaseAPI(connection);

// GET setting
router.get('/:key', (req, res) => {
  const value = db.getSetting(req.params.key);
  res.json(value);
});

// POST/PUT setting
router.post('/', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Key is required' });

  db.setSetting(key, value);
  res.json({ key, value });
});

module.exports = router;