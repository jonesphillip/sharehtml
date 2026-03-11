import Conf from "conf";

interface Config {
  workerUrl: string;
}

const config = new Conf<Config>({
  projectName: "sharehtml-cli",
  defaults: {
    workerUrl: "",
  },
});

export function getConfig(): Config {
  return {
    workerUrl: config.get("workerUrl"),
  };
}

export function setConfig(key: keyof Config, value: string): void {
  config.set(key, value);
}

export function isConfigured(): boolean {
  const c = getConfig();
  return Boolean(c.workerUrl);
}
