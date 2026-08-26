/** Deterministic curl and wget output for the Hush scorecard. */

export type HttpFixtureOutput = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  download: Readonly<{ path: string; bytes: number }> | null;
}>;

export function curlFixtureOutput(args: readonly string[]): HttpFixtureOutput {
  const url = requiredUrl("curl", args);
  const progress = curlProgress();
  if (url.endsWith("/status")) {
    return fixture(
      JSON.stringify(
        { status: "ok", requestId: "req-736", result: { reducers: 82, complete: true } },
        null,
        2,
      ),
      progress,
    );
  }
  if (url.endsWith("/headers")) {
    return fixture(
      [
        "HTTP/2 200",
        "content-type: application/json",
        'etag: "falryn-736"',
        "x-request-id: req-784",
        "",
        "{",
        '  "status": "ready",',
        '  "nested": { "reducers": 82 }',
        "}",
      ].join("\r\n"),
      progress,
    );
  }
  if (url.endsWith("/events")) {
    return fixture(
      [
        "session req-736 opened",
        ...Array.from({ length: 40 }, () => "heartbeat ready"),
        "done",
      ].join("\n"),
      progress,
    );
  }
  if (url.endsWith("/missing")) {
    return {
      stdout: JSON.stringify(
        { error: "not_found", requestId: "req-404", recoverable: false },
        null,
        2,
      ),
      stderr: `${progress}curl: (22) The requested URL returned error: 404\n`,
      exitCode: 22,
      download: null,
    };
  }
  throw new Error(`unsupported curl fixture arguments: ${args.join(" ")}`);
}

export function wgetFixtureOutput(args: readonly string[]): HttpFixtureOutput {
  const url = requiredUrl("wget", args);
  const destination = wgetDestination(args, url);
  const quiet = args.includes("-q") || args.includes("--quiet");
  if (url.endsWith("/data.json")) {
    const stdout = JSON.stringify(
      {
        status: "ready",
        items: Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, value: index })),
        next: null,
      },
      null,
      2,
    );
    return fixture(stdout, quiet ? "" : wgetProgress(url, destination, "application/json"));
  }
  if (url.endsWith("/latest")) {
    return {
      stdout: "",
      stderr: [
        `--2026-08-25 12:00:00--  ${url}`,
        "HTTP request sent, awaiting response... 302 Found",
        "Location: https://cdn.example.test/releases/falryn.tar.gz [following]",
        "HTTP request sent, awaiting response... 200 OK",
        "Length: 1536 (1.5K) [application/gzip]",
        `Saving to: '${destination}'`,
        "     0K .                                                     100% 1.50M=0.001s",
        `2026-08-25 12:00:01 (1.50 MB/s) - '${destination}' saved [1536/1536]`,
        "",
      ].join("\n"),
      exitCode: 0,
      download: destination === "-" ? null : { path: destination, bytes: 1_536 },
    };
  }
  if (url.endsWith("/missing")) {
    return {
      stdout: "",
      stderr: [
        "HTTP request sent, awaiting response... 404 Not Found",
        "     0K .......... 100% 1.50M=0.001s",
        "ERROR 404: Not Found.",
        "",
      ].join("\n"),
      exitCode: 8,
      download: null,
    };
  }
  if (!url.endsWith("/falryn.tar.gz")) {
    throw new Error(`unsupported wget fixture arguments: ${args.join(" ")}`);
  }
  return {
    stdout: "",
    stderr: quiet ? "" : wgetProgress(url, destination, "application/gzip"),
    exitCode: 0,
    download: destination === "-" ? null : { path: destination, bytes: 1_536 },
  };
}

function fixture(stdout: string, stderr: string): HttpFixtureOutput {
  return { stdout, stderr, exitCode: 0, download: null };
}

function requiredUrl(executable: string, args: readonly string[]): string {
  const url = args.find((argument) => /^https?:\/\//u.test(argument));
  if (url === undefined) throw new Error(`${executable}: missing URL`);
  return url;
}

function curlProgress(): string {
  return [
    "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
    "                                 Dload  Upload   Total   Spent    Left  Speed",
    "100   102  100   102    0     0   1020      0 --:--:-- --:--:-- --:--:--  1020",
    "",
  ].join("\n");
}

function wgetProgress(url: string, destination: string, contentType: string): string {
  return [
    `--2026-08-25 12:00:00--  ${url}`,
    "Resolving example.test... 192.0.2.80",
    "Connecting to example.test|192.0.2.80|:443... connected.",
    "HTTP request sent, awaiting response... 200 OK",
    `Length: 1536 (1.5K) [${contentType}]`,
    `Saving to: '${destination}'`,
    "",
    "     0K .                                                     100% 1.50M=0.001s",
    "",
    `2026-08-25 12:00:01 (1.50 MB/s) - '${destination}' saved [1536/1536]`,
    "",
  ].join("\n");
}

function wgetDestination(args: readonly string[], url: string): string {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if ((argument === "-O" || argument === "--output-document") && args[index + 1] !== undefined) {
      return args[index + 1] ?? "index.html";
    }
    const inline = argument.match(/^(?:-O|--output-document=)(.+)$/u)?.[1];
    if (inline !== undefined) return inline;
  }
  const path = url.split(/[?#]/u, 1)[0] ?? url;
  return path.split("/").at(-1) || "index.html";
}
