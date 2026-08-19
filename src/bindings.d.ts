import type { ResourceGraphRpc } from '@app-domain/resource-graph-contracts';
import type { ResourceMediaRpc } from '@app-domain/resource-media-contracts';

declare global {
	type CoreEnv = Omit<BaseCoreEnv, 'DOMAIN'> & {
		DOMAIN: BaseCoreEnv['DOMAIN'] & ResourceGraphRpc & ResourceMediaRpc;
	};
}
