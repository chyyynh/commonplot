import { GlobalFonts } from '@napi-rs/canvas';

export * from '@napi-rs/canvas';

/** node-canvas compatibility used by Zotero's Node PDF rendering runtime. */
export function registerFont(filePath, options = {}) {
	if (!GlobalFonts.registerFromPath(filePath, options.family))
		throw new Error(`Unable to register PDF font ${options.family ?? ''}`.trim());
}
