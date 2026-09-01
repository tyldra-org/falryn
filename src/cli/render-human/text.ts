/** Control-safe text primitives shared by human projections. */

import { type ConfigurationValue, sanitizeTerminalText } from "../../domain/index.ts";

/** Text from outside Falryn, rendered as data rather than as terminal control. */
export function safe(text: string): string {
  return sanitizeTerminalText(text);
}

/** One configuration value as a person reads it. */
export function displayValue(value: ConfigurationValue): string {
  return typeof value === "string" ? safe(value) : safe(JSON.stringify(value) ?? "null");
}
