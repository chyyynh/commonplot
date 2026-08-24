export {};

declare global {
	type CoreEnv = Omit<CoreBindings, 'DOMAIN'> & {
		DOMAIN: CoreBindings['DOMAIN'] &
			Rpc.Provider<import('../../../web-tanstack/src/server/domain/resource-persistence-contracts').ResourcePersistenceRpc>;
	};
}
