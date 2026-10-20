import type { Config, Context } from '@netlify/functions';
import { getServerDeps } from '../../src/server/deps.ts';
import { handleGeocode } from '../../src/server/handlers.ts';
import { API_PATHS } from '../../src/shared/api/contracts.ts';

export default (req: Request, context: Context) => handleGeocode(req, getServerDeps(), context.ip);

export const config: Config = { path: API_PATHS.geocode };
