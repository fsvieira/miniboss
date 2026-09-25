const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'data', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create winston logger with file and console transports
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'miniboss-server' },
  transports: [
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Separate file for errors
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    // Separate file for state machine debugging
    new winston.transports.File({
      filename: path.join(logsDir, 'debug.log'),
      level: 'debug',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// State machine specific logging methods
const stateLogger = {
  // Log state transitions in the state machine
  stateTransition: (from, to, context = {}) => {
    logger.debug('STATE_TRANSITION', {
      event: 'state_transition',
      from,
      to,
      ...context,
    });
  },

  // Log when a focus is created
  focusCreated: (focusId, systemPrompt = '', goal = '') => {
    logger.debug('FOCUS_CREATED', {
      event: 'focus_created',
      focusId,
      systemPrompt,
      goal,
    });
  },

  // Log when focus is transitioning to finalization phase
  focusFinalizing: (focusId, systemPrompt = '') => {
    logger.debug('FOCUS_FINALIZING', {
      event: 'focus_finalizing',
      focusId,
      systemPrompt,
    });
  },
};

module.exports = logger;
module.exports.stateLogger = stateLogger;