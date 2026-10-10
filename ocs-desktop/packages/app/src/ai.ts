import axios from 'axios';
import { decryptRenderString, encryptRenderString } from './crypto';
import { store } from './store';
import {
	AIAnswerResponse,
	AIQuestionInput,
	DEFAULT_MODEL_ID,
	buildResponsesPayload,
	describeAIResponseShape,
	parseAIAnswer
} from './ai.protocol';
import { shouldRetryAIStatus } from './ai.protocol';
import { createHash } from 'crypto';

export type { AIAnswerResponse, AIImageInput, AIQuestionInput } from './ai.protocol';

export interface AIConfigInput {
	enabled?: boolean;
	endpoint?: string;
	modelId?: string;
	extraInstructions?: string;
	apiKey?: string;
	clearApiKey?: boolean;
}

const REQUEST_TIMEOUT_MS = 35000;
const MAX_INSTRUCTIONS_LENGTH = 8000;

export class AIServiceError extends Error {
	constructor(
		public code: string,
		message: string,
		public retryable = false,
		public status = 502
	) {
		super(message);
		this.name = 'AIServiceError';
	}
}

function config() {
	return store.store.ai;
}

function getApiKey(): string {
	const encrypted = config()?.apiKeyEncrypted;
	return encrypted ? decryptRenderString(encrypted) : '';
}

function validateEndpoint(endpoint: string): string {
	const value = String(endpoint || '').trim();
	if (!value) throw new Error('请先填写 Responses API 请求地址。');
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('AI 请求地址格式错误。');
	}
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new Error('AI 请求地址必须是不含账号密码的 HTTP(S) 地址。');
	}
	return value;
}

function publicConfig() {
	const current = config();
	return {
		enabled: Boolean(current?.enabled),
		endpoint: current?.endpoint || '',
		modelId: current?.modelId || DEFAULT_MODEL_ID,
		extraInstructions: current?.extraInstructions || '',
		keyConfigured: Boolean(current?.apiKeyEncrypted),
		configFingerprint: getConfigFingerprint()
	};
}

function getConfigFingerprint(): string {
	const current = config();
	return createHash('sha256')
		.update(
			[
				current?.endpoint || '',
				current?.modelId || DEFAULT_MODEL_ID,
				current?.extraInstructions || '',
				current?.apiKeyEncrypted || ''
			].join('\0')
		)
		.digest('hex')
		.slice(0, 24);
}

export function getAIConfig() {
	return publicConfig();
}

export function getAIConfigStatus() {
	const current = publicConfig();
	let reason = '';
	if (!current.enabled) reason = 'AI 答题尚未启用。';
	else if (!current.endpoint) reason = '尚未填写 Responses API 地址。';
	else if (!current.modelId) reason = '尚未选择模型。';
	else if (!current.keyConfigured) reason = '尚未保存 API Key。';
	return {
		enabled: current.enabled,
		configured: !reason,
		ready: !reason,
		reason,
		protocol: 'responses' as const,
		endpointConfigured: Boolean(current.endpoint),
		keyConfigured: current.keyConfigured,
		modelId: current.modelId,
		configFingerprint: current.configFingerprint
	};
}

function getModelsEndpoint(endpoint: string): string {
	const url = new URL(validateEndpoint(endpoint));
	if (/\/(responses|chat\/completions)\/?$/i.test(url.pathname)) {
		url.pathname = url.pathname.replace(/\/(responses|chat\/completions)\/?$/i, '/models');
	} else {
		url.pathname = url.pathname.replace(/\/?$/, '/models');
	}
	return url.toString();
}

