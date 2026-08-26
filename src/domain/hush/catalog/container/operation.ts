/** Hush command-catalog policy for container.operation. */

import type { HushCatalogEntry } from "../contracts.ts";

export const CONTAINER_OPERATION_POLICY = {
  reducerId: "container.operation",
  family: "container",
  projection: "operation",
  executables: ["docker", "podman", "skopeo"],
  examples: [
    "docker run image",
    "docker exec app command",
    "docker pull image",
    "podman run image",
    "podman exec app command",
    "podman pull image",
    "skopeo copy source target",
  ],
} as const satisfies HushCatalogEntry;
