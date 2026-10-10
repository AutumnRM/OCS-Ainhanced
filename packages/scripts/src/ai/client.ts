import type { SearchInformation } from '@ocsjs/core';
import type { AIAnswerResponse, AIConfigStatus, AIQuestionInput, AIAnswerContext } from './types';
import { extractAIQuestion } from './media';

const LOCAL_SERVER = 'http://localhost:15319';
const STATUS_TTL_MS = 30000;
// The desktop aborts the upstream request at 35 seconds. Leave a small margin for
// the structured error to reach the userscript instead of waiting indefinitely.
const REQUEST_TIMEOUT_MS = 45000;

interface StructuredErrorBody {
	error?: { code?: string; message?: string; retryable?: boolean };
}

export class LocalAIError extends Error {
	constructor(
		message: string,
		public readonly code = 'local_request_failed',
		public readonly retryable = false,
		public readonly status = 0
	) {
		super(message);
		this.name = 'LocalAIError';
	}
}

let authTokenPromise: Promise<string> | undefined;
let statusCache: { value: AIConfigStatus; expires: number } | undefined;
let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Set<{ abort: () => void }>();

function parseBody(response: any): any {
	if (response?.response && typeof response.response === 'object') return response.response;
	const text = String(response?.responseText || response?.response || '');
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function errorFromResponse(response: any): LocalAIError {
	const body = parseBody(response) as StructuredErrorBody | string | undefined;
	const error = typeof body === 'object' ? body?.error : undefined;
	return new LocalAIError(
		error?.message || (typeof body === 'string' && body) || `桌面端请求失败（HTTP ${response?.status || 0}）`,
		error?.code || 'local_request_failed',
		Boolean(error?.retryable),
		Number(response?.status) || 0
	);
}

function gmRequest<T>(
	path: string,
	opts: { token?: string; data?: Record<string, any>; signal?: AbortSignal; timeout?: number } = {}
): Promise<T> {
	return new Promise((resolve, reject) => {
		if (opts.signal?.aborted) return reject(new LocalAIError('AI 请求已取消。', 'cancelled'));
		if (typeof GM_xmlhttpRequest === 'undefined') {
			return reject(new LocalAIError('当前脚本环境不支持连接桌面端。', 'desktop_unavailable'));
		}
		let settled = false;
		let control: { abort: () => void };
		const onAbort = () => control.abort();
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			opts.signal?.removeEventListener('abort', onAbort);
			inFlight.delete(control);
			fn();
		};
		const request = GM_xmlhttpRequest({
			url: LOCAL_SERVER + path,
			method: opts.data ? 'POST' : 'GET',
			data: opts.data ? JSON.stringify(opts.data) : undefined,
			headers: { 'Content-Type': 'application/json', ...(opts.token ? { 'auth-token': opts.token } : {}) },
			responseType: 'json',
			timeout: opts.timeout ?? REQUEST_TIMEOUT_MS,
			onload: (response: any) =>
				finish(() => {
					if (response.status >= 200 && response.status < 300) resolve(parseBody(response) as T);
					else reject(errorFromResponse(response));
				}),
			onerror: () =>
				finish(() =>
					reject(new LocalAIError('无法连接桌面客户端，请确认客户端正在运行。', 'desktop_unavailable', true))
				),
			onabort: () => finish(() => reject(new LocalAIError('AI 请求已取消。', 'cancelled'))),
			ontimeout: () => finish(() => reject(new LocalAIError('AI 请求超时。', 'timeout', true)))
		} as any);
		control = { abort: () => request.abort() };
		inFlight.add(control);
		opts.signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function getAuthToken(force = false): Promise<string> {
	if (force) authTokenPromise = undefined;
	if (!authTokenPromise) {
		authTokenPromise = gmRequest<string>('/get-actions-key')
			.then(String)
			.catch((error) => {
				authTokenPromise = undefined;
				throw error;
			});
	}
	return authTokenPromise;
}

async function localRequest<T>(path: string, data?: Record<string, any>, signal?: AbortSignal): Promise<T> {
	let token = await getAuthToken();
	try {
		return await gmRequest<T>(path, { token, data, signal });
	} catch (error) {
		// Only refresh stale local auth. Upstream 401 uses the distinct upstream_auth code.
		if (!(error instanceof LocalAIError) || error.code !== 'local_auth') throw error;
		token = await getAuthToken(true);
		return gmRequest<T>(path, { token, data, signal });
	}
}

function cancelInFlight() {
	for (const request of [...inFlight]) request.abort();
}
if (typeof window !== 'undefined') {
	window.addEventListener('pagehide', cancelInFlight);
	window.addEventListener('beforeunload', cancelInFlight);
}

export function invalidateAIStatus() {
	statusCache = undefined;
}

export async function getAIConfigStatus(force = false): Promise<AIConfigStatus> {
	if (!force && statusCache && statusCache.expires > Date.now()) return statusCache.value;
	const value = await localRequest<AIConfigStatus>('/ai/config/status');
	statusCache = { value, expires: Date.now() + STATUS_TTL_MS };
	return value;
}

export async function assertAIReady(): Promise<AIConfigStatus> {
	const status = await getAIConfigStatus(true);
	if (!status.ready) throw new LocalAIError(status.reason || 'AI 尚未完成配置。', 'ai_not_ready');
	return status;
}

function infoError(message: string): SearchInformation {
	return { name: 'AI答题', homepage: '#', results: [], error: message };
}

function humanizeError(error: unknown): string {
	if (!(error instanceof LocalAIError)) return `AI 请求失败：${String(error)}`;
	if (error.code === 'invalid_response') return `AI 响应格式错误：${error.message}`;
	const labels: Record<string, string> = {
		local_auth: '桌面端认证失败，请重启桌面客户端后重试。',
		upstream_auth: 'AI API Key 无效或已过期。',
		rate_limited: 'AI 服务触发限流，请稍后重试。',
		timeout: 'AI 请求超时。',
		cancelled: '页面已离开，AI 请求已取消。',
		desktop_unavailable: '无法连接桌面客户端，请确认客户端正在运行。'
	};
	return labels[error.code] || error.message;
}

export function formatAIAnswers(type: AIQuestionInput['type'], answers: string[]): string[] {
	return type === 'completion' || type === 'essay' ? answers : [JSON.stringify(answers)];
}

async function executeAIAnswer(title: HTMLElement[], context: AIAnswerContext): Promise<SearchInformation> {
	const startURL = window.location.href;
	const rootWasConnected = Boolean(context.root?.isConnected);
	const status = await assertAIReady();
	let payload: AIQuestionInput | { unavailable: string };
	try {
		const titleElements = title.length
			? title
			: context.question
			? [Object.assign(document.createElement('span'), { innerText: context.question })]
			: [];
		payload = await extractAIQuestion({
			type: context.type,
			title: titleElements,
			options: context.options,
			root: context.root
		});
	} catch (error) {
		return infoError(`题目提取失败：${String(error)}`);
	}
	if ('unavailable' in payload) return infoError(payload.unavailable);
	const questionInput = payload as AIQuestionInput;
	if (window.location.href !== startURL || (rootWasConnected && !context.root?.isConnected)) {
		return infoError('页面或题目已切换，AI 请求已取消。');
	}
	const controller = new AbortController();
	const cancel = () => controller.abort();
	window.addEventListener('hashchange', cancel);
	window.addEventListener('pagehide', cancel);
	const observedRoot = context.root?.isConnected ? context.root : undefined;
	const observer = observedRoot
		? new MutationObserver(() => {
				if (!observedRoot.isConnected) cancel();
		  })
		: undefined;
	observer?.observe(document.documentElement, { childList: true, subtree: true });

	try {
		const answer = await localRequest<AIAnswerResponse>('/ai/responses', questionInput as any, controller.signal);
		if (!answer?.can_answer || !Array.isArray(answer.answers) || answer.answers.length === 0) {
			return infoError('AI 拒绝回答或无法确定答案。');
		}
		const confidence = Number.isFinite(Number(answer.confidence))
			? Math.max(0, Math.min(1, Number(answer.confidence)))
			: 0;
		const resultAnswers = formatAIAnswers(questionInput.type, answer.answers);
		return {
			name: 'AI答题',
			homepage: '#',
			results: resultAnswers.map((resultAnswer) => ({
				question: questionInput.question,
				answer: resultAnswer,
				extra_data: { ai: true, confidence, aiConfigFingerprint: status.configFingerprint }
			}))
		};
	} catch (error) {
		return infoError(humanizeError(error));
	} finally {
		observer?.disconnect();
		window.removeEventListener('hashchange', cancel);
		window.removeEventListener('pagehide', cancel);
	}
}

/** AI is the only answer source. Calls are serialized and never cached. */
export async function requestAIAnswer(title: HTMLElement[], context: AIAnswerContext) {
	const originalURL = window.location.href;
	const wasConnected = Boolean(context.root?.isConnected);
	const task = queue.then(() => {
		if (window.location.href !== originalURL || (wasConnected && !context.root?.isConnected)) {
			return infoError('页面或题目已切换，AI 请求已取消。');
		}
		return executeAIAnswer(title, context);
	});
	queue = task.catch(() => undefined);
	return { info: await task, attempted: true as const };
}

export async function requestAIAnswerInfos(
	title: HTMLElement[],
	context: AIAnswerContext
): Promise<SearchInformation[]> {
	return [(await requestAIAnswer(title, context)).info];
}
