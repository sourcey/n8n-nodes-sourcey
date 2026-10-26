export type ResponseFormat = 'json' | 'text';

export type HttpGet = (url: string, responseFormat: ResponseFormat) => Promise<unknown>;

export type LoadAllOutputMode = 'page' | 'chunk';

export interface SearchEntry {
	title: string;
	content: string;
	url: string;
	tab: string;
	category: string;
	featured?: boolean;
	method?: string;
	path?: string;
	/** The document's words, which a `documents.json` entry carries beside its summary. */
	searchText?: string;
	/** The document's own Markdown, which `documents.json` names for every page, operation and schema. */
	markdown?: string;
}

interface ParsedPage {
	title: string;
	path: string;
	outputPath: string;
	content: string;
	sourceUrl?: string;
}

interface Candidate {
	entry: SearchEntry;
	score: number;
	sourceUrl: string;
	matchedUrl: string;
	outputPath: string;
	anchor: string;
	markdownUrl?: string;
}

type PageMapLoader = () => Promise<Record<string, ParsedPage>>;

interface SourceyOptions {
	httpGet: HttpGet;
	siteUrl: string;
}

interface SearchOptions extends SourceyOptions {
	query: string;
	topK: number;
	tab?: string;
	category?: string;
}

interface RetrieveContextOptions extends SearchOptions {
	maxContextChars: number;
}

interface FetchPageOptions extends SourceyOptions {
	pathOrUrl: string;
}

interface LoadAllOptions extends SourceyOptions {
	outputMode: LoadAllOutputMode;
	includeContent: boolean;
	maxPages: number;
	chunkSize: number;
}

interface SourceyResult {
	status: 'ok' | 'weak_results' | 'no_results';
}

export class SourceyRetrievalError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'SourceyRetrievalError';
		this.code = code;
	}
}

export async function retrieveSourceyContext(options: RetrieveContextOptions): Promise<SourceyResult & Record<string, unknown>> {
	const candidates = await findCandidates(options);
	const selected = candidates.slice(0, clampPositiveInteger(options.topK, 5));
	if (!selected.length) {
		return {
			status: 'no_results',
			confidence: 'none',
			context: '',
			citations: [],
			documents: [],
			results: [],
		};
	}

	const documents = await hydrateCandidates(options, selected, memoized(() => loadPageMap(options)));
	const maxContextChars = clampPositiveInteger(options.maxContextChars, 12000);
	const contextParts: string[] = [];
	const citations = [];
	let usedCharacters = 0;

	for (const document of documents) {
		const title = String(document.title ?? '');
		const source = String(document.source ?? '');
		const path = String(document.path ?? '');
		const score = typeof document.score === 'number' ? document.score : 0;
		const pageContent = String(document.pageContent ?? '');
		const heading = `[${citations.length + 1}] ${title}\nSource: ${source}`;
		const available = maxContextChars - usedCharacters - heading.length - 2;
		if (available <= 0) break;

		const content = pageContent.slice(0, available).trim();
		if (!content) continue;

		contextParts.push(`${heading}\n${content}`);
		usedCharacters += heading.length + content.length + 2;
		citations.push({
			title,
			url: source,
			path,
			score,
		});
	}

	const topScore = selected[0]?.score ?? 0;
	const confidence = confidenceForScore(topScore);
	return {
		status: confidence === 'low' ? 'weak_results' : 'ok',
		confidence,
		context: contextParts.join('\n\n'),
		citations,
		documents,
		results: documents.map((document) => document.metadata),
	};
}

export async function searchSourceyDocs(options: SearchOptions): Promise<Record<string, unknown>[]> {
	const candidates = await findCandidates(options);
	return candidates.slice(0, clampPositiveInteger(options.topK, 5)).map((candidate) => {
		const entry = candidate.entry;
		return {
			status: 'ok',
			title: entry.title,
			path: candidate.outputPath,
			url: candidate.sourceUrl,
			matchedUrl: candidate.matchedUrl,
			excerpt: entry.content,
			category: entry.category,
			tab: entry.tab,
			score: candidate.score,
			method: entry.method,
			apiPath: entry.path,
			metadata: metadataForCandidate(options.siteUrl, candidate, entry.title),
		};
	});
}

