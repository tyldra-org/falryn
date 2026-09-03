const STANDALONE_DECLARATION = /^(?:Standalone|Planning relationship: Standalone-v1\.)$/;

export function declaresStandalone(body: string): boolean {
  for (const line of body.split("\n")) {
    const plain = line.replaceAll("**", "").replaceAll("`", "").trim();
    const declaration = plain.replace(/^[-*]\s+/, "");
    if (STANDALONE_DECLARATION.test(declaration)) {
      return true;
    }
  }
  return false;
}
