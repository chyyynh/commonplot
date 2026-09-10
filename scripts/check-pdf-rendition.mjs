import assert from 'node:assert/strict';
import { hasPrivatePdfImages, matchesUploadedPdfRendition, withoutPrivatePdfImages } from '../src/ingest/pdf-rendition.ts';

const privateUrl = `/api/media/asset/pdf-crops/${'a'.repeat(64)}/12-p3-1234567890abcdef.png`;
const publicUrl = `/api/media/asset/public-pdf-crops/${'b'.repeat(64)}/${'a'.repeat(64)}/12-p3-1234567890abcdef.png`;
const source = `# Paper\n\nBefore ![private figure](${privateUrl}) after.\n\n![public figure](${publicUrl})\n\nFigure 1. Caption.\n\n\`![example](${privateUrl})\``;
const projected = withoutPrivatePdfImages(source);
assert.equal(projected, source.replace(`![private figure](${privateUrl})`, ''));
assert.equal(hasPrivatePdfImages(source), true);
assert.equal(hasPrivatePdfImages(projected), false);
assert.equal(withoutPrivatePdfImages(projected), projected, 'Public projection must be idempotent');
assert.equal(withoutPrivatePdfImages(`![Figure][crop]\n\n[crop]: ${privateUrl}`), '');
assert.equal(withoutPrivatePdfImages(`![Figure](https://newsence.app${privateUrl})\n\nCaption`), 'Caption');
assert.equal(withoutPrivatePdfImages('No images.\n\n$x=y$'), 'No images.\n\n$x=y$');
assert.equal(matchesUploadedPdfRendition(projected, source), true);
assert.equal(matchesUploadedPdfRendition(source, source), true);
assert.equal(matchesUploadedPdfRendition('A different published version and bibliography.', source), false);
console.info('PDF private/public rendition contract checks passed');
