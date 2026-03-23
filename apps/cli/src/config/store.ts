import Conf from "conf";

interface Config {
  workerUrl: string;
  documentMappings: Record<string, string>;
}

const config = new Conf<Config>({
  projectName: "sharehtml-cli",
  defaults: {
    workerUrl: "",
    documentMappings: {},
  },
});

export function getConfig(): Config {
  return {
    workerUrl: config.get("workerUrl"),
    documentMappings: config.get("documentMappings") || {},
  };
}

export function setConfig(key: keyof Config, value: string): void {
  config.set(key, value);
}

export function isConfigured(): boolean {
  const c = getConfig();
  return Boolean(c.workerUrl);
}

export function getDocumentMapping(filePath: string): string | undefined {
  return config.get("documentMappings")?.[filePath];
}

export function setDocumentMapping(filePath: string, documentId: string): void {
  const currentMappings = config.get("documentMappings") || {};
  config.set("documentMappings", {
    ...currentMappings,
    [filePath]: documentId,
  });
}

export function removeDocumentMapping(filePath: string): void {
  const currentMappings = { ...(config.get("documentMappings") || {}) };
  delete currentMappings[filePath];
  config.set("documentMappings", currentMappings);
}
