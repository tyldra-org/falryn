export function kubernetesOutput(executable: "kubectl" | "oc", argv: readonly string[]): string {
  const verbIndex = kubernetesVerbIndex(argv);
  const verb = argv[verbIndex];
  const argument = argv[verbIndex + 1];
  if (verb === "get" || verb === "pods" || verb === "services") {
    const resource = verb === "get" ? argument : verb;
    if (resource === "pods" || resource === "pod" || resource === "po") {
      if (kubernetesRequestedOutput(argv) === "json") return kubernetesPodsJson();
      return kubernetesPodsOutput(argv.includes("wide") || argv.includes("-o=wide"));
    }
    if (resource === "services" || resource === "service" || resource === "svc") {
      if (kubernetesRequestedOutput(argv) === "json") return kubernetesServicesJson();
      return kubernetesServicesOutput();
    }
  }
  if (verb === "status" && executable === "oc") return openShiftStatusOutput();
  if (verb === "logs") {
    if (argv.includes("plain")) return "ready\nready\nrequest=req-736 status=ok";
    return kubernetesLogsOutput(argv.includes("--prefix"));
  }
  if (verb === "describe") return kubernetesDescribeOutput();
  if (verb === "apply") {
    return [
      "deployment.apps/falryn configured",
      "service/falryn configured",
      "configmap/falryn created",
    ].join("\n");
  }
  if (verb === "create") return "namespace/falryn created";
  if (verb === "delete") return 'pod "falryn-old" deleted';
  if (verb === "rollout") return 'deployment "falryn" successfully rolled out';
  if (verb === "scale") return "deployment.apps/falryn scaled";
  if (verb === "auth") return "yes";
  if (verb === "adm" && argument === "top") return openShiftTopOutput();
  if (verb === "adm") return 'clusterrole.rbac.authorization.k8s.io/admin added: "falryn"';
  throw new Error(`unsupported ${executable} fixture arguments: ${argv.join(" ")}`);
}

function kubernetesRequestedOutput(argv: readonly string[]): string | null {
  const index = argv.findIndex((token) => token === "-o" || token === "--output");
  if (index >= 0) return argv[index + 1] ?? "";
  const inline = argv.find((token) => token.startsWith("-o=") || token.startsWith("--output="));
  return inline?.slice(inline.indexOf("=") + 1) ?? null;
}

function kubernetesVerbIndex(argv: readonly string[]): number {
  const optionsWithValue = new Set(["--context", "--kubeconfig", "--namespace", "-n"]);
  let index = 0;
  while (index < argv.length) {
    const token = argv[index] ?? "";
    if (!token.startsWith("-")) return index;
    index += optionsWithValue.has(token) && !token.includes("=") ? 2 : 1;
  }
  return index;
}

function kubernetesPodsOutput(wide: boolean): string {
  if (wide) {
    return [
      "NAME             READY   STATUS    RESTARTS       AGE   IP           NODE       NOMINATED NODE   READINESS GATES",
      "falryn-api       1/1     Running   0              2m    10.42.0.8    worker-1   <none>           <none>",
      "falryn-worker    1/1     Running   1 (30s ago)    5m    10.42.0.11   worker-2   <none>           <none>",
    ].join("\n");
  }
  return [
    "NAME             READY   STATUS    RESTARTS       AGE",
    "falryn-api       1/1     Running   0              2m",
    "falryn-worker    1/1     Running   1 (30s ago)    5m",
  ].join("\n");
}

function kubernetesPodsJson(): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        metadata: {
          name: "falryn-api",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:58:00Z",
        },
        spec: { nodeName: "worker-1" },
        status: {
          phase: "Running",
          podIP: "10.42.0.8",
          containerStatuses: [{ ready: true, restartCount: 0 }],
        },
      },
      {
        metadata: {
          name: "falryn-worker",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:55:00Z",
        },
        spec: { nodeName: "worker-2" },
        status: {
          phase: "Running",
          podIP: "10.42.0.11",
          containerStatuses: [{ ready: true, restartCount: 1 }],
        },
      },
    ],
  });
}

function kubernetesServicesOutput(): string {
  return [
    "NAME         TYPE        CLUSTER-IP    EXTERNAL-IP   PORT(S)    AGE",
    "falryn       ClusterIP   10.96.0.42    <none>        3000/TCP   2m",
    "falryn-db    ClusterIP   10.96.0.84    <none>        5432/TCP   5m",
  ].join("\n");
}

function kubernetesServicesJson(): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        metadata: {
          name: "falryn",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:58:00Z",
        },
        spec: {
          type: "ClusterIP",
          clusterIP: "10.96.0.42",
          ports: [{ port: 3000, protocol: "TCP" }],
        },
      },
      {
        metadata: {
          name: "falryn-db",
          namespace: "falryn",
          creationTimestamp: "2026-08-25T11:55:00Z",
        },
        spec: {
          type: "ClusterIP",
          clusterIP: "10.96.0.84",
          ports: [{ port: 5432, protocol: "TCP" }],
        },
      },
    ],
  });
}

function openShiftStatusOutput(): string {
  return [
    "In project falryn on server https://api.example:6443",
    "",
    "svc/falryn - 10.96.0.42:3000",
    "  deployment/falryn deploys image falryn:dev",
    "    deployment #2 running for 2 minutes - 1 pod",
    "",
    "View details with 'oc describe <resource>/<name>' or list everything with 'oc get all -o yaml'.",
  ].join("\n");
}

function kubernetesLogsOutput(prefixed: boolean): string {
  const lines = [
    "2026-08-25T12:00:00.001Z service started",
    "2026-08-25T12:00:01.125Z request=req-736 status=ok",
    "2026-08-25T12:00:02.250Z request=req-784 status=ok",
  ];
  return prefixed
    ? lines
        .map(
          (line, index) =>
            `[pod/${index === 2 ? "falryn-worker" : "falryn-api"}/container/falryn] ${line}`,
        )
        .join("\n")
    : lines.join("\n");
}

function kubernetesDescribeOutput(): string {
  return [
    "Name:             falryn-api",
    "Namespace:        falryn",
    "Priority:         0",
    "Service Account:  falryn",
    "Node:             worker-1/10.0.0.11",
    "Start Time:       Tue, 25 Aug 2026 11:58:00 -0700",
    "Labels:           app=falryn",
    "                  component=api",
    "Annotations:      checksum/config=736abc",
    "Status:           Running",
    "IP:               10.42.0.8",
    "Containers:",
    "  falryn:",
    "    Container ID:  containerd://sha256:736abc784def",
    "    Image:         falryn:dev",
    "    State:         Running",
    "      Started:     Tue, 25 Aug 2026 11:58:01 -0700",
    "    Ready:         True",
    "    Restart Count: 0",
    "Conditions:",
    "  Type              Status",
    "  PodReadyToStartContainers   True",
    "  Initialized       True",
    "  Ready             True",
    "Events:",
    "  Type    Reason     Age   From               Message",
    "  Normal  Scheduled  2m    default-scheduler  Successfully assigned falryn/falryn-api to worker-1",
  ].join("\n");
}

function openShiftTopOutput(): string {
  return [
    "NAME             CPU(cores)   MEMORY(bytes)",
    "falryn-api       25m          96Mi",
    "falryn-worker    12m          64Mi",
  ].join("\n");
}
