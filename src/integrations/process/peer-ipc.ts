/** One bounded request per private local socket. No TCP or remote fallback. */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { err, ok } from "../../domain/foundation/result.ts";
import { MAILBOX_LIMITS, type PeerResult } from "../../domain/orchestration/peer-mailbox.ts";
import type { PeerTransport } from "../../domain/orchestration/peer-transport.ts";

const FRAME_BYTES = 65_536;
let processConnections = 0;
function readFrame(socket: Socket): Promise<PeerResult<unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: PeerResult<unknown>) => {
      if (settled) return;
      settled = true;
      socket.off("data", data);
      socket.off("close", close);
      socket.off("error", close);
      resolve(result);
    };
    const close = () => finish(err({ code: "unavailable" }));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > FRAME_BYTES) {
        finish(err({ code: "full" }));
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      if (newline !== chunk.length - 1) {
        finish(err({ code: "invalid" }));
        socket.destroy();
        return;
      }
      try {
        finish(ok(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch {
        finish(err({ code: "invalid" }));
        socket.destroy();
      }
    };
    socket.on("data", data);
    socket.once("close", close);
    socket.once("error", close);
  });
}
function frame(value: unknown): string | null {
  try {
    const text = `${JSON.stringify(value)}\n`;
    return Buffer.byteLength(text) <= FRAME_BYTES ? text : null;
  } catch {
    return null;
  }
}
export function createPeerIpc(options: { directory: string; platform?: string }): PeerTransport {
  const platform = options.platform ?? process.platform;
  const pipePrefix = "\\\\.\\pipe\\falryn-peer-";
  const localAddress = (address: string) =>
    platform === "win32"
      ? address.startsWith(pipePrefix) && /^[a-f0-9-]{36}$/u.test(address.slice(pipePrefix.length))
      : address.startsWith(`${options.directory}/`) &&
        /^[a-f0-9-]{12}\/p$/u.test(address.slice(options.directory.length + 1));
  return {
    async retire(address) {
      if (platform === "win32" || !localAddress(address)) return;
      const directory = address.slice(0, -2);
      const entry = await lstat(directory).catch(() => null);
      if (
        !entry?.isDirectory() ||
        entry.isSymbolicLink() ||
        (entry.mode & 0o077) !== 0 ||
        (process.getuid && entry.uid !== process.getuid())
      )
        return;
      await rm(directory, { recursive: true }).catch(() => {});
    },
    async listen(handler) {
      if (!["darwin", "linux", "win32"].includes(platform)) return err({ code: "unavailable" });
      const sockets = new Set<Socket>();
      const calls = new Set<Promise<void>>();
      let closed = false;
      let directory: string | null = null;
      const server = createServer((socket) => {
        if (closed || processConnections >= MAILBOX_LIMITS.waiters) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        processConnections += 1;
        const controller = new AbortController();
        socket.setTimeout(MAILBOX_LIMITS.admissionMs, () => socket.destroy());
        socket.on("error", () => socket.destroy());
        socket.once("close", () => {
          sockets.delete(socket);
          processConnections -= 1;
          controller.abort();
        });
        const call = (async () => {
          try {
            const request = await readFrame(socket);
            if (!request.ok) return;
            const value = await handler(request.value, controller.signal);
            const output = frame(value);
            if (output !== null && !socket.destroyed) socket.end(output);
          } catch {
            /* The caller observes an unavailable result, never host error text. */
          } finally {
            if (!socket.writableEnded) socket.destroy();
          }
        })();
        calls.add(call);
        void call.finally(() => calls.delete(call));
      });
      server.on("error", () => {
        for (const socket of sockets) socket.destroy();
      });
      try {
        const token = randomUUID();
        let address: string;
        if (platform === "win32") address = `\\\\.\\pipe\\falryn-peer-${token}`;
        else {
          await mkdir(options.directory, { recursive: true, mode: 0o700 });
          const parent = await lstat(options.directory);
          if (
            !parent.isDirectory() ||
            parent.isSymbolicLink() ||
            (parent.mode & 0o077) !== 0 ||
            (process.getuid && parent.uid !== process.getuid())
          )
            throw new Error("private IPC directory required");
          directory = join(options.directory, token.slice(0, 12));
          await mkdir(directory, { mode: 0o700 });
          address = join(directory, "p");
          if (Buffer.byteLength(address) > 100) throw new Error("local IPC path unavailable");
        }
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(address, () => {
            server.off("error", reject);
            resolve();
          });
        });
        if (platform !== "win32") await chmod(address, 0o600);
        return ok({
          address,
          async close() {
            if (closed) return;
            closed = true;
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await Promise.allSettled(calls);
            if (directory) await rm(directory, { recursive: true, force: true });
          },
        });
      } catch {
        for (const socket of sockets) socket.destroy();
        server.close();
        if (directory) await rm(directory, { recursive: true }).catch(() => {});
        return err({ code: "unavailable" });
      }
    },
    async request(address, input, signal) {
      if (signal.aborted) return err({ code: "cancelled" });
      if (!localAddress(address)) return err({ code: "denied" });
      const output = frame(input);
      if (output === null) return err({ code: "full" });
      const socket = createConnection({ path: address });
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      socket.setTimeout(MAILBOX_LIMITS.admissionMs, abort);
      socket.on("error", abort);
      const read = readFrame(socket);
      socket.once("connect", () => socket.write(output));
      try {
        return await read;
      } finally {
        signal.removeEventListener("abort", abort);
        socket.destroy();
      }
    },
  };
}
