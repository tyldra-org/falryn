import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import { PACKAGE_HEALTH_PROTOCOL } from "../../domain/extensions/package-health.ts";

/** A standalone native protocol peer. No package code is imported by Falryn. */
export async function nativeHealthFixture(directory: string, mode = "healthy", target = "") {
  const source = join(directory, "health.c"),
    output = join(directory, "health-peer");
  await writeFile(
    source,
    `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <sys/wait.h>
int main(int argc,char **argv) {
  char line[16385];
  setvbuf(stdout,NULL,_IONBF,0);
  if(argc>1 && strcmp(argv[1],"crash")==0) return 17;
  if(argc>1 && strcmp(argv[1],"timeout")==0) { for(;;) pause(); }
  if(argc>1 && strcmp(argv[1],"flood")==0) { for(int i=0;i<100000;i++) putchar('x'); for(;;) pause(); }
  if(argc>1 && (strcmp(argv[1],"hostile")==0 || strcmp(argv[1],"control")==0)) {
    int allowed=0;
    if(getenv("FALRYN_HEALTH_SECRET") || getenv("HOME") || getenv("PATH")) allowed|=1;
    int fd=open("write-escape",O_WRONLY|O_CREAT,0600); if(fd>=0) { close(fd); allowed|=2; }
    if(argc>2) { fd=open(argv[2],O_RDONLY); if(fd>=0) { close(fd); allowed|=4; } }
    int s=socket(AF_INET,SOCK_STREAM,0); struct sockaddr_in a={0}; a.sin_family=AF_INET;
    if(s>=0) { if(bind(s,(struct sockaddr*)&a,sizeof(a))==0) allowed|=8; close(s); }
    pid_t child=fork(); if(child==0) _exit(0); if(child>0) { waitpid(child,NULL,0); allowed|=16; }
    if(strcmp(argv[1],"control")==0) { printf("%d",allowed); return 0; }
    if(allowed) return 20+allowed;
  }
  while(fgets(line,sizeof(line),stdin)) {
    size_t n=strlen(line); while(n && (line[n-1]=='\\n'||line[n-1]=='\\r')) n--;
    if(n<2 || line[n-1]!='}') return 30;
    if(argc>1 && strcmp(argv[1],"forged")==0) { puts("{\\"protocol\\":\\"forged\\"}"); continue; }
    if(argc>1 && strcmp(argv[1],"wrong-binding")==0) { char *digest=strstr(line,"sha256:"); if(digest) digest[7]=digest[7]=='a'?'b':'a'; }
    printf("%.*s,\\"result\\":\\"ok\\"}\\n",(int)n-1,line);
  }
  return 0;
}
`,
  );
  const built = Bun.spawnSync(["/usr/bin/cc", source, "-o", output], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (built.exitCode !== 0)
    throw new Error(
      `native health fixture build failed: ${new TextDecoder().decode(built.stderr)}`,
    );
  const bytes = new Uint8Array(await readFile(output));
  const declaration = contributionDeclarationSchema.parse({
    kind: "tool",
    namespace: "fixture",
    id: "health",
    description: "Native health fixture",
    family: "read",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authority: {
      effects: ["observation"],
      permissions: [],
      roots: [],
      destinations: [],
      secretReferences: [],
      localData: [],
    },
    execution: {
      mode: "governed",
      executable: "health-peer",
      argv: [mode, target],
      loader: "native",
      protocolVersion: PACKAGE_HEALTH_PROTOCOL,
      compatibility: { os: ["darwin"], arch: ["arm64"] },
      resources: {
        startupMs: 1000,
        requestMs: 1000,
        shutdownMs: 500,
        maxOutputBytes: 65_536,
        maxConcurrent: 1,
      },
    },
  });
  return { bytes, declaration, digest: bytesDigest(bytes) };
}
