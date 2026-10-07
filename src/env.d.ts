import type { InferDurableNamespaces, InferEnv, InferMainModule, UnwrapConfig } from 'cf/config';
import type { coreWorker } from '../cloudflare.config.ts';
import type { StoredPdf } from './contracts/acquired-resource';
import type { ProgressReport } from './workflows/progress';

type CoreConfig = UnwrapConfig<typeof coreWorker>;
type CoreMain = InferMainModule<CoreConfig>;
type CoreBindings = InferEnv<CoreConfig>;

declare global {
	/** Inferred from Core's config, not `Cloudflare.Env`: Web's program also type-checks this code. */
	type CoreEnv = Omit<CoreBindings, 'APP'> & {
		APP: CoreBindings['APP'] &
			Rpc.Provider<{
				completeResourceSave(resourceId: string, saveTarget: unknown): Promise<void>;
				verifyStoredBlobProcessing(objectId: string, workflowId: string): Promise<StoredPdf | null>;
				registerResourceProgressTask(input: {
					taskId: string;
					kind: 'processing' | 'translation';
					resourceId?: string;
					parentTaskId?: string;
					restart?: true;
				}): Promise<boolean>;
				reportResourceProgress(input: ProgressReport): Promise<boolean>;
				startResourceProgressTask(taskId: string, stage: NonNullable<ProgressReport['stage']>): Promise<boolean>;
				sealResourceProgressTask(taskId: string, errorCode?: string): Promise<boolean>;
			}>;
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
