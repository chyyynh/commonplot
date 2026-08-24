export {};

declare global {
	type CoreEnv = Omit<CoreBindings, 'APP'> & {
		APP: CoreBindings['APP'] &
			Rpc.Provider<{
				completeResourceSave(resourceId: string, saveTarget: unknown): Promise<void>;
				markStoredBlobProcessingFailed(resourceId: string): Promise<boolean>;
			}>;
	};
}
