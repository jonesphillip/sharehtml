import type { RegistryDO } from "./durable-objects/registry.js";
import type { DocumentDO } from "./durable-objects/document.js";

export interface Env {
  DOCUMENTS_BUCKET: R2Bucket;
  DOCUMENT_DO: DurableObjectNamespace<DocumentDO>;
  REGISTRY_DO: DurableObjectNamespace<RegistryDO>;
  ASSETS: Fetcher;
  AUTH_MODE: "access" | "none";
  ACCESS_AUD?: string;
  ACCESS_TEAM?: string;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    apiUser: string;
  };
};
