import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	absolutizeUrl,
	fetchSourceyPage,
	loadAllSourceyDocs,
	parseLlmsFullText,
	retrieveSourceyContext,
	searchSourceyDocs,
} from '../dist/nodes/Sourcey/sourcey/retrieval.js';

const SITE_URL = 'https://docs.example.com/reference';

describe('Sourcey retrieval helpers', () => {
	it('parses llms-full page boundaries', () => {
		const pages = parseLlmsFullText(`# Example Docs

## Guides

### Search Guide

Path: \`/reference/guides/search.html\`

Use Sourcey search from automations.

### API Reference

Path: \`/reference/api/\`

Endpoints and models.
`);

		assert.equal(pages['reference/guides/search'].title, 'Search Guide');
		assert.equal(pages['reference/api'].content, 'Endpoints and models.');
	});

	it('retrieves packed context with citations for agent workflows', async () => {
		const httpGet = fixtureHttpGet({
			'/reference/search-index.json': JSON.stringify([
				{
					title: 'Search Guide',
					content: 'Use Sourcey search-index.json and llms-full.txt in n8n workflows.',
					url: '/reference/guides/search.html#quickstart',
					tab: 'Guides',
					category: 'Pages',
				},
			]),
			'/reference/llms-full.txt': `### Search Guide

Path: \`/reference/guides/search.html\`

Use Sourcey search-index.json and llms-full.txt to answer docs questions with citations.
`,
		});

		const result = await retrieveSourceyContext({
			httpGet,
			siteUrl: SITE_URL,
			query: 'sourcey n8n workflows',
			topK: 3,
			maxContextChars: 2000,
		});

		assert.equal(result.status, 'ok');
		assert.match(result.context, /Search Guide/);
		assert.match(result.context, /Source: https:\/\/docs\.example\.com\/reference\/guides\/search\.html/);
		assert.deepEqual(result.citations[0].title, 'Search Guide');
	});

	it('searches without duplicating a base path in absolute URLs', async () => {
		const results = await searchSourceyDocs({
			httpGet: fixtureHttpGet({
				'/reference/search-index.json': JSON.stringify([
					{
						title: 'MCP Docs',
						content: 'Document MCP servers with Sourcey.',
						url: '/reference/guides/mcp.html',
						tab: 'Guides',
						category: 'Pages',
					},
				]),
			}),
			siteUrl: SITE_URL,
			query: 'mcp docs',
			topK: 1,
		});

		assert.equal(results[0].path, 'guides/mcp');
		assert.equal(results[0].url, 'https://docs.example.com/reference/guides/mcp.html');
		assert.equal(
			absolutizeUrl('/reference/guides/mcp.html', SITE_URL),
			'https://docs.example.com/reference/guides/mcp.html',
		);
	});

	it('fetches a page from llms-full or falls back to HTML', async () => {
		const fromLlms = await fetchSourceyPage({
			httpGet: fixtureHttpGet({
				'/reference/llms-full.txt': `### Search Guide

Path: \`/reference/guides/search.html\`

Loaded from llms-full.
`,
			}),
			siteUrl: SITE_URL,
			pathOrUrl: 'guides/search.html',
		});

		assert.equal(fromLlms.pageContent, 'Loaded from llms-full.');

		const fromHtml = await fetchSourceyPage({
			httpGet: fixtureHttpGet({
				'/reference/llms-full.txt': notFound(),
				'/reference/guides/html.html': '<html><head><title>HTML Guide</title></head><body><h1>HTML Guide</h1><p>Fallback text.</p></body></html>',
			}),
			siteUrl: SITE_URL,
			pathOrUrl: 'guides/html.html',
		});

		assert.equal(fromHtml.title, 'HTML Guide');
		assert.equal(fromHtml.pageContent, 'HTML Guide Fallback text.');
	});

	it('loads pages from sitemap when llms-full is missing', async () => {
		const results = await loadAllSourceyDocs({
			httpGet: fixtureHttpGet({
				'/reference/llms-full.txt': notFound(),
				'/reference/sitemap.xml': `<urlset>
	<url><loc>https://docs.example.com/reference/guides/sitemap.html</loc></url>
</urlset>`,
				'/reference/guides/sitemap.html': '<html><head><title>Sitemap Guide</title></head><body><h1>Sitemap Guide</h1><p>Loaded from sitemap fallback.</p></body></html>',
			}),
			siteUrl: SITE_URL,
			outputMode: 'page',
			includeContent: true,
			maxPages: 10,
			chunkSize: 4000,
		});

		assert.equal(results.length, 1);
		assert.equal(results[0].title, 'Sitemap Guide');
		assert.equal(results[0].path, 'guides/sitemap');
		assert.equal(results[0].source, 'https://docs.example.com/reference/guides/sitemap.html');
		assert.equal(results[0].metadata.source, 'https://docs.example.com/reference/guides/sitemap.html');
		assert.equal(results[0].pageContent, 'Sitemap Guide Loaded from sitemap fallback.');
	});

	it('limits sitemap fallback page fetches before hydration', async () => {
		const fetched = [];
		const results = await loadAllSourceyDocs({
			httpGet: async (url, responseFormat) => {
				const path = new URL(url).pathname;
				fetched.push(path);
				if (path === '/reference/llms-full.txt') throw notFound();
				if (path === '/reference/sitemap.xml') {
					return `<urlset>
	<url><loc>https://docs.example.com/reference/guides/one.html</loc></url>
	<url><loc>https://docs.example.com/reference/guides/two.html</loc></url>
</urlset>`;
				}
				if (path === '/reference/guides/one.html') {
					return '<html><head><title>One</title></head><body><p>First page.</p></body></html>';
				}
				if (responseFormat === 'json') return {};
				throw new Error(`unexpected fetch: ${path}`);
			},
			siteUrl: SITE_URL,
			outputMode: 'page',
			includeContent: true,
			maxPages: 1,
			chunkSize: 4000,
		});

		assert.equal(results.length, 1);
		assert.equal(fetched.includes('/reference/guides/two.html'), false);
	});

	it('loads all docs as chunk items for vector-store ingestion', async () => {
		const results = await loadAllSourceyDocs({
			httpGet: fixtureHttpGet({
				'/reference/llms-full.txt': `### Big Guide

Path: \`/reference/guides/big.html\`

${'Sourcey ingestion content. '.repeat(20)}
`,
			}),
			siteUrl: SITE_URL,
			outputMode: 'chunk',
			includeContent: true,
			maxPages: 10,
			chunkSize: 120,
		});

		assert.equal(results.length > 1, true);
		assert.equal(results[0].title, 'Big Guide');
		assert.equal(results[0].path, 'guides/big');
		assert.equal(results[0].metadata.chunk_index, 0);
	});
});

function fixtureHttpGet(routes) {
	return async (url, responseFormat) => {
		const path = new URL(url).pathname;
		const value = routes[path];
		if (value instanceof Error) throw value;
		if (value === undefined) throw notFound();
		if (responseFormat === 'json') return JSON.parse(value);
		return value;
	};
}

function notFound() {
	return new Error('404 Not Found');
}
