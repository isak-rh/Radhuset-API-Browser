/** Minimal event emitter. `on` returns a function that removes the handler. */
export class Emitter {
  #handlers = new Map();

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return () => this.#handlers.get(event)?.delete(handler);
  }

  emit(event, ...args) {
    for (const handler of [...(this.#handlers.get(event) || [])]) handler(...args);
  }
}
