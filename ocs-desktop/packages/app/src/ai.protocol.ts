export interface AIImageInput {
	type: 'input_image';
	image_url: string;
	detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface AIQuestionInput {
	type: string;
	question: string;
	options: string[];
	images?: AIImageInput[];
	mediaText?: string;
}

export interface AIAnswerResponse {
	can_answer: boolean;
	answers: string[];
	confidence: number;
}

export const DEFAULT_MODEL_ID = '';
export const MAX_IMAGE_COUNT = 6;
export const MAX_DATA_URL_CHARS = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_CHARS = 8 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_URL_CHARS = 8192;

export function shouldRetryAIStatus(status: number): boolean {
	return status === 429 || (status >= 500 && status < 600);
}

export const BASE_INSTRUCTIONS = `你是一个严格的网课题目答题器。结合题干、选项、图片、转写文本以及可靠的学科知识作答，不编造题目未给出的条件。直接给出答案。
必须只输出符合 JSON Schema 的 JSON，不输出 Markdown、解释、思维链或其他文字。
单选题、判断题返回一个答案；多选题返回全部答案；填空题按空格顺序返回答案。
选择题优先返回选项原文，也可以返回明确的选项字母。无法可靠判断时将 can_answer 设为 false，answers 设为空数组。`;

export const ANSWER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		can_answer: { type: 'boolean' },
		answers: {
			type: 'array',
			items: { type: 'string' }
		},
		confidence: { type: 'number', minimum: 0, maximum: 1 }
	},
	required: ['can_answer', 'answers', 'confidence']
};

export function normalizeImages(images: AIImageInput[] = []): AIImageInput[] {
	let totalChars = 0;
	const normalized: AIImageInput[] = [];

	for (const image of images) {
		if (!image || image.type !== 'input_image' || typeof image.image_url !== 'string') continue;
		const source = image.image_url;
		const isDataUrl = /^data:image\/[a-z0-9.+-]+;base64,/i.test(source);
		if (isDataUrl) {
			if (source.length > MAX_DATA_URL_CHARS) continue;
		} else {
			try {
				const url = new URL(source);
				if (url.protocol !== 'https:' || source.length > MAX_REMOTE_IMAGE_URL_CHARS) continue;
			} catch {
				continue;
			}
		}

		if (totalChars + source.length > MAX_TOTAL_IMAGE_CHARS) break;
		normalized.push({ type: 'input_image', image_url: source, detail: image.detail || 'auto' });
		totalChars += source.length;
		if (normalized.length >= MAX_IMAGE_COUNT) break;
	}

	return normalized;
}

export function getMaxOutputTokensForQuestion(type: string): number | undefined {
	const normalized = String(type || 'unknown').toLowerCase();
	if (normalized === 'single' || normalized === 'multiple' || normalized === 'judgement') return 768;
	if (normalized === 'completion') return 2048;
	// Essay/short-answer questions and unrecognized types must not be truncated by
	// a client-side output cap. The provider/model remains responsible for its own limit.
	return undefined;
}

