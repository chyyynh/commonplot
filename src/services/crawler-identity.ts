// How our fetches introduce themselves to sources that ask for a contact.
export const CRAWLER_SITE = 'https://www.commonplot.co';
export const CRAWLER_CONTACT = 'hello@commonplot.co';

/** An identifying User-Agent: product token, site and contact inbox. */
export const crawlerUserAgent = (product = 'commonplot') => `${product}/1.0 (+${CRAWLER_SITE}; mailto:${CRAWLER_CONTACT})`;
