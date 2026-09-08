/** Retain existing work across caller release without admitting new work (#157). */
export function createResourceLifetime(dispose: () => void) {
  let accepting = true;
  let holders = 0;
  let disposed = false;
  const closing = new Set<() => void>();

  const settle = () => {
    if (accepting || holders !== 0 || disposed) return;
    disposed = true;
    dispose();
  };

  return {
    accepting: () => accepting,
    onClose(listener: () => void): (() => void) | null {
      if (!accepting) {
        listener();
        return () => {};
      }
      if (closing.size >= 64) return null;
      closing.add(listener);
      return () => {
        closing.delete(listener);
      };
    },
    retain(): (() => void) | null {
      if (!accepting || holders >= 64) return null;
      holders++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders--;
        settle();
      };
    },
    close() {
      if (!accepting) return;
      accepting = false;
      const failures: unknown[] = [];
      for (const listener of closing) {
        try {
          listener();
        } catch (error) {
          failures.push(error);
        }
      }
      closing.clear();
      settle();
      if (failures.length > 0) throw new AggregateError(failures, "resource close listener failed");
    },
  };
}
