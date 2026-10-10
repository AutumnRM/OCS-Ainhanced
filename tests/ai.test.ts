import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// browser-env 提供最小 DOM，用于验证题目图片、track 和字幕提取。
// @ts-ignore 该旧版测试依赖没有发布 TypeScript 声明。
import browserEnv from '../packages/scripts/node_modules/browser-env';
import { defaultWorkTypeResolver } from '../packages/core/src/core/worker/utils';
import {
	buildResponsesPayload,
	describeAIResponseShape,
	getMaxOutputTokensForQuestion,
	normalizeImages,
	parseAIAnswer,
	shouldRetryAIStatus
} from '../ocs-desktop/packages/app/src/ai.protocol';
import { resolveCompletion } from '../packages/core/src/core/worker/resolvers/completion';
import { resolveJudgement } from '../packages/core/src/core/worker/resolvers/judgement';
import { resolveMultiple } from '../packages/core/src/core/worker/resolvers/multiple';
import { resolveSingle } from '../packages/core/src/core/worker/resolvers/single';
import { extractAIQuestion, MAX_DATA_URL_CHARS, MAX_TOTAL_IMAGE_CHARS } from '../packages/scripts/src/ai/media';

browserEnv();

function response(text: string, ok = true) {
	return {
		ok,
		blob: async () => new Blob(['not an image'], { type: 'text/plain' }),
		text: async () => text
	};
}

