import type { ProgressReport } from './ingest/progress';

declare global {
	type CoreEnv = Omit<CoreBindings, 'APP'> & {
		APP: CoreBindings['APP'] &
			Rpc.Provider<{
				completeResourceSave(resourceId: string, saveTarget: unknown): Promise<void>;
				admitStoredBlobProcessing(input: { resourceId: string; retry?: boolean; paidPdfFallback?: { maxPages: number } }): Promise<string>;
				verifyStoredBlobProcessing(resourceId: string, workflowId: string): Promise<boolean>;
				registerResourceProgressTask(input: {
					taskId: string;
					kind: 'processing' | 'translation' | 'references' | 'index';
					resourceId?: string;
					parentTaskId?: string;
				}): Promise<boolean>;
				reportResourceProgress(input: ProgressReport): Promise<boolean>;
				startResourceProgressTask(taskId: string, stage: NonNullable<ProgressReport['stage']>): Promise<boolean>;
				sealResourceProgressTask(taskId: string, errorCode?: string): Promise<boolean>;
			}>;
	};
}
