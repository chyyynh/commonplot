import { bindings, defineConfig, defineContainer, defineWorker, exports, triggers } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

/** PDF parsers stream uploaded PDFs from R2; their models and scratch disks are intentionally ephemeral. */
const zoteroSdt = defineContainer({
	name: 'newsence-core-zoterosdt',
	schedulingPolicy: 'durable-object',
	/** Surfaces the document-worker's stdout/stderr (queue saturation, parser failures) in Workers Logs. */
	observability: { logs: { enabled: true } },
	images: {
		'zotero-sdt': { dockerfile: './containers/zotero-sdt/Dockerfile' },
	},
});

export const coreWorker = defineWorker({
	name: 'newsence-core',
	compatibilityDate: '2026-10-01',
	entrypoint,
	workersDev: false,
	/**
	 * A rebuild of 500k resources enqueues 10k sync batches, then lists and
	 * prunes 10k search item pages; the sync queue does the uploads.
	 * Workflows count subrequests per instance, so keep headroom.
	 */
	limits: {
		cpuMs: 180000,
		subrequests: 5000000,
	},
	observability: {
		enabled: true,
		headSamplingRate: 1,
		logs: {
			enabled: true,
			headSamplingRate: 1,
			persist: true,
			invocationLogs: true,
		},
		traces: {
			enabled: true,
			persist: true,
			headSamplingRate: 0.05,
		},
	},
	triggers: [
		// RSS monitor, incl. YouTube channel feeds (every 5 minutes)
		triggers.scheduled({ schedule: '*/5 * * * *' }),
		// Twitter monitor (every 6 hours)
		triggers.scheduled({ schedule: '0 */6 * * *' }),
		/** AI Search is a derived index; this Queue keeps it off canonical Resource Workflows. */
		triggers.queue({
			name: 'resource-search-sync',
			maxBatchSize: 10,
			maxBatchTimeout: 5,
			maxRetries: 3,
			/** A Resource that keeps changing mid-sync gets time to settle before its retries run out. */
			retryDelay: 30,
			/** Exhausted syncs stay inspectable and replayable instead of being dropped. */
			deadLetterQueue: 'resource-search-sync-dlq',
		}),
	],
	/**
	 * `AI_GATEWAY_ENVIRONMENT` — trusted deployment label attached to Gateway logs.
	 * System inference is pinned to the pre-created `core-ingest` Gateway at its
	 * domain call sites; local scripts override this label to `development`.
	 */
	env: {
		AI_GATEWAY_ENVIRONMENT: bindings.text('production'),
		/** Enables Twitter ingestion enrichment. */
		KAITO_API_KEY: bindings.secret(),
		/** Enables YouTube transcript/channel enrichment. */
		YOUTUBE_API_KEY: bindings.secret(),
		/** Enables exact paper metadata enrichment. */
		OPENALEX_API_KEY: bindings.secret(),
		/** Finds the named entities each original is about. */
		FASTINO_API_KEY: bindings.secret(),
		AI: bindings.ai({}),
		AI_SEARCH: bindings.aiSearch({
			name: 'newsence-corpus-v7',
			dev: { remote: true },
		}),
		/** Hyperdrive — PlanetScale PostgreSQL connection pooling. */
		HYPERDRIVE: bindings.hyperdrive({
			id: '5d7b16cf287e4dcc8b36d43461ccbf5c',
		}),
		/** Cloudflare Images — hosted resource previews and creator avatars. */
		IMAGES: bindings.images({}),
		/**
		 * Shared resource blob storage. The app worker owns uploaded blob
		 * lifecycle. Core reads uploaded PDFs for local extraction and, only
		 * with a Web-issued grant after a hard defect, temporary provider upload.
		 */
		R2: bindings.r2({ name: 'newsence' }),
		RESOURCE_SEARCH_SYNC_QUEUE: bindings.queue({ name: 'resource-search-sync' }),
		/** One bge-m3 vector per searchable corpus Resource, written by the search sync queue, for recommendations. */
		RESOURCE_VECTORS: bindings.vectorize({ name: 'newsence-resources-v1' }),
		APP: bindings.worker({
			worker: 'newsence-web-tanstack',
			exportName: 'DomainRpc',
		}),
	},
	exports: {
		/** Code reaches these Durable Objects and Workflows through `exports` from `cloudflare:workers`. */
		ZoteroSdt: exports.durableObject({ storage: 'sqlite', container: zoteroSdt }),
		YouTubeCaptionFetcher: exports.durableObject({ storage: 'sqlite' }),
		ResourceProcessingV2Workflow: exports.workflow({
			name: 'newsence-resource-processing-v2',
		}),
		/** A summary or entity extraction the import that wrote its original failed or never settled. */
		ResourceDerivationWorkflow: exports.workflow({
			name: 'newsence-resource-derivation',
			defaultRetention: { successRetention: '1 day', errorRetention: '7 days' },
		}),
		ResourceTranslationV2Workflow: exports.workflow({
			name: 'newsence-resource-translation-v2',
			defaultRetention: { successRetention: '7 days', errorRetention: '7 days' },
		}),
		/** 500k resources need 10k enqueue steps before pruning and readiness checks. */
		SearchIndexRebuildWorkflow: exports.workflow({
			name: 'newsence-search-index-rebuild',
			limits: { steps: 25000 },
		}),
	},
});

export default defineConfig({ worker: coreWorker, containers: [zoteroSdt] });
