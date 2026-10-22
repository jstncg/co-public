const legacyPrefix = "COMPANION_";

export function legacyCoEnvName(name: `CO_${string}`): string {
  return `${legacyPrefix}${name.slice(3)}`;
}

/** Co names are canonical; the former prefix remains a read-only compatibility input. */
export function coEnv(name: `CO_${string}`, environment_: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment_[name] ?? environment_[legacyCoEnvName(name)];
}
