import type { QuestionTypes, SearchInformation } from '@ocsjs/core';

export type AIQuestionType = Exclude<QuestionTypes, undefined> | 'unknown' | 'essay';

export interface AIImageInput {
	type: 'input_image';
	image_url: string;
	detail?: 'low' | 'high' | 'original' | 'auto';
}

export interface AIQuestionInput {
	type: AIQuestionType;
	question: string;
	options: string[];
	images: AIImageInput[];
	mediaText?: string;
}

export interface AIAnswerResponse {
	can_answer: boolean;
	answers: string[];
	confidence: number;
}

export interface AIConfigStatus {
	enabled: boolean;
	configured: boolean;
	ready: boolean;
	reason: string;
	protocol: 'responses';
	endpointConfigured: boolean;
	keyConfigured: boolean;
	modelId: string;
	/** 非敏感指纹，用于使 AI 临时缓存随配置变化失效。 */
	configFingerprint?: string;
}

export interface AIAnswerContext {
	type?: QuestionTypes | string;
	question?: string;
	titleElements?: HTMLElement[];
	options?: HTMLElement[];
	root?: HTMLElement;
}

/** @deprecated Use AIAnswerContext. Retained for source compatibility. */
export type AIFallbackContext = AIAnswerContext;

export interface AIAnswererResult {
	info: SearchInformation;
	attempted: boolean;
}