async function testResponsesProtocol() {
	const payload = buildResponsesPayload(
		{ modelId: 'deepseek-flash', extraInstructions: '优先使用教材术语。' },
		{
			type: 'multiple',
			question: '哪些属于输入设备？',
			options: ['键盘', '显示器'],
			images: [{ type: 'input_image', image_url: 'https://example.com/question.png' }],
			mediaText: '页面转写文本'
		}
	);
	assert.equal(payload.model, 'deepseek-flash');
	assert.equal(payload.store, false);
	assert.equal(payload.reasoning.effort, 'low');
	assert.equal(payload.max_output_tokens, 768);
	assert.match(payload.instructions, /优先使用教材术语/);
	assert.equal(payload.text.format.type, 'json_schema');
	assert.equal(payload.text.format.name, 'ocs_answer');
	assert.equal(payload.input[0].content[0].type, 'input_text');
	assert.equal(payload.input[0].content[1].type, 'input_image');
	assert.equal(JSON.stringify(payload).includes('apiKey'), false);
	assert.equal(getMaxOutputTokensForQuestion('completion'), 2048);
	assert.equal(getMaxOutputTokensForQuestion('unknown'), undefined);
	assert.equal(getMaxOutputTokensForQuestion('essay'), undefined);
	const unknownPayload = buildResponsesPayload(
		{ modelId: 'deepseek-flash' },
		{ type: 'unknown', question: '请简述原理。', options: [], images: [] }
	);
	assert.equal('max_output_tokens' in unknownPayload, false);

	const valid = parseAIAnswer({
		status: 'completed',
		output_text: JSON.stringify({ can_answer: true, answers: ['A', 'C'], confidence: 0.86 })
	});
	assert.deepEqual(valid, { can_answer: true, answers: ['A', 'C'], confidence: 0.86 });
	const finalText = JSON.stringify({ can_answer: true, answers: ['B'], confidence: 0.9 });
	assert.deepEqual(
		parseAIAnswer({
			output_text: '',
			output: [
				{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '{this is reasoning, not JSON}' }] },
				{ type: 'message', content: [{ type: 'output_text', text: finalText }] }
			]
		}),
		{ can_answer: true, answers: ['B'], confidence: 0.9 }
	);
	assert.throws(
		() => parseAIAnswer({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: finalText }] }] }),
		/没有返回可解析/
	);
	for (const [html, expected] of [
		['<li><input type="radio">北京</li><li><input type="radio">上海</li>', 'single'],
		['<li><input type="radio">对</li><li><input type="radio">错</li>', 'judgement'],
		['<li><input type="checkbox">A</li><li><input type="checkbox">B</li>', 'multiple'],
		['<textarea></textarea>', 'completion'],
		['<input type="text">', 'completion'],
		['<div contenteditable="true"></div>', 'completion']
	]) {
		const root = document.createElement('div');
		root.innerHTML = html;
		assert.equal(defaultWorkTypeResolver({ elements: { options: Array.from(root.children) } } as any), expected);
	}

	const refusal = () =>
		parseAIAnswer({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: '无法判断' }] }] });
	assert.throws(refusal, /模型拒答/);
	assert.throws(() => parseAIAnswer({ status: 'incomplete' }), /响应不完整/);
	assert.deepEqual(
		parseAIAnswer({
			status: 'incomplete',
			incomplete_details: { reason: 'max_output_tokens' },
			output_text: '{"can_answer":true,"answers":["B"],"confidence":0.7}'
		}),
		{ can_answer: true, answers: ['B'], confidence: 0.7 }
	);
	assert.deepEqual(parseAIAnswer({ output_parsed: { can_answer: true, answers: ['C'], confidence: 0.8 } }), {
		can_answer: true,
		answers: ['C'],
		confidence: 0.8
	});
	assert.deepEqual(parseAIAnswer({ choices: [{ message: { content: '答案：A、C' } }] }), {
		can_answer: true,
		answers: ['A', 'C'],
		confidence: 0.5
	});
	assert.match(
		describeAIResponseShape({
			status: 'incomplete',
			incomplete_details: { reason: 'max_output_tokens' },
			output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }]
		}),
		/status=incomplete, incomplete=max_output_tokens, output_text=0, output=message, content=output_text/
	);
	assert.throws(() => parseAIAnswer({ output_text: '{bad json' }), /JSON 无法解析/);
	assert.throws(
		() => parseAIAnswer({ output_text: JSON.stringify({ can_answer: true, answers: ['A'], confidence: 2 }) }),
		/confidence/
	);
	assert.deepEqual(
		parseAIAnswer({
			output: [{ content: [{ type: 'output_text', text: '{"can_answer":false,"answers":[],"confidence":0}' }] }]
		}),
		{ can_answer: false, answers: [], confidence: 0 }
	);

	assert.equal(shouldRetryAIStatus(429), true);
	assert.equal(shouldRetryAIStatus(401), false);
	assert.equal(shouldRetryAIStatus(500), true);
	assert.equal(shouldRetryAIStatus(503), true);
	assert.equal(shouldRetryAIStatus(400), false);

	// AI 返回的答案仍然交给原有四类 resolver，不绕过现有自动保存/提交链路。
	assert.equal(resolveSingle(['A'], ['选项A', '选项B']).finish, true);
	assert.equal(resolveMultiple(['["A", "C"]'], ['A', 'B', 'C']).finish, true);
	assert.equal(resolveJudgement([['正确']], ['正确', '错误']).finish, true);
	assert.deepEqual(resolveCompletion([['答案一', '答案二']], 2).answers, ['答案一', '答案二']);
}

