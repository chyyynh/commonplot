import { z } from 'zod';
import { errorMessage } from '../services/response';
import { withCoreDb } from '../store/db';
import { syncCorpusVectors } from './corpus-vectors';
import { syncResourceVectors } from './resource-vectors';
import { loadCorpusDocuments, syncCorpusItem } from './search-index';

const ResourceSearchSyncMessageSchema = z.object({ resourceId: z.uuid().toLowerCase() });

/**
 * Upload or delete each queued corpus Resource's search document and recommendation vector, acknowledging only a
 * snapshot that is still current.
 */
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
	const retry = (resourceId: string, messages: Message<unknown>[], error: unknown) => {
		console.error({
			tag: 'AI_SEARCH',
			msg: 'Resource sync failed',
			resource_id: resourceId,
			attempt: Math.max(...messages.map((message) => message.attempts)),
			error: errorMessage(error),
		});
		for (const message of messages) message.retry();
	};
	const retryAll = () => {
		for (const messages of pending.values()) {
			for (const message of messages) message.retry();
		}
	};
	try {
		await withCoreDb(env, async (db) => {
			const ids = [...pending.keys()];
			const documents = new Map((await loadCorpusDocuments(db, ids)).map((document) => [document.id, document]));
			// One embedding call covers the batch, so a failure retries every Resource in it.
			try {
				const current = [...documents.values()];
				const deleted = ids.filter((id) => !documents.has(id));
				await Promise.all([syncResourceVectors(env, current, deleted), syncCorpusVectors(env, current, deleted)]);
			} catch (error) {
				console.error({
					tag: 'RESOURCE_VECTORS',
					msg: 'Resource vector sync failed',
					resource_count: ids.length,
					error: errorMessage(error),
				});
				retryAll();
				return;
			}
			const synced: string[] = [];
			for (const [resourceId, messages] of pending) {
				try {
					await syncCorpusItem(env, resourceId, documents.get(resourceId));
					synced.push(resourceId);
				} catch (error) {
					retry(resourceId, messages, error);
				}
			}
			// Another consumer may have uploaded a newer snapshot first. Retry from
			// Postgres instead of acknowledging a stale upload or deletion.
			const current = new Map((await loadCorpusDocuments(db, synced)).map((document) => [document.id, document]));
			for (const resourceId of synced) {
				const messages = pending.get(resourceId)!;
				if (JSON.stringify(current.get(resourceId)) === JSON.stringify(documents.get(resourceId))) {
					for (const message of messages) message.ack();
				} else retry(resourceId, messages, new Error('Resource changed during search sync'));
			}
		});
	} catch (error) {
		// Only the batch loads can throw here; a message already settled ignores a second ack or retry.
		console.error({ tag: 'AI_SEARCH', msg: 'Resource sync batch could not be loaded', error: errorMessage(error) });
		retryAll();
	}
}
