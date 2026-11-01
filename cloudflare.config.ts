import { bindings, defineConfig, defineContainer, defineWorker, exports, triggers } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Staging resources, created beside production's (web-tanstack README, "Staging").
const STAGING_HYPERDRIVE_ID = '';

/** `--mode staging` names every account-wide resource `<production>-staging`; any other mode is production. */
const named = (mode: string | undefined, name: string) => (mode === 'staging' ? `${name}-staging` : name);

/** PDF parsers stream uploaded PDFs from R2; their models and scratch disks are intentionally ephemeral. */
const zoteroSdt = defineContainer(({ mode }) => ({
	name: named(mode, 'newsence-core-zoterosdt'),
	schedulingPolicy: 'durable-object',
	/** Surfaces the document-worker's stdout/stderr (queue saturation, parser failures) in Workers Logs. */
	observability: { logs: { enabled: true } },
	images: {
		'zotero-sdt': { dockerfile: './containers/zotero-sdt/Dockerfile' },
	},
}));

export const coreWorker = defineWorker(({ mode }) => ({
	name: named(mode, 'newsence-core'),
	compatibilityDate: '2026-10-01',
	entrypoint,
	workersDev: false,
	/**
	 * A vectors backfill of 500k resources runs 10k pages, each embedding and
	 * writing its Resources' vectors. Workflows count subrequests per
	 * instance, so keep headroom.
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
		// Due monitors, derivations and stalled requests (every 5 minutes)
		triggers.scheduled({ schedule: '*/5 * * * *' }),
		/** The corpus vectors are a derived index; this Queue keeps them off canonical Resource Workflows. */
		triggers.queue({
			name: named(mode, 'resource-search-sync'),
			maxBatchSize: 10,
			maxBatchTimeout: 5,
			maxRetries: 3,
			/** A Resource that keeps changing mid-sync gets time to settle before its retries run out. */
			retryDelay: 30,
			/** Exhausted syncs stay inspectable and replayable instead of being dropped. */
			deadLetterQueue: named(mode, 'resource-search-sync-dlq'),
		}),
	],
	/**
	 * `AI_GATEWAY_ENVIRONMENT` — trusted deployment label attached to Gateway logs.
	 * System inference is pinned to the pre-created `core-ingest` Gateway at its
	 * domain call sites; local scripts override this label to `development`.
	 */
	env: {
		AI_GATEWAY_ENVIRONMENT: bindings.text(mode === 'staging' ? 'staging' : 'production'),
		/** Enables Twitter ingestion enrichment. */
		KAITO_API_KEY: bindings.secret(),
		/** Enables YouTube transcript/channel enrichment. */
		YOUTUBE_API_KEY: bindings.secret(),
		/** Enables exact paper metadata enrichment. */
		OPENALEX_API_KEY: bindings.secret(),
		/** Finds the named entities each original is about. */
		FASTINO_API_KEY: bindings.secret(),
		AI: bindings.ai({}),
		/** Hyperdrive — PlanetScale PostgreSQL connection pooling. */
		HYPERDRIVE: bindings.hyperdrive({
			id: mode === 'staging' ? STAGING_HYPERDRIVE_ID : '5d7b16cf287e4dcc8b36d43461ccbf5c',
		}),
		/** Cloudflare Images — hosted resource previews and creator avatars. */
		IMAGES: bindings.images({}),
		/**
		 * Shared resource blob storage. The app worker owns uploaded blob
		 * lifecycle. Core reads uploaded PDFs for local extraction and, only
		 * with a Web-issued grant after a hard defect, temporary provider upload.
		 */
		R2: bindings.r2({ name: named(mode, 'newsence') }),
		RESOURCE_SEARCH_SYNC_QUEUE: bindings.queue({ name: named(mode, 'resource-search-sync') }),
		/** The public corpus as bge-m3 vectors: one per Resource (`<id>:d`) plus its text's chunks (`<id>:<n>`). */
		CORPUS_VECTORS: bindings.vectorize({ name: named(mode, 'newsence-corpus-vectors-v1') }),
		APP: bindings.worker({
			worker: named(mode, 'newsence-web-tanstack'),
			exportName: 'DomainRpc',
		}),
	},
	exports: {
		/** Code reaches these Durable Objects and Workflows through `exports` from `cloudflare:workers`. */
		ZoteroSdt: exports.durableObject({ storage: 'sqlite', container: zoteroSdt }),
		YouTubeCaptionFetcher: exports.durableObject({ storage: 'sqlite' }),
		PageFetcher: exports.durableObject({ storage: 'sqlite' }),
		ResourceProcessingV2Workflow: exports.workflow({
			name: named(mode, 'newsence-resource-processing-v2'),
		}),
		/** A summary or entity extraction the import that wrote its original failed or never settled. */
		ResourceDerivationWorkflow: exports.workflow({
			name: named(mode, 'newsence-resource-derivation'),
			defaultRetention: { successRetention: '1 day', errorRetention: '7 days' },
		}),
		ResourceTranslationV2Workflow: exports.workflow({
			name: named(mode, 'newsence-resource-translation-v2'),
			defaultRetention: { successRetention: '7 days', errorRetention: '7 days' },
		}),
		/** Writes every corpus Resource's vectors, a page per step. */
		CorpusVectorsBackfillWorkflow: exports.workflow({
			name: named(mode, 'newsence-corpus-vectors-backfill'),
			limits: { steps: 25000 },
		}),
	},
}));

export default defineConfig({ worker: coreWorker, containers: [zoteroSdt] });
