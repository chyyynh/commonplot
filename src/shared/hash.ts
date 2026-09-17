import { Buffer } from 'node:buffer';

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return Buffer.from(digest).toString('hex');
}
