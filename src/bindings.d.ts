import type { OfficialPublicationsRpc } from '@app-domain/official-publications-contracts';
import type { PaperResourceRpc } from '@app-domain/paper-resource-contracts';
import type { ResourceMediaRpc } from '@app-domain/resource-media-contracts';

declare global {
	type CoreEnv = Omit<BaseCoreEnv, 'DOMAIN'> & {
		DOMAIN: BaseCoreEnv['DOMAIN'] & OfficialPublicationsRpc & PaperResourceRpc & ResourceMediaRpc;
		OPENALEX_API_KEY?: string;
	};
}