async function testLocalClientAuthTimeoutAndCancellation() {
	type Handler = (options: any) => { abort: () => void };
	const originalGM = (globalThis as any).GM_xmlhttpRequest;
	try {
		let call = 0;
		(globalThis as any).GM_xmlhttpRequest = ((options: any) => {
			call++;
			const current = call;
			queueMicrotask(() => {
				if (current === 1) options.onload({ status: 200, responseText: 'old-token' });
				else if (current === 2)
					options.onload({
						status: 401,
						response: { error: { code: 'local_auth', message: 'expired', retryable: true } }
					});
				else if (current === 3) options.onload({ status: 200, responseText: 'new-token' });
				else
					options.onload({
						status: 200,
						response: {
							enabled: true,
							configured: true,
							ready: true,
							reason: '',
							protocol: 'responses',
							endpointConfigured: true,
							keyConfigured: true,
							modelId: 'test'
						}
					});
			});
			return { abort: () => options.onabort?.() };
		}) satisfies Handler;

		const client = await import('../packages/scripts/src/ai/client');
		assert.deepEqual(client.formatAIAnswers('completion', ['答案一', '答案二']), ['答案一', '答案二']);
		assert.deepEqual(client.formatAIAnswers('multiple', ['A', 'C']), ['["A","C"]']);
		const status = await client.getAIConfigStatus(true);
		assert.equal(status.ready, true);
		assert.equal(call, 4, 'local_auth should refresh the desktop token exactly once');

		(globalThis as any).GM_xmlhttpRequest = ((options: any) => {
			queueMicrotask(() => options.ontimeout());
			return { abort: () => options.onabort?.() };
		}) satisfies Handler;
		await assert.rejects(
			() => client.getAIConfigStatus(true),
			(error: any) => error.code === 'timeout'
		);

		let markCancelRequestStarted: (() => void) | undefined;
		const cancelRequestStarted = new Promise<void>((resolve) => (markCancelRequestStarted = resolve));
		(globalThis as any).GM_xmlhttpRequest = ((options: any) => {
			markCancelRequestStarted?.();
			return { abort: () => options.onabort?.() };
		}) satisfies Handler;
		const pending = client.getAIConfigStatus(true);
		await cancelRequestStarted;
		window.dispatchEvent(new window.Event('pagehide'));
		await assert.rejects(
			() => pending,
			(error: any) => error.code === 'cancelled'
		);
		for (const navigation of ['remove-root', 'hashchange']) {
			const root = document.createElement('div');
			root.innerHTML = '<h3>取消测试题</h3>';
			document.body.append(root);
			let started: () => void;
			const startedPromise = new Promise<void>((resolve) => started = resolve);
			(globalThis as any).GM_xmlhttpRequest = ((options: any) => {
				if (options.url.endsWith('/ai/config/status')) {
					queueMicrotask(() => options.onload({ status: 200, response: { ready: true } }));
				} else started();
				return { abort: () => options.onabort?.() };
			}) satisfies Handler;
			const answerPromise = client.requestAIAnswerInfos([root.querySelector('h3')], { root, type: 'single' });
			await startedPromise;
			if (navigation === 'remove-root') root.remove();
			else window.dispatchEvent(new window.Event('hashchange'));
			const infos = await answerPromise;
			assert.match(infos[0].error || '', /已取消/);
			root.remove();
		}
	} finally {
		(globalThis as any).GM_xmlhttpRequest = originalGM;
	}
}

