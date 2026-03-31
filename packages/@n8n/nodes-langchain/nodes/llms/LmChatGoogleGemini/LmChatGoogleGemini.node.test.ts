import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { normalizeGeminiBindTools } from './LmChatGoogleGemini.node';

/**
 * Test suite for normalizeGeminiBindTools
 *
 * Tests the normalization and sanitization of various tool formats to ensure
 * compatibility with Gemini's function calling API, which doesn't support certain
 * JSON schema keywords like const, exclusiveMinimum, etc.
 */
describe('normalizeGeminiBindTools', () => {
	it('should convert LangChain DynamicStructuredTool to Gemini function declarations and sanitize schema', () => {
		// Arrange
		const tool = new DynamicStructuredTool({
			name: 'sample_tool',
			description: 'Sample tool',
			schema: z.object({
				mode: z.literal('strict'),
				count: z.number().gt(0),
			}),
			func: async () => 'ok',
		});

		// Act
		const normalized = normalizeGeminiBindTools([tool]);

		// Assert
		expect(normalized).toHaveLength(1);
		const declarationTool = normalized[0] as {
			functionDeclarations: Array<{ parameters?: Record<string, unknown> }>;
		};
		const parameters = declarationTool.functionDeclarations[0].parameters as {
			properties: {
				mode: Record<string, unknown>;
				count: Record<string, unknown>;
			};
		};

		// Verify 'const' is converted to 'enum'
		expect(parameters.properties.mode.const).toBeUndefined();
		expect(parameters.properties.mode.enum).toEqual(['strict']);

		// Verify 'exclusiveMinimum' is removed
		expect(parameters.properties.count.exclusiveMinimum).toBeUndefined();
	});

	it('should sanitize existing Gemini-format function declarations by removing unsupported keywords', () => {
		// Arrange
		const input = [
			{
				functionDeclarations: [
					{
						name: 'existing_tool',
						parameters: {
							type: 'object',
							properties: {
								kind: { const: 'fixed' },
								amount: { type: 'number', exclusiveMinimum: 0 },
							},
						},
					},
				],
			},
		];

		// Act
		const normalized = normalizeGeminiBindTools(input) as Array<{
			functionDeclarations: Array<{ parameters?: Record<string, unknown> }>;
		}>;
		const parameters = normalized[0].functionDeclarations[0].parameters as {
			properties: {
				kind: Record<string, unknown>;
				amount: Record<string, unknown>;
			};
		};

		// Assert
		expect(parameters.properties.kind.const).toBeUndefined();
		expect(parameters.properties.kind.enum).toEqual(['fixed']);
		expect(parameters.properties.amount.exclusiveMinimum).toBeUndefined();
	});

	it('should preserve passthrough Gemini built-in tools while converting OpenAI-format tools', () => {
		// Arrange
		const builtInTool = { googleSearchRetrieval: {} };
		const openAiTool = {
			type: 'function' as const,
			function: {
				name: 'openai_style',
				description: 'OpenAI style tool',
				parameters: {
					type: 'object',
					properties: {
						flag: { const: true },
					},
				},
			},
		};

		// Act
		const normalized = normalizeGeminiBindTools([builtInTool, openAiTool]) as Array<
			Record<string, unknown>
		>;

		// Assert
		expect(normalized).toHaveLength(2);

		// Built-in tool should be preserved as-is
		expect(normalized[0]).toEqual(builtInTool);

		// OpenAI tool should be converted to Gemini function declarations
		const functionDeclarations = normalized[1].functionDeclarations as Array<{
			parameters?: Record<string, unknown>;
		}>;
		const parameters = functionDeclarations[0].parameters as {
			properties: {
				flag: Record<string, unknown>;
			};
		};
		expect(functionDeclarations).toHaveLength(1);
		expect(parameters.properties.flag.const).toBeUndefined();
		expect(parameters.properties.flag.enum).toEqual([true]);
	});

	it('should handle multiple tools of different types in a single call', () => {
		// Arrange
		const langchainTool = new DynamicStructuredTool({
			name: 'langchain_tool',
			description: 'A LangChain tool',
			schema: z.object({
				input: z.string(),
			}),
			func: async () => 'result',
		});

		const openAiTool = {
			type: 'function' as const,
			function: {
				name: 'openai_tool',
				description: 'An OpenAI tool',
				parameters: {
					type: 'object',
					properties: {},
				},
			},
		};

		const passthroughTool = { googleSearchRetrieval: {} };

		// Act
		const normalized = normalizeGeminiBindTools([langchainTool, openAiTool, passthroughTool]);

		// Assert
		const decl = normalized.find((t) => 'functionDeclarations' in t) as {
			functionDeclarations: Array<{ name: string }>;
		};
		expect(decl.functionDeclarations).toHaveLength(2);
		expect(decl.functionDeclarations.map((d) => d.name)).toEqual(['langchain_tool', 'openai_tool']);

		// Passthrough tool should be preserved
		const passthrough = normalized.find((t) => 'googleSearchRetrieval' in t);
		expect(passthrough).toEqual(passthroughTool);
	});

	it('should return only passthrough tools when no convertible tools are provided', () => {
		// Arrange
		const builtInTools = [{ googleSearchRetrieval: {} }, { codeExecution: {} }];

		// Act
		const normalized = normalizeGeminiBindTools(builtInTools);

		// Assert
		expect(normalized).toEqual(builtInTools);
		expect(normalized).toHaveLength(2);
	});
});
