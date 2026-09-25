const Queue = require('./queues');

class QueueManager {
  constructor() {
    this.queues = {};
    this.providerQueues = {};
  }

  getQueue(name) {
    if (!this.queues[name]) {
      this.queues[name] = new Queue(name);
    }
    return this.queues[name];
  }

  getProviderQueue(key) {
    if (!this.providerQueues[key]) {
      this.providerQueues[key] = new Queue(`provider:${key}`);
    }
    return this.providerQueues[key];
  }

  clearAll() {
    for (const name in this.queues) {
      this.queues[name].clear();
    }
    for (const key in this.providerQueues) {
      this.providerQueues[key].clear();
    }
  }
}

// Export singleton instance
const manager = new QueueManager();
module.exports = manager;