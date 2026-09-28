import type { ProgressReport } from './workflows/progress';

declare global {
	type CoreEnv = Omit<CoreBindings, 'APP'> & {
		APP: CoreBindings['APP'] &
			Rpc.Provider<{
				completeResourceSave(resourceId: string, saveTarget: unknown): Promise<void>;
				verifyStoredBlobProcessing(resourceId: string, workflowId: string): Promise<boolean>;
				registerResourceProgressTask(input: {
					taskId: string;
					kind: 'processing' | 'translation';
					resourceId?: string;
					parentTaskId?: string;
				}): Promise<boolean>;
				reportResourceProgress(input: ProgressReport): Promise<boolean>;
				startResourceProgressTask(taskId: string, stage: NonNullable<ProgressReport['stage']>): Promise<boolean>;
				sealResourceProgressTask(taskId: string, errorCode?: string): Promise<boolean>;
			}>;
	};
}
