import { EventEmitter } from 'node:events';

// Singleton Event Bus for Long-Polling
class WorkerEventBus extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners if many workers are expected to connect concurrently
    this.setMaxListeners(1000);
  }
}

export const eventBus = new WorkerEventBus();
