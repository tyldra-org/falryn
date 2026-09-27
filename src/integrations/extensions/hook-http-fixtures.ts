/**
 * Test support for package HTTP hooks (#1175): a throwaway certificate for a test
 * hostname. Declarations and decisions live in the domain hook fixtures.
 * Nothing here is used by the product host.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A self-signed certificate and key for one hostname, or null without openssl. */
export function hookTestCertificate(hostname: string): { cert: string; key: string } | null {
  const directory = mkdtempSync(join(tmpdir(), "falryn-hook-tls-"));
  try {
    const made = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=" + hostname,
        "-addext",
        "subjectAltName=DNS:" + hostname,
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (made.exitCode !== 0) return null;
    return {
      cert: readFileSync(join(directory, "cert.pem"), "utf8"),
      key: readFileSync(join(directory, "key.pem"), "utf8"),
    };
  } catch {
    return null;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
