import { z } from 'zod';
import { withCoreDb } from '../store/db';
import { loadCorpusDocuments, syncCorpusItem } from './search-index';

const ResourceSearchSyncMessageSchema = z.strictObject({
	resourceId: z.uuid().toLowerCase(),
});

/** Upload or delete each queued corpus Resource's search document, acknowledging only a snapshot that is still current. */
export async function consumeSearchSyncBatch(env: CoreEnv, batch: MessageBatch<unknown>): Promise<void> {
	const pending = new Map<string, Message<unknown>[]>();
	for (const message of batch.messages) {
		const input = ResourceSearchSyncMessageSchema.safeParse(message.body);
		if (!input.success) {
			console.warn({ tag: 'AI_SEARCH', msg: 'Invalid resource sync message', message_id: message.id });
			message.ack();
			continue;
		}
		const messages = pending.get(input.data.resourceId) ?? [];
		messages.push(message);
		pending.set(input.data.resourceId, messages);
	}
	if (!pending.size) return;
	try {
		await withCoreDb(env, async (db) => {
			const documents = await loadCorpusDocuments(db, [...pending.keys()]);
			const documentsById = new Map(documents.map((document) => [document.id, document]));
			for (const [resourceId, messages] of pending) {
				try {
					const document = documentsById.get(resourceId);
					await syncCorpusItem(env, resourceId, document);
					// Another consumer may have uploaded a newer snapshot first. Retry from
					// Postgres instead of acknowledging a stale upload or deletion.
					const [current] = await loadCorpusDocuments(db, [resourceId]);
					if (JSON.stringify(current) !== JSON.stringify(document)) throw new Error('Resource changed during search sync');
					for (const message of messages) message.ack();
				} catch (error) {
					console.error({
						tag: 'AI_SEARCH',
						msg: 'Resource sync failed',
						resource_id: resourceId,
						attempt: Math.max(...messages.map((message) => message.attempts)),
						error,
					});
					for (const message of messages) message.retry();
				}
			}
		});
	} catch (error) {
		// Only the batch load can throw here; each resource settles its own messages.
		console.error({ tag: 'AI_SEARCH', msg: 'Resource sync batch could not be loaded', error });
		for (const messages of pending.values()) {
			for (const message of messages) message.retry();
		}
	}
}
