const { EventEmitter } = require('events');

class Queue {
  constructor(name) {
    this.name = name;
    this.items = [];
    this.emitter = new EventEmitter();
  }

  push(item) {
    this.items.push(item);
    this.emitter.emit('push', item);
  }

  pushAsync(item) {
    return new Promise((resolve, reject) => {
      this.push({ item, resolve, reject });
    });
  }

  pop() {
    return this.items.shift();
  }

  onPush(callback) {
    this.emitter.on('push', callback);
  }

  length() {
    return this.items.length;
  }

  clear() {
    this.items = [];
  }
}

module.exports = Queue;