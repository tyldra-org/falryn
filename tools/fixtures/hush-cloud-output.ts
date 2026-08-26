/** Deterministic cloud-CLI output for the Hush scorecard. */

export function cloudFixtureOutput(executable: string, args: readonly string[]): string | null {
  if (executable === "aws") return awsOutput(args);
  if (executable === "gcloud") return gcloudOutput(args);
  if (executable === "az") return azureOutput(args);
  return null;
}

function awsOutput(args: readonly string[]): string {
  const command = `${args[0] ?? ""}:${args[1] ?? ""}`;
  switch (command) {
    case "sts:get-caller-identity":
      return json({
        Account: "123456789012",
        Arn: "arn:aws:iam::123456789012:user/falryn",
        UserId: "AIDAEXAMPLE",
      });
    case "s3:ls":
      return [
        "2026-08-25 12:00:00        736 manifest.json",
        "2026-08-25 12:01:00    1048576 falryn.tar.gz",
        "                           PRE releases/",
      ].join("\n");
    case "s3api:list-buckets":
      return json({
        Buckets: [
          { Name: "falryn-artifacts", CreationDate: "2026-08-20T10:00:00Z" },
          { Name: "falryn-releases", CreationDate: "2026-08-21T11:00:00Z" },
        ],
        Owner: { DisplayName: "falryn", ID: "owner-736" },
      });
    case "ec2:describe-instances":
      return json({
        Reservations: [
          {
            ReservationId: "r-0736",
            OwnerId: "123456789012",
            Instances: [
              {
                InstanceId: "i-0736",
                InstanceType: "m7g.large",
                State: { Code: 16, Name: "running" },
                PrivateIpAddress: "10.0.0.42",
                Tags: [{ Key: "Name", Value: "falryn-api" }],
              },
            ],
          },
        ],
      });
    case "ecs:list-clusters":
      return json({
        clusterArns: [
          "arn:aws:ecs:us-west-2:123456789012:cluster/falryn-prod",
          "arn:aws:ecs:us-west-2:123456789012:cluster/falryn-stage",
        ],
      });
    case "rds:describe-db-instances":
      return json({
        DBInstances: [
          {
            DBInstanceIdentifier: "falryn-db",
            DBInstanceClass: "db.m7g.large",
            Engine: "postgres",
            EngineVersion: "17.2",
            DBInstanceStatus: "available",
            Endpoint: { Address: "falryn-db.example", Port: 5432 },
            MultiAZ: true,
          },
        ],
      });
    case "cloudformation:describe-stack-events":
      return json({
        StackEvents: [
          {
            StackId: "arn:aws:cloudformation:us-west-2:123456789012:stack/falryn/736",
            EventId: "event-784",
            StackName: "falryn",
            LogicalResourceId: "FalrynApi",
            PhysicalResourceId: "i-0736",
            ResourceType: "AWS::EC2::Instance",
            Timestamp: "2026-08-25T12:00:00Z",
            ResourceStatus: "UPDATE_COMPLETE",
          },
        ],
      });
    case "logs:get-log-events":
      return json({
        events: [
          {
            timestamp: 1787668800000,
            message: "session=req-736 ready",
            ingestionTime: 1787668800100,
          },
          {
            timestamp: 1787668801000,
            message: "session=req-784 complete",
            ingestionTime: 1787668801100,
          },
        ],
        nextForwardToken: "f/736",
        nextBackwardToken: "b/784",
      });
    case "lambda:list-functions":
      return json({
        Functions: [
          {
            FunctionName: "falryn-context",
            FunctionArn: "arn:aws:lambda:us-west-2:123456789012:function:falryn-context",
            Runtime: "nodejs24.x",
            MemorySize: 1024,
            Timeout: 30,
            LastModified: "2026-08-25T12:00:00.000+0000",
          },
        ],
      });
    case "iam:list-roles":
      return json({
        Roles: [
          {
            Path: "/falryn/",
            RoleName: "FalrynRuntime",
            RoleId: "AROA736EXAMPLE",
            Arn: "arn:aws:iam::123456789012:role/falryn/FalrynRuntime",
            CreateDate: "2026-08-20T10:00:00Z",
          },
        ],
        IsTruncated: false,
      });
    case "dynamodb:scan":
      return json({
        Items: [
          { id: { S: "req-736" }, status: { S: "ready" }, tokens: { N: "188" } },
          { id: { S: "req-784" }, status: { S: "complete" }, tokens: { N: "219" } },
        ],
        Count: 2,
        ScannedCount: 2,
      });
    case "eks:list-clusters":
      return json({ clusters: ["falryn-prod", "falryn-stage"] });
    case "sqs:list-queues":
      return json({
        QueueUrls: [
          "https://sqs.us-west-2.amazonaws.com/123456789012/falryn-events",
          "https://sqs.us-west-2.amazonaws.com/123456789012/falryn-jobs",
        ],
      });
    case "secretsmanager:list-secrets":
      return json({
        SecretList: [
          {
            ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:falryn/provider",
            Name: "falryn/provider",
            LastChangedDate: "2026-08-25T11:00:00Z",
            SecretVersionsToStages: { "version-736": ["AWSCURRENT"] },
          },
        ],
        NextToken: null,
      });
    case "route53:list-hosted-zones":
      return json({
        HostedZones: [
          {
            Id: "/hostedzone/Z0736",
            Name: "falryn.example.",
            CallerReference: "falryn-736",
            Config: { PrivateZone: false },
            ResourceRecordSetCount: 42,
          },
        ],
        Marker: "",
        IsTruncated: false,
        MaxItems: "100",
      });
    default:
      throw new Error(`unsupported AWS fixture arguments: ${args.join(" ")}`);
  }
}

