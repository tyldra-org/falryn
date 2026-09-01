/** Container corpus for the Hush projection scorecard. */

import type { ProjectionCase } from "./hush-projection-case.ts";

const NO_OMISSIONS = ["omitted", "…"] as const;

const CONTAINER_RUNTIME_CASES = ["docker", "podman"].flatMap((executable): ProjectionCase[] => [
  {
    id: `container-${executable}-ps`,
    projection: "table",
    executable,
    argv: ["ps"],
    ...(executable === "docker" ? { baseline: "raw" as const } : { rtkArgv: [executable, "ps"] }),
    competitiveTarget: "win",
    requiredMarkers: [
      "abc123",
      "falryn:dev",
      '"bun run dev"',
      "0.0.0.0:3000->3000/tcp",
      "falryn-dev",
      "def456",
      "postgres:17",
      "falryn-db",
    ],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-images`,
    projection: "table",
    executable,
    argv: ["images"],
    ...(executable === "docker"
      ? { baseline: "raw" as const }
      : { rtkArgv: [executable, "images"] }),
    competitiveTarget: "win",
    requiredMarkers: [
      "falryn",
      "latest",
      "img736",
      "2 hours ago",
      "1.2GB",
      "postgres",
      "img784",
      "438MB",
    ],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-inspect`,
    projection: "table",
    executable,
    argv: ["inspect", "falryn-dev"],
    rtkArgv: [executable, "inspect", "falryn-dev"],
    competitiveTarget: "win",
    requiredMarkers: [
      '"Id":"sha256:736abc784def"',
      '"Status":"running"',
      '"ExitCode":0',
      '"Image":"falryn:dev"',
      '"IPAddress":"172.18.0.2"',
      '"HostPort":"3000"',
    ],
    forbiddenMarkers: ["\n  ", ...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-compose-ps`,
    projection: "table",
    executable,
    argv: ["compose", "ps"],
    ...(executable === "docker"
      ? { baseline: "raw" as const }
      : { rtkArgv: [executable, "compose", "ps"] }),
    competitiveTarget: "win",
    requiredMarkers: [
      "falryn-api",
      "falryn",
      "falryn:dev",
      "0.0.0.0:3000->3000/tcp",
      "falryn-db",
      "postgres:17",
    ],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-logs`,
    projection: "log",
    executable,
    argv: ["logs", "falryn-dev"],
    rtkArgv: [executable, "logs", "falryn-dev"],
    competitiveTarget: "win",
    requiredMarkers: [
      "2026-08-25Z",
      "12:00:00.001 service started",
      "12:00:01.125 request=req-736 status=ok",
      "12:00:02.250 request=req-784 status=ok",
    ],
    forbiddenMarkers: ["2026-08-25T", ...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-compose-logs`,
    projection: "log",
    executable,
    argv: ["compose", "logs"],
    ...(executable === "docker"
      ? { baseline: "raw" as const }
      : { rtkArgv: [executable, "compose", "logs"] }),
    competitiveTarget: "win",
    requiredMarkers: [
      "[api] 2026-08-25Z",
      "12:00:00.001 service started",
      "12:00:01.125 request=req-736 status=ok",
      "[db] 2026-08-25Z",
      "12:00:02.250 request=req-784 status=ok",
    ],
    forbiddenMarkers: [" | ", ...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-run`,
    projection: "operation",
    executable,
    argv: ["run", "-d", "--name", "falryn-dev", "falryn:dev"],
    rtkArgv: [executable, "run", "-d", "--name", "falryn-dev", "falryn:dev"],
    requiredMarkers: ["736abc784def736abc784def736abc784def736abc784def736abc784def736a"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-exec`,
    projection: "operation",
    executable,
    argv: ["exec", "falryn-dev", "falryn", "status"],
    rtkArgv: [executable, "exec", "falryn-dev", "falryn", "status"],
    requiredMarkers: ["Falryn exec result: provider route ready", "exit=0"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-pull`,
    projection: "operation",
    executable,
    argv: ["pull", "bun:1.4"],
    rtkArgv: [executable, "pull", "bun:1.4"],
    competitiveTarget: "win",
    requiredMarkers:
      executable === "docker"
        ? [
            "ok docker pull docker.io/library/bun:1.4@sha256:736abc784def",
            "a736=Pull complete",
            "b784=Download complete",
            "Downloaded newer image for bun:1.4",
          ]
        : [
            "ok podman pull 2 blobs",
            "sha256:111aaa",
            "sha256:222bbb",
            "config sha256:333ccc",
            "sha256:736abc784def",
          ],
    forbiddenMarkers: ["Getting image source", "Copying blob", ...NO_OMISSIONS],
  },
  {
    id: `container-${executable}-stop`,
    projection: "operation",
    executable,
    argv: ["stop", "falryn-dev"],
    rtkArgv: [executable, "stop", "falryn-dev"],
    requiredMarkers: ["falryn-dev"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
]);

export const HUSH_CONTAINER_CASES: readonly ProjectionCase[] = [
  ...CONTAINER_RUNTIME_CASES,
  {
    id: "container-skopeo-inspect",
    projection: "table",
    executable: "skopeo",
    argv: ["inspect", "docker://docker.io/library/bun:1.4"],
    rtkArgv: ["skopeo", "inspect", "docker://docker.io/library/bun:1.4"],
    competitiveTarget: "win",
    requiredMarkers: [
      '"Name":"docker.io/library/bun"',
      '"Digest":"sha256:736abc784def"',
      '"RepoTags":["1.4","latest"]',
      '"Architecture":"arm64"',
      '"Layers":["sha256:111aaa","sha256:222bbb"]',
    ],
    forbiddenMarkers: ["\n  ", ...NO_OMISSIONS],
  },
  {
    id: "container-skopeo-copy",
    projection: "operation",
    executable: "skopeo",
    argv: ["copy", "docker://source/falryn:dev", "docker://target/falryn:dev"],
    baseline: "raw",
    competitiveTarget: "win",
    requiredMarkers: [
      "ok skopeo copy 2 blobs",
      "sha256:111aaa",
      "sha256:222bbb",
      "config sha256:333ccc; manifest; signatures",
    ],
    forbiddenMarkers: ["Getting image source", "Copying blob", ...NO_OMISSIONS],
  },
  {
    id: "container-skopeo-delete",
    projection: "operation",
    executable: "skopeo",
    argv: ["delete", "docker://registry.example/falryn:old"],
    rtkArgv: ["skopeo", "delete", "docker://registry.example/falryn:old"],
    requiredMarkers: ["Deleted docker://registry.example/falryn:old"],
    forbiddenMarkers: [...NO_OMISSIONS],
  },
];
