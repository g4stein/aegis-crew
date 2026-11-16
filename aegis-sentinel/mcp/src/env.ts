// Environment preparation for the chain-state server.
//
// MCP hosts expand "${VAR}" in a server's env block. When VAR is not set, some hosts pass the
// literal text "${VAR}" instead. dotenv never overrides an existing variable, so that literal
// would silently win over the real value in .env (for example AEGIS_SIGNER_KEY).
// prepareEnv treats any value that is still an unexpanded placeholder as unset, then loads .env.
import { config as loadDotenv } from 'dotenv';

export const UNEXPANDED_PLACEHOLDER = /^\$\{.*\}$/;

/** Names of variables whose value is an unexpanded `${...}` placeholder. Pure. */
export function unexpandedPlaceholders(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((k) => {
      const v = env[k];
      return typeof v === 'string' && UNEXPANDED_PLACEHOLDER.test(v);
    })
    .sort();
}

export interface PreparedEnv {
  /** Variables removed because they held a placeholder (names only, never values). */
  readonly unset: readonly string[];
  /** Whether a .env file was found and read. */
  readonly dotenvLoaded: boolean;
}

/**
 * Removes placeholder values from `env`, then loads `dotenvPath` into it. Real values already
 * in `env` still take precedence over .env, as before. Mutates `env` (normally process.env).
 */
export function prepareEnv(env: Record<string, string | undefined>, dotenvPath: string): PreparedEnv {
  const unset = unexpandedPlaceholders(env);
  for (const k of unset) delete env[k];
  const r = loadDotenv({ path: dotenvPath, quiet: true, processEnv: env as Record<string, string> });
  return { unset, dotenvLoaded: r.error === undefined };
}
