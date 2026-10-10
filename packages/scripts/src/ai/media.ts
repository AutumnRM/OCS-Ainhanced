import type { QuestionTypes } from '@ocsjs/core';
import type { AIImageInput, AIQuestionInput } from './types';

export const MAX_IMAGES = 6;
export const MAX_DATA_URL_CHARS = 5 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_CHARS = 8 * 1024 * 1024;
export const MAX_REMOTE_IMAGE_URL_CHARS = 8192;
const MEDIA_FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

/** 从题目节点中提取适合发送给模型的纯文本，去除旧版图片 URL 隐藏节点。 */
function elementText(element: HTMLElement): string {
	const clone = element.cloneNode(true) as HTMLElement;
	for (const hidden of Array.from(clone.querySelectorAll('span'))) {
		const style = hidden.getAttribute('style') || '';
		if (style.includes('font-size: 0px') || style.includes('font-size:0px')) {
			hidden.remove();
		}
	}
	for (const image of Array.from(clone.querySelectorAll('img'))) {
		const alt = image.getAttribute('alt') || image.getAttribute('title') || '图片';
		image.replaceWith(`[${alt}]`);
	}
	return (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function imageSource(image: HTMLImageElement): string | undefined {
	const source =
		image.currentSrc ||
		image.getAttribute('data-src') ||
		image.getAttribute('data-original') ||
		image.getAttribute('src') ||
		'';
	if (!source) return undefined;
	try {
		return new URL(source, document.baseURI).toString();
	} catch {
		return source;
	}
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
		reader.readAsDataURL(blob);
	});
}

/** 优先转成 data URL；跨域或权限不足时返回可公开访问的原始 URL。 */
async function imageToInput(image: HTMLImageElement): Promise<AIImageInput | undefined> {
	const source = imageSource(image);
	if (!source) return undefined;
	if (source.startsWith('data:image/')) {
		if (source.length > MAX_DATA_URL_CHARS) return undefined;
		return { type: 'input_image', image_url: source, detail: 'auto' };
	}

	if (/^https:\/\//i.test(source)) {
		try {
			const response = await fetchWithTimeout(source, { credentials: 'same-origin' });
			if (response.ok) {
				const blob = await response.blob();
				if (blob.type.startsWith('image/') && blob.size <= 3 * 1024 * 1024) {
					const dataUrl = await readBlobAsDataUrl(blob);
					if (dataUrl.length <= MAX_DATA_URL_CHARS) {
						return { type: 'input_image', image_url: dataUrl, detail: 'auto' };
					}
				}
			}
		} catch {
			// 继续使用原始地址作为降级方案。
		}
		if (source.length <= MAX_REMOTE_IMAGE_URL_CHARS) {
			return { type: 'input_image', image_url: source, detail: 'auto' };
		}
	}

	return undefined;
}

function cleanSubtitle(text: string): string {
	return text
		.replace(/^WEBVTT[^\n]*\n?/gim, '')
		.replace(/^NOTE[^\n]*(?:\n(?!\n).*)*/gim, '')
		.replace(/^\s*\d+\s*$/gm, '')
		.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->.*$/gm, '')
		.replace(/\n{2,}/g, '\n')
		.trim();
}

async function collectMediaText(root?: HTMLElement): Promise<string> {
	if (!root) return '';
	const parts: string[] = [];
	for (const track of Array.from(root.querySelectorAll<HTMLTrackElement>('track[src]'))) {
		try {
			const response = await fetchWithTimeout(track.src, { credentials: 'same-origin' });
			if (response.ok) parts.push(cleanSubtitle(await response.text()));
		} catch {
			// 跨域字幕读取失败时继续检查页面内嵌转写。
		}
	}
	for (const transcript of Array.from(root.querySelectorAll<HTMLElement>('[data-transcript], [data-subtitle]'))) {
		parts.push(elementText(transcript));
	}
	return [...new Set(parts.filter(Boolean))].join('\n').slice(0, 20000);
}

/** 构造 AI 请求，返回 unavailable 表示媒体无法按第一版能力处理。 */
export async function extractAIQuestion(options: {
	type?: QuestionTypes | string;
	title: HTMLElement[];
	options?: HTMLElement[];
	root?: HTMLElement;
}): Promise<AIQuestionInput | { unavailable: string }> {
	const question = options.title.map(elementText).filter(Boolean).join('\n').trim();
	if (!question) throw new Error('题目为空，无法请求 AI');

	const optionElements = options.options || [];
	// Completion controls are positional blanks, not choices. Sending empty A/B
	// options confuses models and does not help answer generation.
	const optionTexts = options.type === 'completion' || options.type === 'essay' ? [] : optionElements.map(elementText);
	const imageElements = [...options.title, ...optionElements].flatMap((element) =>
		Array.from(element.querySelectorAll<HTMLImageElement>('img'))
	);
	const uniqueImages = [...new Map(imageElements.map((image) => [imageSource(image), image])).values()].filter(Boolean);
	const images: AIImageInput[] = [];
	let imageChars = 0;
	for (const image of uniqueImages.slice(0, MAX_IMAGES)) {
		const input = await imageToInput(image);
		if (input && imageChars + input.image_url.length <= MAX_TOTAL_IMAGE_CHARS) {
			images.push(input);
			imageChars += input.image_url.length;
		}
	}

	const hasMedia = Boolean(options.root?.querySelector('audio, video'));
	const mediaText = await collectMediaText(options.root);
	if (hasMedia && !mediaText) {
		return { unavailable: '检测到音频或视频，但页面没有可读取的字幕/转写文本，第一版 AI 不直接上传音视频。' };
	}

	return {
		type: (options.type || 'unknown') as AIQuestionInput['type'],
		question,
		options: optionTexts,
		images,
		...(mediaText ? { mediaText } : {})
	};
}