function gcloudOutput(args: readonly string[]): string {
  if (args[0] === "projects" && args[1] === "list") {
    return [
      "PROJECT_ID     NAME          PROJECT_NUMBER   LIFECYCLE_STATE",
      "falryn-prod    Falryn Prod   736784           ACTIVE",
      "falryn-stage   Falryn Stage  784736           ACTIVE",
    ].join("\n");
  }
  if (args[0] === "compute" && args[1] === "instances" && args[2] === "list") {
    return [
      "NAME          ZONE           MACHINE_TYPE   PREEMPTIBLE  INTERNAL_IP  EXTERNAL_IP    STATUS",
      "falryn-api    us-west1-a     c4a-standard-2               10.0.0.42   203.0.113.42   RUNNING",
      "falryn-worker  us-west1-b     c4a-standard-4               10.0.0.84   203.0.113.84   RUNNING",
    ].join("\n");
  }
  throw new Error(`unsupported gcloud fixture arguments: ${args.join(" ")}`);
}

function azureOutput(args: readonly string[]): string {
  if (args[0] === "group" && args[1] === "list") {
    return json([
      {
        id: "/subscriptions/sub-736/resourceGroups/falryn-prod",
        location: "westus2",
        name: "falryn-prod",
        properties: { provisioningState: "Succeeded" },
        tags: { env: "prod" },
      },
      {
        id: "/subscriptions/sub-736/resourceGroups/falryn-stage",
        location: "westus2",
        name: "falryn-stage",
        properties: { provisioningState: "Succeeded" },
        tags: { env: "stage" },
      },
    ]);
  }
  if (args[0] === "vm" && args[1] === "list") {
    return json([
      {
        id: "/subscriptions/sub-736/resourceGroups/falryn-prod/providers/Microsoft.Compute/virtualMachines/falryn-api",
        location: "westus2",
        name: "falryn-api",
        resourceGroup: "falryn-prod",
        hardwareProfile: { vmSize: "Standard_D2ps_v6" },
      },
    ]);
  }
  throw new Error(`unsupported Azure fixture arguments: ${args.join(" ")}`);
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
