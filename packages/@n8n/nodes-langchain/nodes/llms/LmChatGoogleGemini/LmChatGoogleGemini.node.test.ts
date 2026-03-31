import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { normalizeGeminiBindTools } from './LmChatGoogleGemini.node';

describe('normalizeGeminiBindTools', () => {
	it('should convert LangChain tools and sanitize unsupported schema keywords', () => {
		const tool = new DynamicStructuredTool({
			name: 'sample_tool',
			description: 'Sample tool',
			schema: z.object({
				mode: z.literal('strict'),
				count: z.number().gt(0),
			}),
			func: async () => 'ok',
		});

		const normalized = normalizeGeminiBindTools([tool]);

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

		expect(parameters.properties.mode.const).toBeUndefined();
		expect(parameters.properties.mode.enum).toEqual(['strict']);
		expect(parameters.properties.count.exclusiveMinimum).toBeUndefined();
	});

	it('should sanitize existing Gemini function declarations', () => {
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

		const normalized = normalizeGeminiBindTools(input) as Array<{
			functionDeclarations: Array<{ parameters?: Record<string, unknown> }>;
		}>;
		const parameters = normalized[0].functionDeclarations[0].parameters as {
			properties: {
				kind: Record<string, unknown>;
				amount: Record<string, unknown>;
			};
		};

		expect(parameters.properties.kind.const).toBeUndefined();
		expect(parameters.properties.kind.enum).toEqual(['fixed']);
		expect(parameters.properties.amount.exclusiveMinimum).toBeUndefined();
	});

	it('should preserve passthrough Gemini built-in tools while appending declarations', () => {
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

		const normalized = normalizeGeminiBindTools([builtInTool, openAiTool]) as Array<
			Record<string, unknown>
		>;

		expect(normalized).toHaveLength(2);
		expect(normalized[0]).toEqual(builtInTool);

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
});
