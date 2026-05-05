import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { HttpGet, LoadAllOutputMode } from './sourcey/retrieval';
import {
	SourceyRetrievalError,
	fetchSourceyPage,
	loadAllSourceyDocs,
	retrieveSourceyContext,
	searchSourceyDocs,
} from './sourcey/retrieval';

type SourceyOperation = 'retrieveContext' | 'search' | 'fetchPage' | 'loadAll';

export class Sourcey implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Sourcey',
		name: 'sourcey',
		icon: { light: 'file:sourcey.svg', dark: 'file:sourcey.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Retrieve and ingest Sourcey-generated documentation',
		subtitle: '={{ $parameter.operation }}',
		defaults: {
			name: 'Sourcey',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'retrieveContext',
				options: [
					{
						name: 'Fetch Page',
						value: 'fetchPage',
						description: 'Fetch the full content for a Sourcey docs page',
						action: 'Fetch a docs page',
					},
					{
						name: 'Load All',
						value: 'loadAll',
						description: 'Load all docs pages or chunks for vector-store ingestion',
						action: 'Load all docs',
					},
					{
						name: 'Retrieve Context',
						value: 'retrieveContext',
						description: 'Return ready-to-use docs context and citations for an AI workflow',
						action: 'Retrieve docs context',
					},
					{
						name: 'Search',
						value: 'search',
						description: 'Search a Sourcey docs site and return ranked result items',
						action: 'Search docs',
					},
				],
			},
			{
				displayName: 'Site URL',
				name: 'siteUrl',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'https://sourcey.com/docs',
				description: 'Root URL of the published Sourcey docs site',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'How do I document an MCP server?',
				description: 'Question or search text to match against the Sourcey docs',
				displayOptions: {
					show: {
						operation: ['retrieveContext', 'search'],
					},
				},
			},
			{
				displayName: 'Top K',
				name: 'topK',
				type: 'number',
				typeOptions: {
					minValue: 1,
					maxValue: 50,
				},
				default: 5,
				description: 'Maximum number of results to return or hydrate',
				displayOptions: {
					show: {
						operation: ['retrieveContext', 'search'],
					},
				},
			},
			{
				displayName: 'Max Context Characters',
				name: 'maxContextChars',
				type: 'number',
				typeOptions: {
					minValue: 500,
					maxValue: 100000,
				},
				default: 12000,
				description: 'Maximum characters to include in the packed context string',
				displayOptions: {
					show: {
						operation: ['retrieveContext'],
					},
				},
			},
			{
				displayName: 'Tab Filter',
				name: 'tab',
				type: 'string',
				default: '',
				placeholder: 'API Reference',
				description: 'Optional Sourcey tab label to search within',
				displayOptions: {
					show: {
						operation: ['retrieveContext', 'search'],
					},
				},
			},
			{
				displayName: 'Category Filter',
				name: 'category',
				type: 'string',
				default: '',
				placeholder: 'Pages',
				description: 'Optional Sourcey search category to search within',
				displayOptions: {
					show: {
						operation: ['retrieveContext', 'search'],
					},
				},
			},
			{
				displayName: 'Path or URL',
				name: 'path',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'guides/search.html',
				description: 'Page path or URL returned by Search or Retrieve Context',
				displayOptions: {
					show: {
						operation: ['fetchPage'],
					},
				},
			},
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				default: 'page',
				options: [
					{
						name: 'One Item per Chunk',
						value: 'chunk',
					},
					{
						name: 'One Item per Page',
						value: 'page',
					},
				],
				description: 'Whether Load All returns page items or chunk items',
				displayOptions: {
					show: {
						operation: ['loadAll'],
					},
				},
			},
			{
				displayName: 'Include Content',
				name: 'includeContent',
				type: 'boolean',
				default: true,
				description: 'Whether Load All should include pageContent for downstream vector stores',
				displayOptions: {
					show: {
						operation: ['loadAll'],
					},
				},
			},
			{
				displayName: 'Max Pages',
				name: 'maxPages',
				type: 'number',
				typeOptions: {
					minValue: 1,
				},
				default: 100,
				description: 'Maximum number of pages to load from the docs site',
				displayOptions: {
					show: {
						operation: ['loadAll'],
					},
				},
			},
			{
				displayName: 'Chunk Size',
				name: 'chunkSize',
				type: 'number',
				typeOptions: {
					minValue: 500,
					maxValue: 50000,
				},
				default: 4000,
				description: 'Maximum characters per chunk when Output Mode is One Item per Chunk',
				displayOptions: {
					show: {
						operation: ['loadAll'],
						outputMode: ['chunk'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const outputItems: INodeExecutionData[] = [];
		const httpGet = createHttpGet(this);

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex += 1) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as SourceyOperation;
				const siteUrl = this.getNodeParameter('siteUrl', itemIndex) as string;

				if (operation === 'retrieveContext') {
					const result = await retrieveSourceyContext({
						httpGet,
						siteUrl,
						query: this.getNodeParameter('query', itemIndex) as string,
						topK: this.getNodeParameter('topK', itemIndex, 5) as number,
						maxContextChars: this.getNodeParameter('maxContextChars', itemIndex, 12000) as number,
						tab: optionalString(this.getNodeParameter('tab', itemIndex, '') as string),
						category: optionalString(this.getNodeParameter('category', itemIndex, '') as string),
					});
					outputItems.push({ json: result as unknown as IDataObject, pairedItem: { item: itemIndex } });
					continue;
				}

				if (operation === 'search') {
					const results = await searchSourceyDocs({
						httpGet,
						siteUrl,
						query: this.getNodeParameter('query', itemIndex) as string,
						topK: this.getNodeParameter('topK', itemIndex, 5) as number,
						tab: optionalString(this.getNodeParameter('tab', itemIndex, '') as string),
						category: optionalString(this.getNodeParameter('category', itemIndex, '') as string),
					});
					outputItems.push(...asItems(results, itemIndex));
					continue;
				}

				if (operation === 'fetchPage') {
					const result = await fetchSourceyPage({
						httpGet,
						siteUrl,
						pathOrUrl: this.getNodeParameter('path', itemIndex) as string,
					});
					outputItems.push({ json: result as unknown as IDataObject, pairedItem: { item: itemIndex } });
					continue;
				}

				const results = await loadAllSourceyDocs({
					httpGet,
					siteUrl,
					outputMode: this.getNodeParameter('outputMode', itemIndex, 'page') as LoadAllOutputMode,
					includeContent: this.getNodeParameter('includeContent', itemIndex, true) as boolean,
					maxPages: this.getNodeParameter('maxPages', itemIndex, 100) as number,
					chunkSize: this.getNodeParameter('chunkSize', itemIndex, 4000) as number,
				});
				outputItems.push(...asItems(results, itemIndex));
			} catch (error) {
				if (this.continueOnFail()) {
					outputItems.push({
						json: errorOutput(error),
						error,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				throw new NodeOperationError(this.getNode(), error, { itemIndex });
			}
		}

		return [outputItems];
	}
}

function createHttpGet(context: IExecuteFunctions): HttpGet {
	return async (url, responseFormat) => {
		const response = await context.helpers.httpRequest({
			method: 'GET',
			url,
			json: responseFormat === 'json',
		});

		if (responseFormat === 'text' && typeof response !== 'string') {
			return JSON.stringify(response);
		}

		return response;
	};
}

function asItems(results: Array<Record<string, unknown>>, itemIndex: number): INodeExecutionData[] {
	if (results.length) {
		return results.map((json) => ({ json: json as unknown as IDataObject, pairedItem: { item: itemIndex } }));
	}

	return [{
		json: {
			status: 'no_results',
			results: [],
		},
		pairedItem: { item: itemIndex },
	}];
}

function optionalString(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function errorOutput(error: unknown): IDataObject {
	const message = error instanceof Error ? error.message : String(error);
	return {
		status: 'error',
		errorType: error instanceof SourceyRetrievalError ? error.code : 'unexpected_error',
		message,
	};
}
