import type { Config, Context } from '@netlify/functions';
import { getServerDeps } from '../../src/server/deps.ts';
import { handleGenerate } from '../../src/server/handlers.ts';

export default (req: Request, context: Context) => handleGenerate(req, getServerDeps(), context.ip);

// Literal on purpose: Netlify reads this statically and ignored an imported constant
// (deployed 2026-10-20: /api/* returned 404 while /.netlify/functions/* worked).
export const config: Config = { path: '/api/generate' };
