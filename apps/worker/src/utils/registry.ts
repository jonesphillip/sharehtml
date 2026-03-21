export function getRegistry(env: Env) {
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("global"));
}