/** 获取上游模型列表，只返回公开的模型元数据，不返回 API Key。 */
export async function listAIModels(): Promise<{ id: string; name?: string }[]> {
	const endpoint = validateEndpoint(config()?.endpoint || '');
	const apiKey = getApiKey();
	if (!apiKey) throw new Error('请先填写 API Key。');
	const response = await axios.get(getModelsEndpoint(endpoint), {
		timeout: REQUEST_TIMEOUT_MS,
		validateStatus: () => true,
		headers: { Authorization: `Bearer ${apiKey}` }
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(safeErrorMessage(response.data, response.status, apiKey));
	}
	const items = Array.isArray(response.data?.data)
		? response.data.data
		: Array.isArray(response.data)
		? response.data
		: [];
	return items
		.map((item: any) => {
			const id = typeof item === 'string' ? item : item?.id;
			return typeof id === 'string' && id.trim() ? { id: id.trim(), name: item?.name } : undefined;
		})
		.filter(Boolean)
		.slice(0, 200) as { id: string; name?: string }[];
}

export function saveAIConfig(input: AIConfigInput) {
	const current = config();
	const next = {
		enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
		endpoint: input.endpoint === undefined ? current.endpoint : String(input.endpoint).trim(),
		modelId: input.modelId === undefined ? current.modelId || DEFAULT_MODEL_ID : String(input.modelId).trim(),
		extraInstructions:
			input.extraInstructions === undefined
				? current.extraInstructions || ''
				: String(input.extraInstructions).slice(0, MAX_INSTRUCTIONS_LENGTH),
		apiKeyEncrypted: current.apiKeyEncrypted || ''
	};
	if (input.apiKey !== undefined && String(input.apiKey).trim()) {
		next.apiKeyEncrypted = encryptRenderString(String(input.apiKey).trim());
	} else if (input.clearApiKey) {
		next.apiKeyEncrypted = '';
	}
	store.set('ai', next);
	return getAIConfigStatus();
}

export function clearAIKey() {
	const current = config();
	store.set('ai', { ...current, apiKeyEncrypted: '' });
	return getAIConfigStatus();
}

function redactSecret(message: string, apiKey = ''): string {
	let safe = message;
	if (apiKey) safe = safe.split(apiKey).join('[REDACTED]');
	return safe.replace(/(authorization\s*:\s*bearer\s+)\S+/gi, '$1[REDACTED]');
}

function safeErrorMessage(data: any, status: number, apiKey = ''): string {
	const message = data?.error?.message || data?.error || data?.message;
	return redactSecret(String(message || `上游 AI 服务返回 HTTP ${status}`), apiKey).slice(0, 500);
}

async function sendRequest(endpoint: string, apiKey: string, payload: any, signal?: AbortSignal): Promise<any> {
	if (signal?.aborted) throw new AIServiceError('cancelled', 'AI 请求已取消。', false, 499);
	let response: { status: number; data: any };
	try {
		response = await axios.post(endpoint, payload, {
			timeout: REQUEST_TIMEOUT_MS,
			validateStatus: () => true,
			signal,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			}
		});
	} catch (error: any) {
		if (signal?.aborted || error?.code === 'ERR_CANCELED') {
			throw new AIServiceError('cancelled', 'AI 请求已取消。', false, 499);
		}
		const message = error instanceof Error ? error.message : String(error);
		const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
		throw new AIServiceError(
			timedOut ? 'timeout' : 'network_error',
			redactSecret(message, apiKey),
			!timedOut
		);
	}

	if (response.status >= 200 && response.status < 300) return response.data;
	throw new AIServiceError(
		response.status === 401 || response.status === 403
			? 'upstream_auth'
			: response.status === 429
			? 'rate_limited'
			: response.status >= 500
			? 'upstream_unavailable'
			: 'upstream_rejected',
		safeErrorMessage(response.data, response.status, apiKey),
		shouldRetryAIStatus(response.status),
		response.status
	);
}

export async function createAIResponse(
	input: AIQuestionInput,
	allowWhenDisabled = false,
	signal?: AbortSignal
): Promise<AIAnswerResponse> {
	const status = getAIConfigStatus();
	if (
		!status.configured &&
		!(allowWhenDisabled && status.endpointConfigured && status.keyConfigured && status.modelId)
	) {
		throw new AIServiceError('not_configured', status.reason || 'AI 尚未完成配置。', false, 400);
	}
	const endpoint = validateEndpoint(config().endpoint);
	const apiKey = getApiKey();
	const data = await sendRequest(endpoint, apiKey, buildResponsesPayload(config(), input), signal);
	try {
		return parseAIAnswer(data);
	} catch (error: any) {
		throw new AIServiceError(
			'invalid_response',
			`${String(error?.message || error)}（${describeAIResponseShape(data)}）`,
			false,
			502
		);
	}
}

export async function testAIConnection(): Promise<AIAnswerResponse> {
	return createAIResponse(
		{
			type: 'single',
			question: '请选择唯一正确的测试选项。',
			options: ['测试选项'],
			images: []
		},
		true
	);
}
