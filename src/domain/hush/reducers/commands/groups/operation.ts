/** Ordered command-reducer group mirroring the Hush catalog. */

import { CLOUD_AWS_REDUCER } from "../cloud/aws.ts";
import { CLOUD_COMMAND_REDUCER } from "../cloud/command.ts";
import { CONTAINER_BUILD_REDUCER } from "../container/build.ts";
import { CONTAINER_LOG_REDUCER } from "../container/log.ts";
import { CONTAINER_OPERATION_REDUCER } from "../container/operation.ts";
import { CONTAINER_TABLE_REDUCER } from "../container/table.ts";
import { DATA_COMMAND_REDUCER } from "../data/command.ts";
import { DIAGNOSTIC_COMMAND_REDUCER } from "../diagnostic/command.ts";
import { INFRA_OPERATION_REDUCER } from "../infra/operation.ts";
import { KUBERNETES_LOG_REDUCER } from "../kubernetes/log.ts";
import { KUBERNETES_OPERATION_REDUCER } from "../kubernetes/operation.ts";
import { KUBERNETES_TABLE_REDUCER } from "../kubernetes/table.ts";
import { NETWORK_COMMAND_REDUCER } from "../network/command.ts";
import { NETWORK_CURL_REDUCER } from "../network/curl.ts";
import { NETWORK_WGET_REDUCER } from "../network/wget.ts";
import { OPERATION_COMMAND_REDUCER } from "../operation/command.ts";
import { PACKAGE_MANAGER_REDUCER } from "../package/manager.ts";
import { PRECOMMIT_DIAGNOSTIC_REDUCER } from "../precommit/diagnostic.ts";
import { SYSTEM_TABLE_REDUCER } from "../system/table.ts";
import { TASK_BUILD_REDUCER } from "../task/build.ts";

export const OPERATION_COMMAND_REDUCERS = {
  "container.table": CONTAINER_TABLE_REDUCER,
  "kubernetes.table": KUBERNETES_TABLE_REDUCER,
  "container.log": CONTAINER_LOG_REDUCER,
  "kubernetes.log": KUBERNETES_LOG_REDUCER,
  "container.build": CONTAINER_BUILD_REDUCER,
  "container.operation": CONTAINER_OPERATION_REDUCER,
  "kubernetes.operation": KUBERNETES_OPERATION_REDUCER,
  "package.manager": PACKAGE_MANAGER_REDUCER,
  "task.build": TASK_BUILD_REDUCER,
  "precommit.diagnostic": PRECOMMIT_DIAGNOSTIC_REDUCER,
  "cloud.aws": CLOUD_AWS_REDUCER,
  "cloud.command": CLOUD_COMMAND_REDUCER,
  "data.command": DATA_COMMAND_REDUCER,
  "network.curl": NETWORK_CURL_REDUCER,
  "network.wget": NETWORK_WGET_REDUCER,
  "network.command": NETWORK_COMMAND_REDUCER,
  "infra.operation": INFRA_OPERATION_REDUCER,
  "system.table": SYSTEM_TABLE_REDUCER,
  "diagnostic.command": DIAGNOSTIC_COMMAND_REDUCER,
  "operation.command": OPERATION_COMMAND_REDUCER,
} as const;
