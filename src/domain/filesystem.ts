/** Public filesystem domain boundary. */

export * from "./filesystem/contracts.ts";
export {
  createInMemoryFileSystem,
  type InMemoryFileSystemOptions,
  type InMemoryNode,
} from "./filesystem/in-memory.ts";
