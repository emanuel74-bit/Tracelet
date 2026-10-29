/** The one NODE_ENV rule: only 'development' and 'test' are non-production. Unset or anything else is production. */
export function isDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return env === 'development' || env === 'test';
}

/** TRACELET_DISABLED=1 always wins and turns everything off. */
export function envDisabled(): boolean {
  return process.env.TRACELET_DISABLED === '1';
}

/** TRACELET_ENABLED=true|false -> boolean; anything else -> undefined. */
export function envEnabled(): boolean | undefined {
  const v = process.env.TRACELET_ENABLED;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}