async function testImageAndSubtitleExtraction() {
	const originalFetch = globalThis.fetch;
	try {
		const title = document.createElement('div');
		title.innerHTML = '题目：下列哪个是正确答案？<img src="data:image/png;base64,AAAA" alt="公式图">';
		const option = document.createElement('div');
		option.innerHTML = '选项 A <img src="https://example.com/option.png">';
		const root = document.createElement('div');
		root.append(title, option);
		globalThis.fetch = (async () => {
			throw new Error('跨域读取失败');
		}) as typeof fetch;
		const imagePayload = await extractAIQuestion({ type: 'single', title: [title], options: [option], root });
		assert.ok(!('unavailable' in imagePayload));
		assert.equal(imagePayload.images.length, 2);
		assert.equal(imagePayload.images[0].image_url, 'data:image/png;base64,AAAA');
		assert.equal(imagePayload.images[1].image_url, 'https://example.com/option.png');
		assert.match(imagePayload.question, /题目/);
		assert.doesNotMatch(imagePayload.question, /option\.png/);

		const oversized = document.createElement('div');
		oversized.innerHTML = `<img src="data:image/png;base64,${'a'.repeat(MAX_DATA_URL_CHARS)}">`;
		const oversizedPayload = await extractAIQuestion({ type: 'single', title: [oversized], root: oversized });
		assert.ok(!('unavailable' in oversizedPayload));
		assert.equal(oversizedPayload.images.length, 0);

		const videoRoot = document.createElement('div');
		videoRoot.innerHTML = '<video><track src="/captions.vtt"></video>';
		const videoTitle = document.createElement('div');
		videoTitle.textContent = '视频题';
		globalThis.fetch = (async (url: RequestInfo | URL) => {
			assert.match(String(url), /captions\.vtt/);
			return response('WEBVTT\n\n00:00.000 --> 00:01.000\n字幕答案');
		}) as typeof fetch;
		const subtitlePayload = await extractAIQuestion({ type: 'single', title: [videoTitle], root: videoRoot });
		assert.ok(!('unavailable' in subtitlePayload));
		assert.equal(subtitlePayload.mediaText, '字幕答案');

		const noSubtitleRoot = document.createElement('div');
		noSubtitleRoot.innerHTML = '<audio src="https://example.com/a.mp3"></audio>';
		const noSubtitlePayload = await extractAIQuestion({ type: 'single', title: [videoTitle], root: noSubtitleRoot });
		assert.match('unavailable' in noSubtitlePayload ? noSubtitlePayload.unavailable : '', /不直接上传音视频/);
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function testImageLimits() {
	const images = Array.from({ length: 10 }, (_, index) => ({
		type: 'input_image' as const,
		image_url: `https://example.com/${index}`
	}));
	assert.equal(normalizeImages(images).length, 6);
	assert.equal(
		normalizeImages([{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(MAX_TOTAL_IMAGE_CHARS)}` }])
			.length,
		0
	);
}

async function testSequentialWorker() {
	const { OCSWorker } = await import('../packages/core/src/core/worker/worker');
	const container = document.createElement('div');
	container.innerHTML = Array.from(
		{ length: 3 },
		(_, i) => `<div class="mock-question"><h3>题目${i}</h3><textarea></textarea></div>`
	).join('');
	document.body.append(container);
	const events: string[] = [];
	const worker = new OCSWorker({
		root: Array.from(container.children) as HTMLElement[],
		elements: { title: 'h3', options: 'textarea' },
		sequential: true,
		answerer: async (_, ctx) => {
			const name = ctx.elements.title[0].textContent;
			events.push(`request:${name}`);
			if (name === '题目1') throw new Error('模拟上游超时');
			return [{ name: 'AI', results: [{ question: name, answer: '填写内容' }] }];
		},
		work: {
			type: 'completion',
			handler: (_, answer, option, ctx) => {
				events.push(`fill:${ctx.elements.title[0].textContent}`);
				(option as HTMLTextAreaElement).value = answer;
			}
		}
	});
	try {
		const results = await worker.doWork();
		assert.deepEqual(events, ['request:题目0', 'fill:题目0', 'request:题目1', 'request:题目2', 'fill:题目2']);
		assert.match(results[1].error || '', /模拟上游超时/);
		assert.deepEqual(
			results.map((r) => r.result?.finish),
			[true, false, true]
		);
		assert.equal(worker.isRunning, false);
	} finally {
		container.remove();
	}
}

async function testAIOnlyPlatformSources() {
	const platforms = ['cx.ts', 'zhs.ts', 'zjy.ts', 'icve.ts', 'icourse.ts', 'unipus/exploration.ts'];
	for (const platform of platforms) {
		const source = readFileSync(new URL(`../packages/scripts/src/projects/${platform}`, import.meta.url), 'utf8');
		assert.match(source, /requestAIAnswerInfos/, `${platform} should use the shared AI-only answer source`);
		assert.doesNotMatch(
			source,
			/defaultAnswerWrapperHandler|searchAnswerInCaches|answererWrappers|aiFallback|addQuestionCacheFromWorkResult/
		);
	}
	const mooc = readFileSync(new URL('../packages/scripts/src/projects/icourse.ts', import.meta.url), 'utf8');
	assert.match(mooc, /\.inputArea textarea/);
	assert.match(mooc, /fillMOOCBlank/);
	assert.match(mooc, /selectMOOCOption/);
	const common = readFileSync(new URL('../packages/scripts/src/projects/common.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(common, /onlineSearch|localQuestionCaches|题库配置|题库缓存/);
}

Promise.all([
	testResponsesProtocol(),
	testImageAndSubtitleExtraction(),
	testImageLimits(),
	testLocalClientAuthTimeoutAndCancellation(),
	testAIOnlyPlatformSources(),
	testSequentialWorker()
])
	.then(() => console.log('AI tests passed'))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
