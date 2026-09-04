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
globalThis.postMessage = parentPort.postMessage.bind(parentPort);

// Load the generated worker as an ordinary CommonJS module. Evaluating it with
// node:vm breaks document-worker's intentional dynamic import of Node-only
// rendering dependencies (`canvas`), because `new Function(... import())`
// created inside a vm script has no module import callback.
require(resolve(buildDir, 'worker.js'));

parentPort.on('message', (message) => {
	globalThis.self.onmessage({ data: message }).catch((error) => {
		parentPort.postMessage({ responseID: message.id, error: error instanceof Error ? error : new Error(String(error)) });
	});
});

parentPort.postMessage({ ready: true });
