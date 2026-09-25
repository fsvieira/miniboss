/**
 * Database module — Abstraction layer for CRUD operations.
 */

// Re-export connection class
const { DatabaseConnection } = require('./connection');

// Re-export API class
const { DatabaseAPI } = require('./api');

module.exports = {
  DatabaseConnection,
  DatabaseAPI,
};