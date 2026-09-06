import { buildkitOutput } from "./build.ts";

export function podmanOutput(argv: readonly string[]): string {
  const compose = argv[0] === "compose";
  const action = compose ? argv[1] : argv[0];
  if (action === "build") {
    return [
      "STEP 1/3: FROM docker.io/library/bun:1.4",
      "STEP 2/3: COPY . /app",
      "STEP 3/3: RUN bun run build",
      "COMMIT falryn:latest",
      "--> 736abc784def",
      "Successfully tagged localhost/falryn:latest",
      "736abc784def",
      ...(compose ? ["falryn Built"] : []),
    ].join("\n");
  }
  if (action === "ps") return containerPsOutput(compose, hasFormatOption(argv));
  if (action === "images") return containerImagesOutput(hasFormatOption(argv));
  if (action === "inspect") return containerInspectOutput("podman");
  if (action === "logs") return containerLogsOutput(compose);
  if (action === "run") return "736abc784def736abc784def736abc784def736abc784def736abc784def736a";
  if (action === "exec") return "Falryn exec result: provider route ready\nexit=0";
  if (action === "pull") return copyProgressOutput(true);
  if (action === "stop") return "falryn-dev";
  throw new Error(`unsupported podman fixture arguments: ${argv.join(" ")}`);
}

export function dockerOutput(argv: readonly string[]): string {
  if (argv[0] === "build" || (argv[0] === "compose" && argv[1] === "build")) {
    return buildkitOutput(argv[0] === "compose");
  }
  const compose = argv[0] === "compose";
  const action = compose ? argv[1] : argv[0];
  if (action === "ps") return containerPsOutput(compose, hasFormatOption(argv));
  if (action === "images") return containerImagesOutput(hasFormatOption(argv));
  if (action === "inspect") return containerInspectOutput("docker");
  if (action === "logs") return containerLogsOutput(compose);
  if (action === "run") return "736abc784def736abc784def736abc784def736abc784def736abc784def736a";
  if (action === "exec") return "Falryn exec result: provider route ready\nexit=0";
  if (action === "pull") return dockerPullOutput();
  if (action === "stop") return "falryn-dev";
  throw new Error(`unsupported docker fixture arguments: ${argv.join(" ")}`);
}

function containerPsOutput(compose: boolean, formatted: boolean): string {
  if (formatted) {
    return compose
      ? [
          "falryn-api\tfalryn\tfalryn:dev\trunning\t0.0.0.0:3000->3000/tcp",
          "falryn-db\tdb\tpostgres:17\trunning\t5432/tcp",
        ].join("\n")
      : [
          "abc123\tfalryn-dev\tUp 2 minutes\tfalryn:dev\t0.0.0.0:3000->3000/tcp",
          "def456\tfalryn-db\tUp 2 minutes\tpostgres:17\t5432/tcp",
        ].join("\n");
  }
  if (compose) {
    return [
      "NAME          SERVICE   IMAGE          STATUS          PORTS",
      "falryn-api    falryn    falryn:dev     Up 2 minutes    0.0.0.0:3000->3000/tcp",
      "falryn-db     db        postgres:17    Up 2 minutes    5432/tcp",
    ].join("\n");
  }
  return [
    "CONTAINER ID   IMAGE          COMMAND          STATUS          PORTS                         NAMES",
    'abc123         falryn:dev     "bun run dev"    Up 2 minutes    0.0.0.0:3000->3000/tcp    falryn-dev',
    'def456         postgres:17    "postgres"       Up 2 minutes    5432/tcp                      falryn-db',
  ].join("\n");
}

function containerImagesOutput(formatted: boolean): string {
  if (formatted) {
    return [
      "falryn\tlatest\timg736\t2 hours ago\t1.2GB",
      "postgres\t17\timg784\t3 days ago\t438MB",
    ].join("\n");
  }
  return [
    "REPOSITORY   TAG      IMAGE ID   CREATED       SIZE",
    "falryn       latest   img736     2 hours ago   1.2GB",
    "postgres     17       img784     3 days ago    438MB",
  ].join("\n");
}

function hasFormatOption(argv: readonly string[]): boolean {
  return argv.some((token) => token === "--format" || token.startsWith("--format="));
}

function containerInspectOutput(executable: "docker" | "podman"): string {
  return JSON.stringify(
    [
      {
        Id: "sha256:736abc784def",
        Name: "/falryn-dev",
        Driver: executable === "podman" ? "overlay" : "overlay2",
        State: { Status: "running", Running: true, ExitCode: 0, Pid: 736 },
        Config: { Image: "falryn:dev", Env: ["NODE_ENV=development"] },
        NetworkSettings: {
          IPAddress: "172.18.0.2",
          Ports: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "3000" }] },
        },
      },
    ],
    null,
    2,
  );
}

function containerLogsOutput(compose: boolean): string {
  const lines = [
    "2026-08-25T12:00:00.001Z service started",
    "2026-08-25T12:00:01.125Z request=req-736 status=ok",
    "2026-08-25T12:00:02.250Z request=req-784 status=ok",
  ];
  return compose
    ? lines.map((line, index) => `${index === 2 ? "db" : "api"}     | ${line}`).join("\n")
    : lines.join("\n");
}

function dockerPullOutput(): string {
  return [
    "1.4: Pulling from library/bun",
    "a736: Pulling fs layer",
    "b784: Download complete",
    "a736: Pull complete",
    "Digest: sha256:736abc784def",
    "Status: Downloaded newer image for bun:1.4",
    "docker.io/library/bun:1.4",
  ].join("\n");
}

function copyProgressOutput(includeIdentity: boolean): string {
  return [
    "Getting image source signatures",
    "Copying blob sha256:111aaa",
    "Copying blob sha256:222bbb",
    "Copying config sha256:333ccc",
    "Writing manifest to image destination",
    "Storing signatures",
    ...(includeIdentity ? ["sha256:736abc784def"] : []),
  ].join("\n");
}

export function skopeoOutput(argv: readonly string[]): string {
  if (argv[0] === "inspect") {
    return JSON.stringify(
      {
        Name: "docker.io/library/bun",
        Digest: "sha256:736abc784def",
        RepoTags: ["1.4", "latest"],
        Created: "2026-08-25T12:00:00Z",
        Architecture: "arm64",
        Os: "linux",
        Layers: ["sha256:111aaa", "sha256:222bbb"],
      },
      null,
      2,
    );
  }
  if (argv[0] === "copy") return copyProgressOutput(false);
  if (argv[0] === "delete") return "Deleted docker://registry.example/falryn:old";
  throw new Error(`unsupported skopeo fixture arguments: ${argv.join(" ")}`);
}
