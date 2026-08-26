/** Hush command-catalog policy for container.table. */

import type { HushCatalogEntry } from "../contracts.ts";
import { containerSubcommand } from "./subcommand.ts";

const CONTAINER_TABLE_COMMANDS = new Set([
  "get",
  "images",
  "inspect",
  "pods",
  "ps",
  "services",
  "status",
]);

export const CONTAINER_TABLE_POLICY = {
  reducerId: "container.table",
  family: "container",
  projection: "table",
  executables: ["docker", "podman", "skopeo"],
  examples: [
    "docker ps",
    "docker images",
    "docker inspect app",
    "docker compose ps",
    "podman ps",
    "podman images",
    "podman inspect app",
    "podman compose ps",
    "skopeo inspect docker://image",
  ],
  matches: (tokens) => CONTAINER_TABLE_COMMANDS.has(containerSubcommand(tokens)),
} as const satisfies HushCatalogEntry;
