import { z } from 'zod';
import { errorMessage } from '../services/response';
import { withCoreDb } from '../store/db';
import { syncSearchDocuments } from './search-index';

const ResourceSearchSyncMessageSchema = z.object({ resourceId: z.uuid().toLowerCase() });

/**
 * Write or delete each queued Resource's vectors, acknowledging only a snapshot that is still current.
 */
export async function consumeSearchSyncBatch(env: CoreEnv, batch: MessageBatch<unknown>): Promise<void> {
	const pending = new Map<string, Message<unknown>[]>();
	for (const message of batch.messages) {
		const input = ResourceSearchSyncMessageSchema.safeParse(message.body);
		if (!input.success) {
			console.warn({ tag: 'CORPUS_VECTORS', msg: 'Invalid resource sync message', message_id: message.id });
			message.ack();
			continue;
		}
		const messages = pending.get(input.data.resourceId) ?? [];
		messages.push(message);
		pending.set(input.data.resourceId, messages);
	}
	if (!pending.size) return;
	const retry = (resourceId: string, error: unknown) => {
		const messages = pending.get(resourceId)!;
		console.error({
			tag: 'CORPUS_VECTORS',
			msg: 'Resource sync failed',
			resource_id: resourceId,
			attempt: Math.max(...messages.map((message) => message.attempts)),
			error: errorMessage(error),
		});
		for (const message of messages) message.retry();
	};
	const ids = [...pending.keys()];
	try {
		// One embedding call covers the batch, so a failure retries every Resource in it. Another consumer may have
		// written a newer snapshot first: retry from Postgres instead of acknowledging a stale write or deletion.
		const { changed } = await withCoreDb(env, (db) => syncSearchDocuments(env, db, ids));
		for (const resourceId of ids) {
			if (changed.includes(resourceId)) retry(resourceId, new Error('Resource changed during search sync'));
			else for (const message of pending.get(resourceId)!) message.ack();
		}
	} catch (error) {
		// A message already settled ignores a second ack or retry.
		for (const resourceId of ids) retry(resourceId, error);
	}
}
