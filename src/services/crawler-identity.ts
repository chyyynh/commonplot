// How our fetches introduce themselves to sources that ask for a contact.
// The site and inbox stay on newsence.app until commonplot.co goes live.
export const CRAWLER_SITE = 'https://www.newsence.app';
export const CRAWLER_CONTACT = 'hello@newsence.app';

/** An identifying User-Agent: product token, site and contact inbox. */
export const crawlerUserAgent = (product = 'commonplot') => `${product}/1.0 (+${CRAWLER_SITE}; mailto:${CRAWLER_CONTACT})`;
