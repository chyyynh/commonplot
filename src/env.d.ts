export {};

declare global {
	type CoreEnv = Omit<CoreBindings, 'APP'> & {
		APP: CoreBindings['APP'] & Rpc.Provider<import('@app-domain/resource-persistence-contracts').AppResourceLifecycleRpc>;
	};
}
