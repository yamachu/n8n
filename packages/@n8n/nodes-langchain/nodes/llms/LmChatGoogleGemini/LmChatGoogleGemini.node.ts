import type { SafetySetting } from '@google/generative-ai';
import type { Tool } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import {
	makeN8nLlmFailedAttemptHandler,
	N8nLlmTracing,
	getConnectionHintNoticeField,
} from '@n8n/ai-utilities';
import { NodeConnectionTypes } from 'n8n-workflow';
import type {
	NodeError,
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';

import {
	formatToGeminiToolDeclaration,
	toGeminiCompatibleSchema,
} from '../../vendors/GoogleGemini/helpers/utils';
import { getAdditionalOptions } from '../gemini-common/additional-options';

/**
 * Type representing the input accepted by ChatGoogleGenerativeAI.bindTools()
 */
type GeminiBindToolsInput = Parameters<ChatGoogleGenerativeAI['bindTools']>[0];

/**
 * Gemini function declaration structure
 */
type GeminiFunctionDeclaration = {
	name: string;
	description?: string;
	parameters?: IDataObject;
};

/**
 * Tool with Gemini function declarations format
 */
type GeminiFunctionDeclarationsTool = {
	functionDeclarations: GeminiFunctionDeclaration[];
};

/**
 * Type guard to check if a value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Type guard to check if a value is a Gemini function declarations tool
 */
function isFunctionDeclarationsTool(value: unknown): value is GeminiFunctionDeclarationsTool {
	if (!isPlainObject(value) || !Array.isArray(value.functionDeclarations)) {
		return false;
	}

	return value.functionDeclarations.every(
		(declaration) => isPlainObject(declaration) && typeof declaration.name === 'string',
	);
}

/**
 * Type guard to check if a value is a LangChain tool
 */
function isLangChainTool(value: unknown): value is Tool {
	return (
		isPlainObject(value) &&
		typeof value.name === 'string' &&
		typeof value.description === 'string' &&
		'schema' in value
	);
}

/**
 * Type guard to check if a value is an OpenAI-style function tool
 */
function isOpenAiFunctionTool(
	value: unknown,
): value is { type: 'function'; function: Record<string, unknown> } {
	if (!isPlainObject(value) || value.type !== 'function' || !isPlainObject(value.function)) {
		return false;
	}

	return typeof value.function.name === 'string';
}

/**
 * Sanitize existing Gemini function declarations by removing unsupported schema keywords
 */
function sanitizeFunctionDeclarations(
	tool: GeminiFunctionDeclarationsTool,
): GeminiFunctionDeclarationsTool {
	return {
		functionDeclarations: tool.functionDeclarations.map((declaration) => ({
			...declaration,
			parameters: toGeminiCompatibleSchema(declaration.parameters),
		})),
	};
}

/**
 * Convert OpenAI-style function tool to Gemini function declarations format
 */
function convertOpenAiToFunctionDeclarations(tool: {
	type: 'function';
	function: Record<string, unknown>;
}): GeminiFunctionDeclarationsTool {
	return {
		functionDeclarations: [
			{
				name: tool.function.name as string,
				description:
					typeof tool.function.description === 'string'
						? tool.function.description
						: 'A function available to call.',
				parameters: toGeminiCompatibleSchema(tool.function.parameters),
			},
		],
	};
}

/**
 * Normalize and sanitize various tool formats to Gemini function declarations format
 * - Converts LangChain tools to Gemini Function Declarations
 * - Converts OpenAI-style function tools to Gemini format
 * - Sanitizes existing Gemini declarations by removing unsupported schema keywords
 * - Preserves passthrough tools (e.g., googleSearchRetrieval)
 */
export function normalizeGeminiBindTools(tools: GeminiBindToolsInput): GeminiBindToolsInput {
	const otherTools: unknown[] = [];
	const functionDeclarations: GeminiFunctionDeclaration[] = [];

	for (const tool of tools) {
		if (isLangChainTool(tool)) {
			functionDeclarations.push(formatToGeminiToolDeclaration(tool));
			continue;
		}

		if (isOpenAiFunctionTool(tool)) {
			functionDeclarations.push(...convertOpenAiToFunctionDeclarations(tool).functionDeclarations);
			continue;
		}

		if (isFunctionDeclarationsTool(tool)) {
			functionDeclarations.push(...sanitizeFunctionDeclarations(tool).functionDeclarations);
			continue;
		}

		otherTools.push(tool);
	}

	if (functionDeclarations.length === 0) {
		return otherTools as GeminiBindToolsInput;
	}

	return [...otherTools, { functionDeclarations }] as GeminiBindToolsInput;
}

/**
 * Patch ChatGoogleGenerativeAI.bindTools() to automatically normalize and sanitize tools
 * before passing them to the LLM
 */
function patchGeminiBindTools(model: ChatGoogleGenerativeAI): void {
	const originalBindTools = model.bindTools.bind(model);

	model.bindTools = (tools, kwargs) => {
		return originalBindTools(normalizeGeminiBindTools(tools), kwargs);
	};
}

function errorDescriptionMapper(error: NodeError) {
	if (error.description?.includes('properties: should be non-empty for OBJECT type')) {
		return 'Google Gemini requires at least one <a href="https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function/" target="_blank">dynamic parameter</a> when using tools';
	}

	return error.description ?? 'Unknown error';
}
export class LmChatGoogleGemini implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Google Gemini Chat Model',

		name: 'lmChatGoogleGemini',
		icon: 'file:google.svg',
		group: ['transform'],
		version: 1,
		description: 'Chat Model Google Gemini',
		defaults: {
			name: 'Google Gemini Chat Model',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{
						url: 'https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatgooglegemini/',
					},
				],
			},
		},

		inputs: [],

		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'googlePalmApi',
				required: true,
			},
		],
		requestDefaults: {
			ignoreHttpStatusErrors: true,
			baseURL: '={{ $credentials.host }}',
		},
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiChain, NodeConnectionTypes.AiAgent]),
			{
				displayName: 'Model',
				name: 'modelName',
				type: 'options',
				description:
					'The model which will generate the completion. <a href="https://developers.generativeai.google/api/rest/generativelanguage/models/list">Learn more</a>.',
				typeOptions: {
					loadOptions: {
						routing: {
							request: {
								method: 'GET',
								url: '/v1beta/models',
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: {
											property: 'models',
										},
									},
									{
										type: 'filter',
										properties: {
											pass: "={{ !$responseItem.name.includes('embedding') }}",
										},
									},
									{
										type: 'setKeyValue',
										properties: {
											name: '={{$responseItem.name}}',
											value: '={{$responseItem.name}}',
											description: '={{$responseItem.description}}',
										},
									},
									{
										type: 'sort',
										properties: {
											key: 'name',
										},
									},
								],
							},
						},
					},
				},
				routing: {
					send: {
						type: 'body',
						property: 'model',
					},
				},
				default: 'models/gemini-2.5-flash',
			},
			// thinking budget not supported in @langchain/google-genai
			// as it utilises the old google generative ai SDK
			getAdditionalOptions({ supportsThinkingBudget: false }),
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('googlePalmApi');

		const modelName = this.getNodeParameter('modelName', itemIndex) as string;
		const options = this.getNodeParameter('options', itemIndex, {
			maxOutputTokens: 1024,
			temperature: 0.7,
			topK: 40,
			topP: 0.9,
		}) as {
			maxOutputTokens: number;
			temperature: number;
			topK: number;
			topP: number;
		};

		const safetySettings = this.getNodeParameter(
			'options.safetySettings.values',
			itemIndex,
			null,
		) as SafetySetting[];

		const model = new ChatGoogleGenerativeAI({
			apiKey: credentials.apiKey as string,
			baseUrl: credentials.host as string,
			model: modelName,
			topK: options.topK,
			topP: options.topP,
			temperature: options.temperature,
			maxOutputTokens: options.maxOutputTokens,
			safetySettings,
			callbacks: [new N8nLlmTracing(this, { errorDescriptionMapper })],
			onFailedAttempt: makeN8nLlmFailedAttemptHandler(this),
		});

		patchGeminiBindTools(model);

		return {
			response: model,
		};
	}
}
