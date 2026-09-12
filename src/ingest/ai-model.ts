export const CORE_TEXT_MODEL = '@cf/zai-org/glm-5.3-flash';

export const CORE_STRUCTURED_MODEL_SETTINGS = {
	chat_template_kwargs: { enable_thinking: false, clear_thinking: true },
};

export function coreGatewayOptions(env: Pick<CoreEnv, 'AI_GATEWAY_ENVIRONMENT'>, metadata: NonNullable<GatewayOptions['metadata']>) {
	return {
		gateway: {
			id: 'core-ingest',
			collectLog: true,
			retries: { maxAttempts: 1 },
			metadata: { ...metadata, environment: env.AI_GATEWAY_ENVIRONMENT },
		} satisfies GatewayOptions,
		extraHeaders: { 'cf-aig-collect-log-payload': 'false' },
	};
}
