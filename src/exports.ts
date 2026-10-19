import { exports } from 'cloudflare:workers';

/** Typed from Core's own config, so the Web program that type-checks Core's RPC sees Core's classes, not its own. */
export const coreExports = exports as unknown as CoreExports;