export async function fetchSourceyPage(options: FetchPageOptions): Promise<Record<string, unknown>> {
	const siteUrl = normalizeSiteUrl(options.siteUrl);
	const requestedUrl = absolutizeUrl(options.pathOrUrl, siteUrl);
	const outputPath = relativeOutputPath(requestedUrl, siteUrl);
	const pageMap = await loadPageMap(options);
	const page = pageMap[outputPath];

	if (page) {
		const source = absolutizeUrl(page.path, siteUrl);
		return documentOutput({
			title: page.title,
			path: page.outputPath,
			pageContent: page.content,
			source,
			score: 0,
			siteUrl,
			tab: '',
			category: 'Pages',
		});
	}

	let lastError: unknown;
	for (const fallbackUrl of fallbackPageUrls(requestedUrl, siteUrl, outputPath)) {
		try {
			const html = await fetchText(options, fallbackUrl);
			const content = extractTextFromHtml(html);
			if (!content) {
				throw new SourceyRetrievalError('empty_page', `No content found at ${fallbackUrl}`);
			}

			return documentOutput({
				title: titleFromHtml(html) || outputPath || fallbackUrl,
				path: outputPath,
				pageContent: content,
				source: fallbackUrl,
				score: 0,
				siteUrl,
				tab: '',
				category: 'Pages',
			});
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError instanceof SourceyRetrievalError) throw lastError;
	throw new SourceyRetrievalError('fetch_failed', `Failed to fetch ${requestedUrl}`);
}

export async function loadAllSourceyDocs(options: LoadAllOptions): Promise<Record<string, unknown>[]> {
	const siteUrl = normalizeSiteUrl(options.siteUrl);
	const maxPages = clampPositiveInteger(options.maxPages, 100);
	const pageMap = await loadPageMap(options);
	let pages = Object.values(pageMap);

	if (!pages.length) {
		pages = await loadPagesFromSitemap(options, maxPages);
	}

	const outputs: Record<string, unknown>[] = [];
	for (const page of pages.slice(0, maxPages)) {
		const source = page.sourceUrl ?? absolutizeUrl(page.path, siteUrl);
		if (options.outputMode === 'chunk') {
			const chunks = chunkText(page.content, clampPositiveInteger(options.chunkSize, 4000));
			for (let index = 0; index < chunks.length; index += 1) {
				outputs.push(documentOutput({
					title: page.title,
					path: page.outputPath,
					pageContent: options.includeContent ? chunks[index] ?? '' : '',
					source,
					score: 0,
					siteUrl,
					tab: '',
					category: 'Pages',
					chunkIndex: index,
					chunkCount: chunks.length,
				}));
			}
			continue;
		}

		outputs.push(documentOutput({
			title: page.title,
			path: page.outputPath,
			pageContent: options.includeContent ? page.content : '',
			source,
			score: 0,
			siteUrl,
			tab: '',
			category: 'Pages',
		}));
	}

	return outputs;
}

export function rankSearchEntries(
	entries: SearchEntry[],
	query: string,
	siteUrl: string,
	filters: { tab?: string; category?: string } = {},
): Candidate[] {
	const queryTokens = tokenize(query);
	const normalizedQuery = normalizeText(query);
	const bestByPath = new Map<string, Candidate>();

	for (const entry of entries) {
		if (filters.tab && normalizeText(entry.tab) !== normalizeText(filters.tab)) continue;
		if (filters.category && normalizeText(entry.category) !== normalizeText(filters.category)) continue;

		const matchedUrl = absolutizeUrl(entry.url, siteUrl);
		const url = new URL(matchedUrl);
		const anchor = url.hash.replace(/^#/, '');
		url.hash = '';
		const sourceUrl = url.toString();
		const outputPath = relativeOutputPath(sourceUrl, siteUrl);
		const markdownUrl = entry.markdown ? absolutizeUrl(entry.markdown, siteUrl) : undefined;
		// A document with Markdown of its own is a match of its own, such as each operation on a
		// single-page reference; a search entry stands for its page.
		if (!outputPath && !markdownUrl) continue;

		const score = scoreEntry(entry, queryTokens, normalizedQuery);
		if (score <= 0) continue;

		const candidate = { entry, score, sourceUrl, matchedUrl, outputPath, anchor, markdownUrl };
		const key = markdownUrl ?? outputPath;
		const current = bestByPath.get(key);
		if (!current || candidate.score > current.score) {
			bestByPath.set(key, candidate);
		}
	}

	return [...bestByPath.values()].sort((left, right) => right.score - left.score);
}

export function parseLlmsFullText(text: string): Record<string, ParsedPage> {
	const lines = text.split(/\r?\n/);
	const pages: Record<string, ParsedPage> = {};
	let index = 0;

	while (index < lines.length) {
		const line = lines[index]?.trimEnd() ?? '';
		if (!line.startsWith('### ')) {
			index += 1;
			continue;
		}

		const title = line.slice(4).trim();
		let lookahead = index + 1;
		while (lookahead < lines.length && !lines[lookahead]?.trim()) lookahead += 1;

		const pathMatch = PATH_LINE_RE.exec(lines[lookahead]?.trim() ?? '');
		if (!pathMatch) {
			index += 1;
			continue;
		}

		const path = normalizeOutputPath(pathMatch[1] ?? '');
		let bodyStart = lookahead + 1;
		while (bodyStart < lines.length && !lines[bodyStart]?.trim()) bodyStart += 1;

		let bodyEnd = bodyStart;
		while (bodyEnd < lines.length) {
			const bodyLine = lines[bodyEnd] ?? '';
			if (bodyLine.startsWith('### ')) {
				let probe = bodyEnd + 1;
				while (probe < lines.length && !lines[probe]?.trim()) probe += 1;
				if (PATH_LINE_RE.test(lines[probe]?.trim() ?? '')) break;
			}
			bodyEnd += 1;
		}

		const content = lines.slice(bodyStart, bodyEnd).join('\n').trim();
		if (path && content) {
			pages[path] = { title, path: pathMatch[1]?.trim() ?? path, outputPath: path, content };
		}
		index = bodyEnd;
	}

	return pages;
}

export function absolutizeUrl(url: string, siteUrl: string): string {
	const site = new URL(normalizeSiteUrl(siteUrl));
	try {
		return new URL(url).toString();
	} catch {
		if (url.startsWith('/')) {
			const sitePath = site.pathname.replace(/\/+$/, '');
			if (!sitePath || url === sitePath || url.startsWith(`${sitePath}/`)) {
				return new URL(url, site.origin).toString();
			}
		}
		return new URL(url.replace(/^\/+/, ''), ensureTrailingSlash(site.toString())).toString();
	}
}

export function relativeOutputPath(url: string, siteUrl: string): string {
	const sitePath = new URL(normalizeSiteUrl(siteUrl)).pathname.replace(/\/+$/, '');
	let parsedPath = new URL(url).pathname;

	if (sitePath && parsedPath === sitePath) {
		return ROOT_OUTPUT_PATH;
	}
	if (sitePath && parsedPath.startsWith(`${sitePath}/`)) {
		parsedPath = parsedPath.slice(sitePath.length + 1);
		if (!parsedPath) return ROOT_OUTPUT_PATH;
	} else {
		parsedPath = parsedPath.replace(/^\/+/, '');
	}

	return normalizeOutputPath(parsedPath);
}

export function extractTextFromHtml(rawHtml: string): string {
	const stripped = rawHtml.replace(HEAD_RE, ' ').replace(SCRIPT_STYLE_RE, ' ').replace(TAG_RE, ' ');
	const decoded = decodeHtmlEntities(stripped);
	return decoded.replace(WHITESPACE_RE, ' ').trim();
}

async function findCandidates(options: SearchOptions): Promise<Candidate[]> {
	const siteUrl = normalizeSiteUrl(options.siteUrl);
	const entries = await loadSearchEntries(options);
	return rankSearchEntries(entries, options.query, siteUrl, {
		tab: options.tab,
		category: options.category,
	});
}

/**
 * Each match reads as its own Markdown, which a Sourcey build publishes for every page, operation
 * and schema. A site that publishes none falls back to its page in `llms-full.txt`, loaded only
 * then, and then to the page's HTML.
 */
async function hydrateCandidates(
	options: SourceyOptions,
	candidates: Candidate[],
	pageMap: PageMapLoader,
): Promise<Array<Record<string, unknown>>> {
	const documents = [];
	for (const candidate of candidates) {
		const markdown = candidate.markdownUrl ? (await fetchOptionalText(options, candidate.markdownUrl)).trim() : '';
		const page = markdown ? undefined : (await pageMap())[candidate.outputPath];
		// A document keeps its own title; a search entry stands for its page.
		const title = candidate.markdownUrl ? candidate.entry.title : page?.title ?? candidate.entry.title;
		const content = markdown || page?.content || await fetchPageFallback(options, candidate.sourceUrl) || candidate.entry.content;
		documents.push(documentOutput({
			title,
			path: candidate.outputPath,
			pageContent: content,
			source: candidate.sourceUrl,
			matchedUrl: candidate.matchedUrl,
			matchedTitle: candidate.entry.title,
			anchor: candidate.anchor,
			score: candidate.score,
			siteUrl: normalizeSiteUrl(options.siteUrl),
			tab: candidate.entry.tab,
			category: candidate.entry.category,
			method: candidate.entry.method,
			apiPath: candidate.entry.path,
		}));
	}
	return documents;
}

function documentOutput(input: {
	title: string;
	path: string;
	pageContent: string;
	source: string;
	score: number;
	siteUrl: string;
	tab: string;
	category: string;
	matchedUrl?: string;
	matchedTitle?: string;
	anchor?: string;
	method?: string;
	apiPath?: string;
	chunkIndex?: number;
	chunkCount?: number;
}): Record<string, unknown> {
	const metadata = {
		source: input.source,
		matched_url: input.matchedUrl ?? input.source,
		matched_title: input.matchedTitle ?? input.title,
		title: input.title,
		path: input.path,
		anchor: input.anchor || undefined,
		tab: input.tab,
		category: input.category,
		site_url: input.siteUrl,
		score: input.score,
		method: input.method,
		api_path: input.apiPath,
		chunk_index: input.chunkIndex,
		chunk_count: input.chunkCount,
	};

	return {
		status: 'ok',
		title: input.title,
		path: input.path,
		source: input.source,
		pageContent: input.pageContent,
		score: input.score,
		metadata,
	};
}

/**
 * The site's documents, from `documents.json`, the index a Sourcey build publishes for agents:
 * each page, operation and schema with its summary, its words and its own Markdown. A site built
 * before Sourcey 3.7.1 publishes `search-index.json` instead.
 */
async function loadSearchEntries(options: SourceyOptions): Promise<SearchEntry[]> {
	const documentsUrl = artifactUrl(options.siteUrl, 'documents.json');
	const index = await fetchArtifact(options, documentsUrl);
	if (index !== undefined) return documentEntries(parseJson(index, documentsUrl), options.siteUrl);

	const raw = await fetchJson(options, artifactUrl(options.siteUrl, 'search-index.json'));
	if (!Array.isArray(raw)) {
		throw new SourceyRetrievalError('invalid_search_index', 'search-index.json did not contain a list');
	}

	const entries = raw
		.filter(isRecord)
		.map((item): SearchEntry | null => {
			const title = coerceText(item.title);
			const url = coerceText(item.url);
			if (!title || !url) return null;
			return {
				title,
				content: coerceText(item.content),
				url,
				tab: coerceText(item.tab) || 'Docs',
				category: coerceText(item.category) || 'Pages',
				featured: Boolean(item.featured),
				method: coerceText(item.method) || undefined,
				path: coerceText(item.path) || undefined,
			};
		})
		.filter((entry): entry is SearchEntry => entry !== null);

	if (!entries.length) {
		throw new SourceyRetrievalError('empty_search_index', 'search-index.json did not contain any usable entries');
	}

	return entries;
}

async function loadPageMap(options: SourceyOptions): Promise<Record<string, ParsedPage>> {
	const llmsFull = await fetchArtifact(options, artifactUrl(options.siteUrl, 'llms-full.txt'));
	return llmsFull === undefined ? {} : normalizePageMapForSite(parseLlmsFullText(llmsFull), options.siteUrl);
}

async function loadPagesFromSitemap(options: SourceyOptions, maxPages: number): Promise<ParsedPage[]> {
	const siteUrl = normalizeSiteUrl(options.siteUrl);
	const sitemap = await fetchText(options, artifactUrl(siteUrl, 'sitemap.xml'));
	const urls = parseSitemapUrls(sitemap).slice(0, maxPages);
	const pages: ParsedPage[] = [];

	for (const url of urls) {
		try {
			const sourceUrl = absolutizeUrl(url, siteUrl);
			const outputPath = relativeOutputPath(sourceUrl, siteUrl);
			const html = await fetchText(options, sourceUrl);
			const content = extractTextFromHtml(html);
			if (!content) continue;
			pages.push({
				title: titleFromHtml(html) || outputPath,
				path: sourceUrl,
				outputPath,
				content,
				sourceUrl,
			});
		} catch {
			// Skip individual pages so one stale sitemap URL does not sink ingestion.
		}
	}

	return pages;
}

function normalizePageMapForSite(pageMap: Record<string, ParsedPage>, siteUrl: string): Record<string, ParsedPage> {
	const normalized: Record<string, ParsedPage> = {};
	for (const page of Object.values(pageMap)) {
		const outputPath = relativeOutputPath(absolutizeUrl(page.path, siteUrl), siteUrl) || page.outputPath;
		normalized[outputPath] = {
			...page,
			outputPath,
		};
	}
	return normalized;
}

async function fetchJson(options: SourceyOptions, url: string): Promise<unknown> {
	const raw = await options.httpGet(url, 'json');
	return typeof raw === 'string' ? parseJson(raw, url) : raw;
}

function parseJson(raw: string, url: string): unknown {
	const parsed = attempt(() => JSON.parse(raw) as unknown);
	if ('failure' in parsed) {
		throw new SourceyRetrievalError('invalid_json', `Failed to parse JSON from ${url}: ${String(parsed.failure)}`);
	}
	return parsed.value;
}

/**
 * What a step returned, or why it failed. Each helper here settles a failure and then throws its
 * own error with a code, which the node wraps for n8n, rather than throwing from a catch block.
 */
function attempt<T>(run: () => T): { value: T } | { failure: unknown } {
	try {
		return { value: run() };
	} catch (failure) {
		return { failure };
	}
}

async function request(options: SourceyOptions, url: string): Promise<{ value: unknown } | { failure: string }> {
	try {
		return { value: await options.httpGet(url, 'text') };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

const OPERATION_ID_RE = /^([A-Z]+)\s+(\S.*)$/;

/** The entries of a `documents.json` index: every page, operation and schema with its own Markdown. */
function documentEntries(index: unknown, siteUrl: string): SearchEntry[] {
	if (!isRecord(index) || !Array.isArray(index.documents)) {
		throw new SourceyRetrievalError('invalid_documents', 'documents.json did not contain a documents list');
	}

	const entries = index.documents
		.filter(isRecord)
		.map((item): SearchEntry | null => {
			const title = coerceText(item.title);
			const url = coerceText(item.url);
			if (!title || !url) return null;
			// An operation is named by its method and path, such as `GET /pets`.
			const operation = OPERATION_ID_RE.exec(coerceText(item.documentId));
			return {
				title,
				content: coerceText(item.description),
				searchText: coerceText(item.searchText) || undefined,
				url: absolutizeUrl(url, siteUrl),
				tab: coerceText(item.tab) || 'Docs',
				category: coerceText(item.kind) || 'page',
				method: operation?.[1],
				path: operation?.[2],
				markdown: coerceText(item.markdown) || undefined,
			};
		})
		.filter((entry): entry is SearchEntry => entry !== null);

	if (!entries.length) {
		throw new SourceyRetrievalError('empty_documents', 'documents.json did not contain any usable documents');
	}
	return entries;
}

function memoized<T>(load: () => Promise<T>): () => Promise<T> {
	let value: Promise<T> | undefined;
	return () => (value ??= load());
}

async function fetchText(options: SourceyOptions, url: string): Promise<string> {
	const response = await request(options, url);
	if ('failure' in response) {
		throw new SourceyRetrievalError('fetch_failed', `Failed to fetch ${url}: ${response.failure}`);
	}
	return asText(response.value);
}

/** A file a Sourcey build may not publish: its text, or undefined where the site has none. */
async function fetchArtifact(options: SourceyOptions, url: string): Promise<string | undefined> {
	const response = await request(options, url);
	if (!('failure' in response)) return asText(response.value);
	if (/404|not found/i.test(response.failure)) return undefined;
	throw new SourceyRetrievalError('fetch_failed', `Failed to fetch ${url}: ${response.failure}`);
}

function asText(raw: unknown): string {
	return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

async function fetchOptionalText(options: SourceyOptions, url: string): Promise<string> {
	try {
		return await fetchText(options, url);
	} catch {
		return '';
	}
}

async function fetchPageFallback(options: SourceyOptions, url: string): Promise<string> {
	try {
		return extractTextFromHtml(await fetchText(options, url));
	} catch {
		return '';
	}
}

function scoreEntry(entry: SearchEntry, queryTokens: string[], normalizedQuery: string): number {
	if (!queryTokens.length) return entry.featured ? 1 : 0;

	const words = [entry.content, entry.searchText].filter(Boolean).join(' ');
	const title = normalizeText(entry.title);
	const content = normalizeText(words);
	const path = normalizeText(entry.path ?? '');
	const tab = normalizeText(entry.tab);
	const category = normalizeText(entry.category);
	const method = normalizeText(entry.method ?? '');
	const searchText = [title, path, tab, category, method, content].filter(Boolean).join(' ');

	const titleTokens = new Set(tokenize(entry.title));
	const pathTokens = new Set(tokenize(`${entry.path ?? ''} ${entry.url}`));
	const contentTokens = new Set(tokenize(words));
	const metaTokens = new Set(tokenize(`${entry.tab} ${entry.category} ${entry.method ?? ''}`));

	let score = 0;
	if (normalizedQuery && title.includes(normalizedQuery)) score += 40;
	if (normalizedQuery && searchText.includes(normalizedQuery)) score += 16;

	for (const token of queryTokens) {
		if (titleTokens.has(token)) score += 8;
		// A word the title extends, such as "deploy" in "Deploying".
		else if (token.length >= 4 && [...titleTokens].some((word) => word.startsWith(token))) score += 6;
		if (pathTokens.has(token)) score += 5;
		if (contentTokens.has(token)) score += 3;
		if (metaTokens.has(token)) score += 2;
	}

	if (queryTokens.every((token) => searchText.includes(token))) score += 10;
	if (entry.featured) score += 1;

	return score;
}

function metadataForCandidate(siteUrl: string, candidate: Candidate, title: string): Record<string, unknown> {
	return {
		source: candidate.sourceUrl,
		matched_url: candidate.matchedUrl,
		matched_title: candidate.entry.title,
		title,
		path: candidate.outputPath,
		anchor: candidate.anchor || undefined,
		tab: candidate.entry.tab,
		category: candidate.entry.category,
		site_url: normalizeSiteUrl(siteUrl),
		score: candidate.score,
		method: candidate.entry.method,
		api_path: candidate.entry.path,
	};
}

function confidenceForScore(score: number): 'none' | 'low' | 'medium' | 'high' {
	if (score <= 0) return 'none';
	if (score < 12) return 'low';
	if (score < 30) return 'medium';
	return 'high';
}

function chunkText(text: string, chunkSize: number): string[] {
	if (text.length <= chunkSize) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(start + chunkSize, text.length);
		chunks.push(text.slice(start, end).trim());
		start = end;
	}
	return chunks.filter(Boolean);
}

function parseSitemapUrls(xml: string): string[] {
	const matches = xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
	return [...matches].map((match) => decodeHtmlEntities(match[1] ?? '').trim()).filter(Boolean);
}

function fallbackPageUrls(requestedUrl: string, siteUrl: string, outputPath: string): string[] {
	const urls: string[] = [];
	const add = (url: string) => {
		if (!urls.includes(url)) urls.push(url);
	};

	if (outputPath === ROOT_OUTPUT_PATH) {
		add(ensureTrailingSlash(normalizeSiteUrl(siteUrl)));
	}
	add(requestedUrl);

	const parsed = new URL(requestedUrl);
	if (!parsed.pathname.endsWith('/') && !/\.(?:html|htm)$/i.test(parsed.pathname)) {
		const htmlUrl = new URL(parsed.toString());
		htmlUrl.pathname = `${htmlUrl.pathname}.html`;
		add(htmlUrl.toString());

		const slashUrl = new URL(parsed.toString());
		slashUrl.pathname = `${slashUrl.pathname}/`;
		add(slashUrl.toString());
	}

	return urls;
}

function titleFromHtml(html: string): string {
	const match = /<title[^>]*>(.*?)<\/title>/is.exec(html);
	return match ? decodeHtmlEntities(extractTextFromHtml(match[1] ?? '')) : '';
}

function artifactUrl(siteUrl: string, artifactName: string): string {
	return new URL(artifactName, ensureTrailingSlash(normalizeSiteUrl(siteUrl))).toString();
}

function normalizeSiteUrl(siteUrl: string): string {
	const trimmed = siteUrl.trim().replace(/\/+$/, '');
	const parsed = attempt(() => new URL(trimmed));
	if ('failure' in parsed || (parsed.value.protocol !== 'http:' && parsed.value.protocol !== 'https:')) {
		throw new SourceyRetrievalError('invalid_site_url', 'Site URL must be an absolute http(s) URL');
	}
	return parsed.value.toString().replace(/\/+$/, '');
}

function normalizeOutputPath(path: string): string {
	let value = path.split('#', 1)[0]?.trim() ?? '';
	if (!value) return '';

	try {
		value = new URL(value).pathname;
	} catch {
		// Treat input as a bare path.
	}

	value = value.replace(/^\/+/, '').replace(/\/+$/, '');
	if (!value) return ROOT_OUTPUT_PATH;
	if (value.endsWith('.html')) value = value.slice(0, -5);
	else if (value.endsWith('.htm')) value = value.slice(0, -4);
	if (value === ROOT_OUTPUT_PATH) return ROOT_OUTPUT_PATH;
	if (value.endsWith('/index')) value = value.slice(0, -'/index'.length);
	return value;
}

function tokenize(text: string): string[] {
	const tokens = normalizeText(text).match(TOKEN_RE) ?? [];
	const filtered = tokens.filter((token) => !STOPWORDS.has(token));
	return filtered.length ? filtered : tokens;
}

function normalizeText(text: string): string {
	return text.toLowerCase().trim();
}

function coerceText(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function clampPositiveInteger(value: number, fallback: number): number {
	const number = Math.floor(Number(value));
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		const key = entity.toLowerCase();
		if (key === 'amp') return '&';
		if (key === 'lt') return '<';
		if (key === 'gt') return '>';
		if (key === 'quot') return '"';
		if (key === 'apos' || key === '#39') return "'";
		if (key === 'nbsp') return ' ';
		if (key.startsWith('#x')) {
			const codePoint = Number.parseInt(key.slice(2), 16);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		if (key.startsWith('#')) {
			const codePoint = Number.parseInt(key.slice(1), 10);
			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}
		return match;
	});
}

const TOKEN_RE = /[a-z0-9]+/g;
const PATH_LINE_RE = /^Path:\s*`([^`]+)`\s*$/;
const HEAD_RE = /<head\b.*?<\/head>/gis;
const SCRIPT_STYLE_RE = /<(?:script|style)\b.*?>.*?<\/(?:script|style)>/gis;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;
const ROOT_OUTPUT_PATH = 'index';
const STOPWORDS = new Set([
	'a',
	'an',
	'all',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'can',
	'do',
	'does',
	'for',
	'from',
	'get',
	'how',
	'i',
	'in',
	'into',
	'is',
	'it',
	'list',
	'of',
	'on',
	'or',
	'the',
	'to',
	'what',
	'with',
	'work',
	'works',
]);
