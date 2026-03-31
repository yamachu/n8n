import type { Tool } from '@langchain/core/tools';
import axios from 'axios';
import { mockDeep } from 'jest-mock-extended';
import type { IBinaryData, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { z } from 'zod';

import {
	createFileSearchStore,
	deleteFileSearchStore,
	downloadFile,
	formatToGeminiToolDeclaration,
	listFileSearchStores,
	toGeminiCompatibleSchema,
	transferFile,
	uploadFile,
	uploadToFileSearchStore,
} from './utils';
import * as transport from '../transport';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GoogleGemini -> utils', () => {
	const mockExecuteFunctions = mockDeep<IExecuteFunctions>();
	const apiRequestMock = jest.spyOn(transport, 'apiRequest');

	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers({ advanceTimers: true });
	});

	describe('downloadFile', () => {
		it('should download file', async () => {
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				body: new ArrayBuffer(10),
				headers: {
					'content-type': 'application/pdf',
				},
			});

			const file = await downloadFile.call(mockExecuteFunctions, 'https://example.com/file.pdf');

			expect(file).toEqual({
				fileContent: Buffer.from(new ArrayBuffer(10)),
				mimeType: 'application/pdf',
			});
			expect(mockExecuteFunctions.helpers.httpRequest).toHaveBeenCalledWith({
				method: 'GET',
				url: 'https://example.com/file.pdf',
				returnFullResponse: true,
				encoding: 'arraybuffer',
			});
		});

		it('should parse mime type from content type header', async () => {
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				body: new ArrayBuffer(10),
				headers: {
					'content-type': 'application/pdf; q=0.9',
				},
			});

			const file = await downloadFile.call(mockExecuteFunctions, 'https://example.com/file.pdf');

			expect(file).toEqual({
				fileContent: Buffer.from(new ArrayBuffer(10)),
				mimeType: 'application/pdf',
			});
		});

		it('should use fallback mime type if content type header is not present', async () => {
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				body: new ArrayBuffer(10),
				headers: {},
			});

			const file = await downloadFile.call(
				mockExecuteFunctions,
				'https://example.com/file.pdf',
				'application/pdf',
			);

			expect(file).toEqual({
				fileContent: Buffer.from(new ArrayBuffer(10)),
				mimeType: 'application/pdf',
			});
		});
	});

	describe('uploadFile', () => {
		it('should upload file', async () => {
			const fileContent = Buffer.from(new ArrayBuffer(10));
			const mimeType = 'application/pdf';

			apiRequestMock.mockResolvedValue({
				headers: {
					'x-goog-upload-url': 'https://google.com/some-upload-url',
				},
			});
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				file: {
					name: 'files/test123',
					uri: 'https://google.com/files/test123',
					mimeType: 'application/pdf',
					state: 'ACTIVE',
				},
			});

			const file = await uploadFile.call(mockExecuteFunctions, fileContent, mimeType);

			expect(file).toEqual({
				fileUri: 'https://google.com/files/test123',
				mimeType: 'application/pdf',
			});
			expect(apiRequestMock).toHaveBeenCalledWith('POST', '/upload/v1beta/files', {
				headers: {
					'X-Goog-Upload-Protocol': 'resumable',
					'X-Goog-Upload-Command': 'start',
					'X-Goog-Upload-Header-Content-Length': '10',
					'X-Goog-Upload-Header-Content-Type': 'application/pdf',
					'Content-Type': 'application/json',
				},
				option: {
					returnFullResponse: true,
				},
			});
			expect(mockExecuteFunctions.helpers.httpRequest).toHaveBeenCalledWith({
				method: 'POST',
				url: 'https://google.com/some-upload-url',
				headers: {
					'Content-Length': '10',
					'X-Goog-Upload-Offset': '0',
					'X-Goog-Upload-Command': 'upload, finalize',
				},
				body: fileContent,
			});
		});

		it('should throw error if file upload fails', async () => {
			const fileContent = Buffer.from(new ArrayBuffer(10));
			const mimeType = 'application/pdf';
			apiRequestMock.mockResolvedValue({
				headers: {
					'x-goog-upload-url': 'https://google.com/some-upload-url',
				},
			});
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				file: {
					state: 'FAILED',
					error: {
						message: 'File upload failed',
					},
				},
			});

			await expect(uploadFile.call(mockExecuteFunctions, fileContent, mimeType)).rejects.toThrow(
				'File upload failed',
			);
		});

		it('should upload file when its not immediately active', async () => {
			const fileContent = Buffer.from(new ArrayBuffer(10));
			const mimeType = 'application/pdf';

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://google.com/some-upload-url',
				},
			});
			mockExecuteFunctions.helpers.httpRequest.mockResolvedValue({
				file: {
					name: 'files/test123',
					uri: 'https://google.com/files/test123',
					mimeType: 'application/pdf',
					state: 'PENDING',
				},
			});
			apiRequestMock.mockResolvedValueOnce({
				name: 'files/test123',
				uri: 'https://google.com/files/test123',
				mimeType: 'application/pdf',
				state: 'ACTIVE',
			});

			const promise = uploadFile.call(mockExecuteFunctions, fileContent, mimeType);
			await jest.advanceTimersByTimeAsync(1000);
			const file = await promise;

			expect(file).toEqual({
				fileUri: 'https://google.com/files/test123',
				mimeType: 'application/pdf',
			});
			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/files/test123');
		});

		it('should poll until file is active', async () => {
			const fileContent = Buffer.from('test file content');
			const mimeType = 'application/pdf';

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				file: {
					name: 'files/abc123',
					uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
					mimeType: 'application/pdf',
					state: 'PROCESSING',
				},
			});

			apiRequestMock
				.mockResolvedValueOnce({
					name: 'files/abc123',
					uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
					mimeType: 'application/pdf',
					state: 'PROCESSING',
				})
				.mockResolvedValueOnce({
					name: 'files/abc123',
					uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
					mimeType: 'application/pdf',
					state: 'ACTIVE',
				});

			jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
				callback();
				return {} as any;
			});

			const result = await uploadFile.call(mockExecuteFunctions, fileContent, mimeType);

			expect(result).toEqual({
				fileUri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
				mimeType: 'application/pdf',
			});

			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/files/abc123');
		});

		it('should throw error when upload fails', async () => {
			const fileContent = Buffer.from('test file content');
			const mimeType = 'application/pdf';

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				file: {
					name: 'files/abc123',
					uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
					mimeType: 'application/pdf',
					state: 'FAILED',
					error: { message: 'Upload failed' },
				},
			});

			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(uploadFile.call(mockExecuteFunctions, fileContent, mimeType)).rejects.toThrow(
				new NodeOperationError(mockExecuteFunctions.getNode(), 'Upload failed', {
					description: 'Error uploading file',
				}),
			);
		});
	});

	describe('transferFile', () => {
		it('should transfer file from URL using axios', async () => {
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf; charset=utf-8',
				},
			});

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					file: {
						name: 'files/abc123',
						uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
						mimeType: 'application/pdf',
						state: 'ACTIVE',
					},
				},
			});

			const result = await transferFile.call(
				mockExecuteFunctions,
				0,
				'https://example.com/file.pdf',
				'application/octet-stream',
			);

			expect(result).toEqual({
				fileUri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
				mimeType: 'application/pdf',
			});

			expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/file.pdf', {
				params: undefined,
				responseType: 'stream',
			});

			expect(apiRequestMock).toHaveBeenCalledWith('POST', '/upload/v1beta/files', {
				headers: {
					'X-Goog-Upload-Protocol': 'resumable',
					'X-Goog-Upload-Command': 'start',
					'X-Goog-Upload-Header-Content-Type': 'application/pdf',
					'Content-Type': 'application/json',
				},
				option: { returnFullResponse: true },
			});

			expect(mockExecuteFunctions.helpers.httpRequest).toHaveBeenCalledWith({
				method: 'POST',
				url: 'https://upload.googleapis.com/upload/123',
				headers: {
					'X-Goog-Upload-Offset': '0',
					'X-Goog-Upload-Command': 'upload, finalize',
					'Content-Type': 'application/pdf',
				},
				body: mockStream,
				returnFullResponse: true,
			});
		});

		it('should transfer file from binary data without id', async () => {
			const mockBinaryData: IBinaryData = {
				mimeType: 'application/pdf',
				fileName: 'test.pdf',
				fileSize: '1024',
				fileExtension: 'pdf',
				data: 'test',
			};

			mockExecuteFunctions.getNodeParameter.mockReturnValue('data');
			mockExecuteFunctions.helpers.assertBinaryData.mockReturnValue(mockBinaryData);
			mockExecuteFunctions.helpers.getBinaryDataBuffer.mockResolvedValue(Buffer.from('test'));

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				file: {
					name: 'files/abc123',
					uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
					mimeType: 'application/pdf',
					state: 'ACTIVE',
				},
			});

			const result = await transferFile.call(
				mockExecuteFunctions,
				0,
				undefined,
				'application/octet-stream',
			);

			expect(result).toEqual({
				fileUri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
				mimeType: 'application/pdf',
			});

			expect(mockExecuteFunctions.helpers.assertBinaryData).toHaveBeenCalledWith(0, 'data');
			expect(mockExecuteFunctions.helpers.getBinaryDataBuffer).toHaveBeenCalledWith(0, 'data');
		});

		it('should transfer file from binary data with id using stream', async () => {
			const mockBinaryData: IBinaryData = {
				id: 'binary-123',
				mimeType: 'application/pdf',
				fileName: 'test.pdf',
				fileSize: '1024',
				fileExtension: 'pdf',
				data: 'test',
			};

			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockExecuteFunctions.getNodeParameter.mockReturnValue('data');
			mockExecuteFunctions.helpers.assertBinaryData.mockReturnValue(mockBinaryData);
			mockExecuteFunctions.helpers.getBinaryStream.mockResolvedValue(mockStream);

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					file: {
						name: 'files/abc123',
						uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
						mimeType: 'application/pdf',
						state: 'ACTIVE',
					},
				},
			});

			const result = await transferFile.call(
				mockExecuteFunctions,
				0,
				undefined,
				'application/octet-stream',
			);

			expect(result).toEqual({
				fileUri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
				mimeType: 'application/pdf',
			});

			expect(mockExecuteFunctions.helpers.getBinaryStream).toHaveBeenCalledWith(
				'binary-123',
				262144,
			);
		});

		it('should throw error when binary property name is missing', async () => {
			mockExecuteFunctions.getNodeParameter.mockReturnValue('');
			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(
				transferFile.call(mockExecuteFunctions, 0, undefined, 'application/octet-stream'),
			).rejects.toThrow(
				new NodeOperationError(
					mockExecuteFunctions.getNode(),
					'Binary property name or download URL is required',
					{
						description: 'Error uploading file',
					},
				),
			);
		});

		it('should throw error when upload URL is not received', async () => {
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf',
				},
			});

			apiRequestMock.mockResolvedValueOnce({
				headers: {},
			});

			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(
				transferFile.call(
					mockExecuteFunctions,
					0,
					'https://example.com/file.pdf',
					'application/octet-stream',
				),
			).rejects.toThrow(
				new NodeOperationError(mockExecuteFunctions.getNode(), 'Failed to get upload URL'),
			);
		});

		it('should poll until file is active and throw error on failure', async () => {
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf',
				},
			});

			apiRequestMock.mockResolvedValueOnce({
				headers: {
					'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
				},
			});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					file: {
						name: 'files/abc123',
						uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
						mimeType: 'application/pdf',
						state: 'PROCESSING',
					},
				},
			});

			apiRequestMock.mockResolvedValueOnce({
				name: 'files/abc123',
				uri: 'https://generativelanguage.googleapis.com/v1/files/abc123',
				mimeType: 'application/pdf',
				state: 'FAILED',
				error: { message: 'Processing failed' },
			});

			jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
				callback();
				return {} as any;
			});

			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(
				transferFile.call(
					mockExecuteFunctions,
					0,
					'https://example.com/file.pdf',
					'application/octet-stream',
				),
			).rejects.toThrow(
				new NodeOperationError(mockExecuteFunctions.getNode(), 'Processing failed', {
					description: 'Error uploading file',
				}),
			);
		});
	});

	describe('createFileSearchStore', () => {
		it('should create a file search store', async () => {
			const displayName = 'My File Search Store';
			const mockResponse = {
				name: 'fileSearchStores/abc123',
				displayName: 'My File Search Store',
			};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await createFileSearchStore.call(mockExecuteFunctions, displayName);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('POST', '/v1beta/fileSearchStores', {
				body: { displayName },
			});
		});
	});

	describe('uploadToFileSearchStore', () => {
		it('should upload file from URL to file search store', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf; charset=utf-8',
				},
			});

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: false,
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
					response: {
						name: 'fileSearchStores/abc123/files/file123',
					},
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
				callback();
				return {} as any;
			});

			const result = await uploadToFileSearchStore.call(
				mockExecuteFunctions,
				0,
				fileSearchStoreName,
				displayName,
				'https://example.com/file.pdf',
			);

			expect(result).toEqual({
				name: 'fileSearchStores/abc123/files/file123',
			});

			expect(mockedAxios.get).toHaveBeenCalledWith('https://example.com/file.pdf', {
				params: undefined,
				responseType: 'stream',
			});

			expect(apiRequestMock).toHaveBeenCalledWith(
				'POST',
				`/upload/v1beta/${fileSearchStoreName}:uploadToFileSearchStore`,
				{
					headers: {
						'X-Goog-Upload-Protocol': 'resumable',
						'X-Goog-Upload-Command': 'start',
						'X-Goog-Upload-Header-Content-Type': 'application/pdf',
						'Content-Type': 'application/json',
					},
					body: { displayName, mimeType: 'application/pdf' },
					option: { returnFullResponse: true },
				},
			);

			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/operations/op123');
		});

		it('should upload file from binary data (buffer) to file search store', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockBinaryData: IBinaryData = {
				mimeType: 'application/pdf',
				fileName: 'test.pdf',
				fileSize: '1024',
				fileExtension: 'pdf',
				data: 'test',
			};

			mockExecuteFunctions.getNodeParameter.mockReturnValue('data');
			mockExecuteFunctions.helpers.assertBinaryData.mockReturnValue(mockBinaryData);
			mockExecuteFunctions.helpers.getBinaryDataBuffer.mockResolvedValue(Buffer.from('test'));

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
					response: {
						name: 'fileSearchStores/abc123/files/file123',
					},
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			const result = await uploadToFileSearchStore.call(
				mockExecuteFunctions,
				0,
				fileSearchStoreName,
				displayName,
			);

			expect(result).toEqual({
				name: 'fileSearchStores/abc123/files/file123',
			});

			expect(mockExecuteFunctions.helpers.assertBinaryData).toHaveBeenCalledWith(0, 'data');
			expect(mockExecuteFunctions.helpers.getBinaryDataBuffer).toHaveBeenCalledWith(0, 'data');
		});

		it('should upload file from binary data (stream) to file search store', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockBinaryData: IBinaryData = {
				id: 'binary-123',
				mimeType: 'application/pdf',
				fileName: 'test.pdf',
				fileSize: '1024',
				fileExtension: 'pdf',
				data: 'test',
			};

			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockExecuteFunctions.getNodeParameter.mockReturnValue('data');
			mockExecuteFunctions.helpers.assertBinaryData.mockReturnValue(mockBinaryData);
			mockExecuteFunctions.helpers.getBinaryStream.mockResolvedValue(mockStream);

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
					response: {
						name: 'fileSearchStores/abc123/files/file123',
					},
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			const result = await uploadToFileSearchStore.call(
				mockExecuteFunctions,
				0,
				fileSearchStoreName,
				displayName,
			);

			expect(result).toEqual({
				name: 'fileSearchStores/abc123/files/file123',
			});

			expect(mockExecuteFunctions.helpers.getBinaryStream).toHaveBeenCalledWith(
				'binary-123',
				262144,
			);
		});

		it('should poll operation until done', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf',
				},
			});

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: false,
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: false,
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
					response: {
						name: 'fileSearchStores/abc123/files/file123',
					},
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
				callback();
				return {} as any;
			});

			const result = await uploadToFileSearchStore.call(
				mockExecuteFunctions,
				0,
				fileSearchStoreName,
				displayName,
				'https://example.com/file.pdf',
			);

			expect(result).toEqual({
				name: 'fileSearchStores/abc123/files/file123',
			});

			expect(apiRequestMock).toHaveBeenCalledTimes(4); // 1 upload init + 3 operation polls
		});

		it('should throw error when operation fails', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf',
				},
			});

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: false,
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
					error: { message: 'Upload failed' },
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			jest.spyOn(global, 'setTimeout').mockImplementation((callback: any) => {
				callback();
				return {} as any;
			});

			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(
				uploadToFileSearchStore.call(
					mockExecuteFunctions,
					0,
					fileSearchStoreName,
					displayName,
					'https://example.com/file.pdf',
				),
			).rejects.toThrow(
				new NodeOperationError(mockExecuteFunctions.getNode(), 'Upload failed', {
					description: 'Error uploading file to File Search store',
				}),
			);
		});

		it('should throw error when binary property name is missing', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';

			mockExecuteFunctions.getNodeParameter.mockReturnValue('');
			mockExecuteFunctions.getNode.mockReturnValue({ name: 'Google Gemini' } as any);

			await expect(
				uploadToFileSearchStore.call(mockExecuteFunctions, 0, fileSearchStoreName, displayName),
			).rejects.toThrow(
				new NodeOperationError(
					mockExecuteFunctions.getNode(),
					'Binary property name or download URL is required',
					{
						description: 'Error uploading file',
					},
				),
			);
		});

		it('should return undefined when response is missing', async () => {
			const fileSearchStoreName = 'fileSearchStores/abc123';
			const displayName = 'test-file.pdf';
			const mockStream = {
				pipe: jest.fn(),
				on: jest.fn(),
			} as any;

			mockedAxios.get.mockResolvedValue({
				data: mockStream,
				headers: {
					'content-type': 'application/pdf',
				},
			});

			apiRequestMock
				.mockResolvedValueOnce({
					headers: {
						'x-goog-upload-url': 'https://upload.googleapis.com/upload/123',
					},
				})
				.mockResolvedValueOnce({
					name: 'operations/op123',
					done: true,
				});

			mockExecuteFunctions.helpers.httpRequest.mockResolvedValueOnce({
				body: {
					name: 'operations/op123',
				},
			});

			const result = await uploadToFileSearchStore.call(
				mockExecuteFunctions,
				0,
				fileSearchStoreName,
				displayName,
				'https://example.com/file.pdf',
			);

			expect(result).toBeUndefined();
		});
	});

	describe('listFileSearchStores', () => {
		it('should list file search stores without pagination', async () => {
			const mockResponse = {
				fileSearchStores: [
					{
						name: 'fileSearchStores/store1',
						displayName: 'Store 1',
					},
					{
						name: 'fileSearchStores/store2',
						displayName: 'Store 2',
					},
				],
			};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await listFileSearchStores.call(mockExecuteFunctions);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/fileSearchStores', {
				qs: {},
			});
		});

		it('should list file search stores with pageSize', async () => {
			const mockResponse = {
				fileSearchStores: [
					{
						name: 'fileSearchStores/store1',
						displayName: 'Store 1',
					},
				],
			};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await listFileSearchStores.call(mockExecuteFunctions, 20);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/fileSearchStores', {
				qs: { pageSize: 20 },
			});
		});

		it('should list file search stores with pageToken', async () => {
			const mockResponse = {
				fileSearchStores: [
					{
						name: 'fileSearchStores/store3',
						displayName: 'Store 3',
					},
				],
				nextPageToken: 'token123',
			};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await listFileSearchStores.call(mockExecuteFunctions, undefined, 'token123');

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/fileSearchStores', {
				qs: { pageToken: 'token123' },
			});
		});

		it('should list file search stores with both pageSize and pageToken', async () => {
			const mockResponse = {
				fileSearchStores: [
					{
						name: 'fileSearchStores/store1',
						displayName: 'Store 1',
					},
				],
			};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await listFileSearchStores.call(mockExecuteFunctions, 10, 'token123');

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('GET', '/v1beta/fileSearchStores', {
				qs: { pageSize: 10, pageToken: 'token123' },
			});
		});
	});

	describe('deleteFileSearchStore', () => {
		it('should delete file search store without force', async () => {
			const name = 'fileSearchStores/abc123';
			const mockResponse = {};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await deleteFileSearchStore.call(mockExecuteFunctions, name);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('DELETE', `/v1beta/${name}`, {
				qs: {},
			});
		});

		it('should delete file search store with force', async () => {
			const name = 'fileSearchStores/abc123';
			const mockResponse = {};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await deleteFileSearchStore.call(mockExecuteFunctions, name, true);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('DELETE', `/v1beta/${name}`, {
				qs: { force: true },
			});
		});

		it('should delete file search store with force false', async () => {
			const name = 'fileSearchStores/abc123';
			const mockResponse = {};

			apiRequestMock.mockResolvedValue(mockResponse);

			const result = await deleteFileSearchStore.call(mockExecuteFunctions, name, false);

			expect(result).toEqual(mockResponse);
			expect(apiRequestMock).toHaveBeenCalledWith('DELETE', `/v1beta/${name}`, {
				qs: { force: false },
			});
		});
	});

	describe('schema formatting', () => {
		/**
		 * Test suite for schema transformation to Gemini-compatible format
		 *
		 * Gemini's function calling API doesn't support certain JSON schema keywords:
		 * - Replaces 'const' with 'enum' (Gemini's supported literal syntax)
		 * - Removes 'exclusiveMinimum', 'exclusiveMaximum', 'examples', 'additionalProperties'
		 */

		it('should convert const to enum and remove Gemini-unsupported schema keywords', () => {
			// Arrange
			const schema = {
				type: 'object',
				properties: {
					status: { const: 'ok', default: 'ok', examples: ['ok'] },
					count: { type: 'number', exclusiveMinimum: 0, minimum: 1 },
				},
				additionalProperties: false,
			};

			// Act
			const result = toGeminiCompatibleSchema(schema);

			// Assert: const becomes enum, unsupported keywords are removed
			expect(result).toEqual({
				type: 'object',
				properties: {
					status: { enum: ['ok'] },
					count: { type: 'number', minimum: 1 },
				},
			});
			expect(result).not.toHaveProperty('additionalProperties');
		});

		it('should preserve default and type information while removing unsupported keywords', () => {
			// Arrange: Schema with both supported and unsupported metadata
			const schema = {
				type: 'object',
				properties: {
					status: { const: 'ok', default: 'ok', examples: ['ok'] },
					count: { type: 'number', exclusiveMinimum: 0, minimum: 1 },
					payload: { oneOf: [{ type: 'string' }, { type: 'number' }] },
				},
				additionalProperties: false,
			};

			// Act
			const result = toGeminiCompatibleSchema(schema);

			// Assert
			expect(result).toEqual({
				type: 'object',
				properties: {
					status: { enum: ['ok'] },
					count: { type: 'number', minimum: 1 },
					payload: { oneOf: [{ type: 'string' }, { type: 'number' }] },
				},
			});
			// additionalProperties should be removed
			expect(result).not.toHaveProperty('additionalProperties');
			// examples should be removed
			const statusProps = (result.properties as Record<string, unknown>).status as Record<
				string,
				unknown
			>;
			expect(statusProps).not.toHaveProperty('examples');
		});

		it('should sanitize Gemini tool declarations generated from zod schemas', () => {
			// Arrange
			const tool = {
				name: 'test_schema_tool',
				description: 'schema test',
				schema: z.object({
					state: z.literal('ready'),
					value: z.number().gt(0),
				}),
			} as unknown as Tool;

			// Act
			const declaration = formatToGeminiToolDeclaration(tool);

			// Assert
			expect(declaration.name).toBe('test_schema_tool');
			expect(declaration.description).toBe('schema test');
			expect(declaration.parameters).not.toHaveProperty('additionalProperties');

			const properties = declaration.parameters.properties as Record<string, unknown>;
			expect(properties.state).toEqual(expect.objectContaining({ enum: ['ready'] }));

			// exclusiveMinimum should be removed from number schema
			if (typeof properties.value === 'object' && properties.value !== null) {
				const valueProps = properties.value as Record<string, unknown>;
				expect(valueProps).not.toHaveProperty('exclusiveMinimum');
				expect(valueProps).toHaveProperty('type', 'number');
			}
		});

		it('should handle nested objects with unsupported keywords at multiple levels', () => {
			// Arrange
			const schema = {
				type: 'object',
				properties: {
					user: {
						type: 'object',
						properties: {
							id: { type: 'integer', exclusiveMinimum: 0 },
							email: { type: 'string', examples: ['user@example.com'] },
						},
					},
				},
				additionalProperties: false,
			};

			// Act
			const result = toGeminiCompatibleSchema(schema);

			// Assert
			expect(result.properties.user).toHaveProperty('properties');
			const userProps = (result.properties.user as Record<string, unknown>).properties as Record<
				string,
				Record<string, unknown>
			>;

			expect(userProps.id).not.toHaveProperty('exclusiveMinimum');
			expect(userProps.email).not.toHaveProperty('examples');
		});
	});
});