export function buildResponsesPayload(
	config: { modelId?: string; extraInstructions?: string },
	input: AIQuestionInput
) {
	const maxOutputTokens = getMaxOutputTokensForQuestion(input.type);
	const questionText = [
		`题型：${input.type || 'unknown'}`,
		`题干：\n${String(input.question || '').trim()}`,
		input.options?.length
			? `选项：\n${input.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option}`).join('\n')}`
			: '',
		input.mediaText ? `媒体转写：\n${input.mediaText}` : ''
	]
		.filter(Boolean)
		.join('\n\n');

	return {
		model: config.modelId || DEFAULT_MODEL_ID,
		instructions: [BASE_INSTRUCTIONS, config.extraInstructions || ''].filter(Boolean).join('\n\n'),
		input: [
			{
				role: 'user',
				content: [{ type: 'input_text', text: questionText }, ...normalizeImages(input.images)]
			}
		],
		store: false,
		reasoning: { effort: 'low' as const },
		...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
		text: {
			format: {
				type: 'json_schema',
				name: 'ocs_answer',
				strict: true,
				schema: ANSWER_SCHEMA
			}
		}
	};
}

export function extractResponsesOutputText(data: any): string {
	const refusal = (Array.isArray(data?.output) ? data.output : [])
		.flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
		.find((content: any) => content?.type === 'refusal');
	if (refusal) throw new Error(`模型拒答：${String(refusal.refusal || '未提供原因')}`);

	if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
	const chunks: string[] = [];
	for (const item of Array.isArray(data?.output) ? data.output : []) {
		// Reasoning is not the answer, even when a compatible provider exposes text.
		if (item?.type && item.type !== 'message') continue;
		for (const content of Array.isArray(item?.content) ? item.content : []) {
			if (content?.type !== 'output_text') continue;
			if (typeof content?.text === 'string') chunks.push(content.text);
			else if (typeof content?.text?.value === 'string') chunks.push(content.text.value);
		}
	}
	// 兼容部分“Responses API 兼容”服务实际返回 Chat Completions 格式。
	const choiceContent = data?.choices?.[0]?.message?.content;
	if (typeof choiceContent === 'string') chunks.push(choiceContent);
	else if (choiceContent && typeof choiceContent === 'object' && !Array.isArray(choiceContent)) {
		chunks.push(JSON.stringify(choiceContent));
	} else if (Array.isArray(choiceContent)) {
		for (const item of choiceContent) {
			if (typeof item?.text === 'string') chunks.push(item.text);
		}
	}
	if (typeof data?.text === 'string') chunks.push(data.text);
	if (!chunks.length) throw new Error('Responses API 没有返回可解析的文本。');
	return chunks.join('\n');
}

function normalizeParsedAnswer(parsed: any): AIAnswerResponse | undefined {
	if (Array.isArray(parsed)) {
		const answers = parsed
			.map((answer) => String(answer).trim())
			.filter(Boolean)
			.slice(0, 32);
		return { can_answer: answers.length > 0, answers, confidence: answers.length ? 0.5 : 0 };
	}
	if (typeof parsed === 'string' && parsed.trim()) {
		return { can_answer: true, answers: [parsed.trim()], confidence: 0.5 };
	}
	if (typeof parsed?.can_answer !== 'boolean' || !Array.isArray(parsed.answers)) return undefined;
	const answers = parsed.answers
		.map((answer: any) => String(answer).trim())
		.filter(Boolean)
		.slice(0, 32);
	const confidence = Number(parsed.confidence);
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		throw new Error('模型返回的 confidence 不在 0 到 1 之间。');
	}
	return {
		can_answer: parsed.can_answer && answers.length > 0,
		answers: parsed.can_answer && answers.length > 0 ? answers : [],
		confidence
	};
}

function parseLooseAnswerText(text: string): AIAnswerResponse | undefined {
	const cleaned = text
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.replace(/^\s*```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	const labelled = cleaned.match(/(?:答案|answer)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
	if (!labelled) return undefined;
	const compact = labelled.replace(/[。.]$/, '').trim();
	const plainLetters = compact.replace(/[\s,，、;；|]+/g, '').toUpperCase();
	const answers = /^[A-Z]{1,32}$/.test(plainLetters)
		? plainLetters.split('')
		: compact
				.split(/\s*(?:,|，|、|;|；|\||\n)\s*/)
				.map((answer) => answer.trim())
				.filter(Boolean)
				.slice(0, 32);
	return answers.length ? { can_answer: true, answers, confidence: 0.5 } : undefined;
}

export function describeAIResponseShape(data: any): string {
	const outputTypes = (Array.isArray(data?.output) ? data.output : [])
		.map((item: any) => String(item?.type || 'unknown'))
		.slice(0, 8)
		.join(',');
	const contentTypes = (Array.isArray(data?.output) ? data.output : [])
		.flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
		.map((item: any) => String(item?.type || typeof item))
		.slice(0, 12)
		.join(',');
	return [
		`status=${String(data?.status || 'unknown')}`,
		data?.incomplete_details?.reason ? `incomplete=${String(data.incomplete_details.reason)}` : '',
		`output_text=${typeof data?.output_text === 'string' ? data.output_text.length : 0}`,
		outputTypes ? `output=${outputTypes}` : '',
		contentTypes ? `content=${contentTypes}` : '',
		data?.choices?.[0]?.message ? `choice_content=${typeof data.choices[0].message.content}` : ''
	]
		.filter(Boolean)
		.join(', ');
}

function parseJSONFromModelText(text: string): any {
	const cleaned = text
		.replace(/<think>[\s\S]*?<\/think>/gi, '')
		.replace(/^\s*```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	try {
		return JSON.parse(cleaned);
	} catch {
		// 某些兼容服务仍会在 JSON 前后附带一句说明，截取最外层对象再解析。
		const start = cleaned.indexOf('{');
		const end = cleaned.lastIndexOf('}');
		if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
		throw new Error('模型返回的 JSON 无法解析。');
	}
}

export function parseAIAnswer(data: any): AIAnswerResponse {
	if (data?.status === 'failed') throw new Error('模型响应失败。');
	const directlyParsed =
		data?.output_parsed ?? data?.parsed ?? data?.choices?.[0]?.message?.parsed ?? data?.response?.parsed;
	if (directlyParsed !== undefined) {
		const normalized = normalizeParsedAnswer(directlyParsed);
		if (normalized) return normalized;
	}

	let text: string;
	try {
		text = extractResponsesOutputText(data);
	} catch (error) {
		if (data?.status === 'incomplete') {
			throw new Error(`模型响应不完整：${String(data?.incomplete_details?.reason || '没有可用正文')}。`);
		}
		throw error;
	}
	let parsed: any;
	try {
		parsed = parseJSONFromModelText(text);
	} catch {
		const loose = parseLooseAnswerText(text);
		if (loose) return loose;
		if (data?.status === 'incomplete') {
			throw new Error(`模型响应不完整：${String(data?.incomplete_details?.reason || '正文被截断')}。`);
		}
		throw new Error('模型返回的 JSON 无法解析。');
	}
	const normalized = normalizeParsedAnswer(parsed);
	if (!normalized) {
		throw new Error('模型返回缺少 can_answer 或 answers 字段。');
	}
	return normalized;
}
