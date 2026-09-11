import { fileURLToPath, pathToFileURL } from "node:url";
import { languageServicesSchema } from "./configuration.ts";

export function languageServiceFixtureConfiguration(
  workspaceRoot: string,
  target: "launch" | "attach" = "launch",
) {
  return languageServicesSchema.parse({
    languageServers: [
      {
        serviceId: "fixture-lsp",
        workspaceRoot,
        serverName: "fixture",
        executable: process.execPath,
        argv: [
          fileURLToPath(new URL("../../language/language-server-fixtures.ts", import.meta.url)),
        ],
        environment: {},
        cwd: workspaceRoot,
        initialize: {
          processId: null,
          rootUri: pathToFileURL(workspaceRoot).href,
          workspaceFolders: null,
          capabilities: { textDocument: { hover: { contentFormat: ["plaintext"] } } },
          clientInfo: { name: "falryn-fixture", version: "1" },
        },
      },
    ],
    debugAdapters: [
      {
        serviceId: "fixture-dap",
        workspaceRoot,
        adapterName: "fixture",
        executable: process.execPath,
        argv: [
          fileURLToPath(new URL("../../debugging/debug-adapter-fixtures.ts", import.meta.url)),
        ],
        environment: {},
        cwd: workspaceRoot,
        initialize: {
          clientID: "falryn",
          clientName: "falryn",
          adapterID: "fixture",
          pathFormat: "path",
          linesStartAt1: true,
          columnsStartAt1: true,
        },
        targets: [
          {
            id: "fixture-target",
            kind: target,
            configuration: {
              program: `${workspaceRoot}/fixture.ts`,
              stopOnEntry: true,
              extension: { values: [1, false, null] },
            },
          },
        ],
      },
    ],
  });
}
