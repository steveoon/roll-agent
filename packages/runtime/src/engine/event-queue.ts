export class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private resolver: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
        continue;
      }
      if (this.closed) {
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolver = resolve;
      });
      if (result.done) {
        return;
      }
      yield result.value;
    }
  }
}
