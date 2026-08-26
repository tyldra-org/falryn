/** Hush command-catalog policy for container.log. */

import type { HushCatalogEntry } from "../contracts.ts";
import { containerSubcommand } from "./subcommand.ts";

const CONTAINER_LOG_COMMANDS = new Set(["logs"]);

export const CONTAINER_LOG_POLICY = {
  reducerId: "container.log",
  family: "container",
  projection: "log",
  executables: ["docker", "podman"],
  examples: ["docker logs app", "docker compose logs", "podman logs app", "podman compose logs"],
  matches: (tokens) => CONTAINER_LOG_COMMANDS.has(containerSubcommand(tokens)),
} as const satisfies HushCatalogEntry;
