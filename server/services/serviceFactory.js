const { DatabaseConnection, DatabaseAPI } = require('./db');
const ConversationManager = require('./conversationManager');
const ToolProcessor = require('./toolProcessor');
const aiController = require('../controllers/aiControllerSingleton');

let _instance = null;

class ServiceFactory {
  constructor() {
    if (_instance) return _instance;
    _instance = this;

    this._initialized = false;
    this._databaseConnection = null;
    this._databaseAPI = null;
    this._conversationManager = null;
    this._socketService = null;
    this._toolProcessor = null;
  }

  _ensureInitialized() {
    if (this._initialized) return;

    this._databaseConnection = new DatabaseConnection();
    this._databaseAPI = new DatabaseAPI(this._databaseConnection);
    this._socketService = this.getSocketService();
    this._toolProcessor = new ToolProcessor(this._databaseAPI, this._socketService);
    this._conversationManager = new ConversationManager(this._databaseAPI, this._socketService, this._toolProcessor, aiController);
    this._initialized = true;
  }

  getDatabaseConnection() {
    this._ensureInitialized();
    return this._databaseConnection;
  }

  getDatabaseAPI() {
    this._ensureInitialized();
    return this._databaseAPI;
  }

  getConversationManager() {
    this._ensureInitialized();
    return this._conversationManager;
  }

  getToolProcessor() {
    this._ensureInitialized();
    return this._toolProcessor;
  }

  getSocketService() {
    // Lazy require to avoid circular dependency with socketService.js
    if (!this._socketService) {
      this._socketService = require('./socketService');
    }
    return this._socketService;
  }

  reset() {
    this._databaseConnection = null;
    this._databaseAPI = null;
    this._conversationManager = null;
    this._socketService = null;
    this._toolProcessor = null;
    this._initialized = false;
    _instance = null;
  }

  close() {
    if (this._databaseConnection && typeof this._databaseConnection.close === 'function') {
      this._databaseConnection.close();
    }
    this._databaseConnection = null;
    this._databaseAPI = null;
    this._conversationManager = null;
    this._socketService = null;
    this._toolProcessor = null;
    this._initialized = false;
    _instance = null;
  }
}

module.exports = new ServiceFactory();