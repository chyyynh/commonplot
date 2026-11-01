import { exports } from 'cloudflare:workers';

/** Typed from Core's own config, so the Web program that type-checks Core's RPC sees Core's classes, not its own. */
export const coreExports = exports as unknown as CoreExports;

/** A Workflow instance's status; `absent` when it is missing, expired, or the control plane is unavailable. */
export async function workflowStatus<P>(workflow: Workflow<P>, id: string) {
	try {
		return (await (await workflow.get(id)).status()).status;
	} catch {
		return 'absent' as const;
	}
}

/** Creates the instances in batches of 100, the most createBatch takes. */
export async function createInstances<P>(workflow: Workflow<P>, instances: readonly WorkflowInstanceCreateOptions<P>[]) {
	for (let offset = 0; offset < instances.length; offset += 100) await workflow.createBatch(instances.slice(offset, offset + 100));
}
