/** Hush command-catalog policy for container.build. */

import type { HushCatalogEntry } from "../contracts.ts";
import { containerSubcommand } from "./subcommand.ts";

export const CONTAINER_BUILD_POLICY = {
  reducerId: "container.build",
  family: "build",
  projection: "build",
  executables: ["docker", "podman"],
  examples: ["docker build .", "docker compose build", "podman build .", "podman compose build"],
  matches: (tokens) => containerSubcommand(tokens) === "build",
} as const satisfies HushCatalogEntry;
