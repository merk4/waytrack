import { API_PATHS } from '../shared/api/contracts.ts';
import { getServerDeps } from './deps.ts';
import { handleElevation, handleGenerate, handleGeocode, handleRoute } from './handlers.ts';

/**
 * Local development entry: dispatches /api/* to the same handlers the Netlify
 * functions use (see vite.config.ts). Not deployed.
 */
export function handleDevApi(req: Request, env: NodeJS.ProcessEnv, ip: string): Promise<Response> | undefined {
  const path = new URL(req.url).pathname;
  const deps = getServerDeps(env);
  if (path === API_PATHS.route) return handleRoute(req, deps, ip);
  if (path === API_PATHS.elevation) return handleElevation(req, deps, ip);
  if (path === API_PATHS.geocode) return handleGeocode(req, deps, ip);
  if (path === API_PATHS.generate) return handleGenerate(req, deps, ip);
  return undefined;
}
