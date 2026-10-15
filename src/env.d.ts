import type { InferDurableNamespaces, InferEnv, InferMainModule, UnwrapConfig } from 'cf/config';
import type { coreWorker } from '../cloudflare.config.ts';
import type { StoredPdf } from './contracts/acquired-resource';

type CoreConfig = UnwrapConfig<typeof coreWorker>;
type CoreMain = InferMainModule<CoreConfig>;
type CoreBindings = InferEnv<CoreConfig>;

declare global {
	/** Inferred from Core's config, not `Cloudflare.Env`: Web's program also type-checks this code. */
	type CoreEnv = Omit<CoreBindings, 'APP' | 'RESOURCE_VECTORS'> & {
		APP: CoreBindings['APP'] &
			Rpc.Provider<{
				completeResourceSave(resourceId: string, saveTarget: unknown): Promise<void>;
				verifyStoredBlobProcessing(objectId: string, workflowId: string): Promise<StoredPdf | null>;
			}>;
		/** The config types every Vectorize binding as the legacy index; this one is a V2 index. */
		RESOURCE_VECTORS: Vectorize;
	};
	/** `ctx.exports` for Core's own classes; Durable Objects are also namespaces. */
	type CoreExports = {
		[K in keyof CoreMain]: LoopbackForExport<CoreMain[K]> &
			(K extends InferDurableNamespaces<CoreConfig>
				? CoreMain[K] extends (new (...args: never[]) => infer Instance extends Rpc.DurableObjectBranded)
					? DurableObjectNamespace<Instance>
					: never
				: unknown);
	};
}
