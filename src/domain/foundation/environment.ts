/**
 * The process-environment port.
 *
 * A leaf with one method, declared here for the same reason `SignalPort` is:
 * root resolution has to be testable without setting real environment
 * variables, and a test that mutates `process.env` leaks into every test that
 * runs after it.
 *
 * Reading an environment variable is not the same as adopting it. A value read
 * through this port is validated by its consumer and is never copied into a
 * durable record.
 */

export type EnvironmentPort = {
  /** The variable's value, or `null` when it is unset or empty. */
  get(name: string): string | null;
};

/**
 * An in-memory `EnvironmentPort` for tests.
 *
 * An empty string reads as unset, matching the port's contract: shells produce
 * an empty value for a variable that was exported without one, and treating
 * that as a configured path would resolve a root to nothing.
 */
export function createStaticEnvironment(
  values: Readonly<Record<string, string>> = {},
): EnvironmentPort {
  return {
    get(name: string): string | null {
      const value = values[name];
      return value === undefined || value === "" ? null : value;
    },
  };
}
