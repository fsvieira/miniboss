const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { execSync } = require('child_process');

// Verify bubblewrap is available (mandatory for sandbox)
function checkBwrapAvailable() {
  try {
    execSync('which bwrap', { stdio: 'ignore' });
    console.log('[Startup] bubblewrap (bwrap) found - sandbox enabled');
  } catch {
    console.error('[Startup] FATAL: bubblewrap (bwrap) not found. Sandbox is mandatory.');
    console.error('[Startup] Install bubblewrap: apt-get install bubblewrap (Debian/Ubuntu) or equivalent');
    process.exit(1);
  }
}

checkBwrapAvailable();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const socketService = require('./services/socketService');
const { getDataFolder, getDatabasePath, getWorktreesRoot } = require('./config/paths');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  path: '/api/socket.io'
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

console.log('[env] dotenv loaded. LOG_LEVEL=' + (process.env.LOG_LEVEL || 'not set') + ', NODE_ENV=' + (process.env.NODE_ENV || 'not set'));
console.log('[env] CWD=' + process.cwd());
console.log('[env] .env expected at: ' + require('path').join(process.cwd(), '.env'));
console.log('[Startup] Effective PORT=' + PORT + ', HOST=' + HOST);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Import route modules
const projectsRoutes = require('./routes/projects');
const conversationsRoutes = require('./routes/conversations');
const messagesRoutes = require('./routes/messages');
const providersRoutes = require('./routes/providers');
const aiRoutes = require('./routes/ai');
const settingsRoutes = require('./routes/settings');
const searchRoutes = require('./routes/search');
const sandboxRoutes = require('./routes/sandbox');

// Initialize socket service
socketService.initialize(io);

// Connect AI controller to socket service for command approvals
const aiController = require('./controllers/aiControllerSingleton');
socketService.setAIController(aiController);

// Set up IO for routes that need WebSocket broadcasting
messagesRoutes.setIO(io);
aiRoutes.setIO(io);
conversationsRoutes.setIO(io);

// Routes
app.use('/api/projects', projectsRoutes);
app.use('/api/conversations', conversationsRoutes.router);
app.use('/api', messagesRoutes.router);
app.use('/api/providers', providersRoutes);
app.use('/api/ai', aiRoutes.router);
app.use('/api/settings', settingsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/sandbox', sandboxRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Recovery: limpar estados stuck de tools e conversas
const serviceFactory = require('./services/serviceFactory');
try {
  const cm = serviceFactory.getConversationManager();
  cm.recoverStuckStates();
  console.log('[Startup] Recovery completed');
} catch (err) {
  console.error('[Startup] Recovery error:', err);
}

// Start server
const httpServer = server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`Data folder: ${getDataFolder()}`);
  console.log(`Database: ${getDatabasePath()}`);
  console.log(`Worktrees: ${getWorktreesRoot()}`);
});

async function shutdown(signal) {
  console.log(`[Shutdown] Received ${signal}, shutting down...`);
  try {
    socketService.stopApprovalExpirySweep();
    const toolProcessor = serviceFactory.getToolProcessor();
    if (toolProcessor?.cleanup) await toolProcessor.cleanup();
    const cm = serviceFactory.getConversationManager();
    if (cm?.recoverStuckStates) cm.recoverStuckStates();
  } catch (err) { console.error('[Shutdown] Error:', err); }
  httpServer.close(() => { console.log('[Shutdown] HTTP closed'); process.exit(0); });
  setTimeout(() => { console.error('[Shutdown] Force exit'); process.exit(1); }, 10000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
