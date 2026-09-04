const { resolve } = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

if (!parentPort) throw new Error('The Zotero document worker must run in a worker thread.');

const buildDir = resolve(workerData.buildDir);
const canvas = require(resolve(buildDir, '../node_modules/@napi-rs/canvas'));

globalThis.DOMMatrix = canvas.DOMMatrix;
globalThis.ImageData = canvas.ImageData;
globalThis.Path2D = canvas.Path2D;
globalThis.PDFJSDev = {
	eval() {
		return null;
	},
	test(expression) {
		const enabled = new Set(['GENERIC', 'LIB']);
		return expression.split('||').some((part) => {
			const value = part.trim();
			return value.startsWith('!') ? !enabled.has(value.slice(1).trim()) : enabled.has(value);
		});
	},
};

globalThis.self = globalThis;
globalThis.onmessage = null;
globalThis.postMessage = (message, transferList = []) => {
	parentPort.postMessage(message, transferList);
};

const workerBundlePath = resolve(buildDir, 'worker.js');
// Load the generated worker as an ordinary CommonJS module. Evaluating it with
// node:vm breaks document-worker's intentional dynamic import of Node-only
// rendering dependencies (`canvas`), because `new Function(... import())`
// created inside a vm script has no module import callback.
const workerApi = require(workerBundlePath);

async function renderAreas(message) {
	let renderablePdf;
	try {
		renderablePdf = await workerApi.pdf.openRenderablePdfDocument(message.data.buf, message.data.password, (assetPath) =>
			globalThis.self.query('FetchData', assetPath),
		);
		for (const area of message.data.areas) {
			try {
				const canvas = await workerApi.pdf.renderArea(renderablePdf.pdfDocument, area.pageIndex, area.rect, {
					scale: message.data.scale,
				});
				if (!canvas) {
					parentPort.postMessage({ progressID: message.id, data: { id: area.id, buf: null } });
					continue;
				}
				const buf = await workerApi.pdf.canvasToPNGArrayBuffer(canvas);
				parentPort.postMessage({ progressID: message.id, data: { id: area.id, buf } }, [buf]);
			} catch (error) {
				parentPort.postMessage({ progressID: message.id, data: { id: area.id, error: serializeError(error) } });
			}
		}
		await renderablePdf.cleanup();
		renderablePdf = null;
		parentPort.postMessage({ responseID: message.id, data: { count: message.data.areas.length } });
	} catch (error) {
		parentPort.postMessage({ responseID: message.id, error: serializeError(error) });
	} finally {
		if (renderablePdf) {
			try {
				await renderablePdf.cleanup();
			} catch {
				// Preserve the original render failure; the container will be recycled if the worker itself exits.
			}
		}
	}
}

parentPort.on('message', (message) => {
	if (message?.action === 'newsence.renderPdfAreas') {
		void renderAreas(message);
		return;
	}
	if (typeof globalThis.self.onmessage !== 'function') return;
	Promise.resolve(globalThis.self.onmessage({ data: message })).catch((error) => {
		parentPort.postMessage({ responseID: message.id, error: serializeError(error) });
	});
});

parentPort.postMessage({ ready: true });

function serializeError(error) {
	if (error instanceof Error) return { message: error.message, name: error.name, stack: error.stack };
	return { message: String(error), name: 'Error' };
}
