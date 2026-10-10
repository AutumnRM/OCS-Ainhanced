/** MOOC owns playlist navigation. This controller only manages the current media. */
export function isMOOCElementVisible(element: HTMLElement): boolean {
	if (!element.isConnected || !element.getClientRects().length) return false;
	for (let current: HTMLElement | null = element; current; current = current.parentElement) {
		const style = window.getComputedStyle(current);
		if (current.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
	}
	return true;
}

export function getMOOCVideoQuestion(root: Document | HTMLElement = document): HTMLElement | undefined {
	return Array.from(root.querySelectorAll<HTMLElement>('.j-unitctBox .u-questionItem:not(.analysisMode)')).find(
		isMOOCElementVisible
	);
}

export function createMOOCStudyController(options: {
	canRun: () => boolean;
	playbackRate: () => number;
	volume: () => number;
	autoAnswer: () => boolean;
	onQuestion: (question: HTMLElement) => void | Promise<void>;
	onMedia?: (media: HTMLMediaElement | undefined) => void;
	onError?: (error: unknown) => void;
	onEnded?: () => void;
	play?: (media: HTMLMediaElement) => void | Promise<unknown>;
	root?: Document | HTMLElement;
}) {
	const root = options.root || document;
	const route = location.hash;
	let disposed = false;
	let media: HTMLMediaElement | undefined;
	let question: HTMLElement | undefined;
	let resumeAfterQuestion = false;
	let answerBusy = false;
	let unbind: (() => void) | undefined;
	const attempted = new WeakSet<HTMLElement>();
	const active = () => !disposed && location.hash === route && options.canRun();
	const report = (error: unknown) => {
		if (active()) options.onError?.(error);
	};
	const play = (target: HTMLMediaElement) => {
		if (!active() || getMOOCVideoQuestion(root) || target.ended) return;
		try {
			Promise.resolve(options.play ? options.play(target) : target.play()).catch(report);
		} catch (error) {
			report(error);
		}
	};
	const configure = (target: HTMLMediaElement) => {
		const rate = Number(options.playbackRate());
		const volume = Number(options.volume());
		const nextRate = Number.isFinite(rate) ? Math.max(0.25, Math.min(16, rate)) : 1;
		const nextVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0;
		if (target.playbackRate !== nextRate) target.playbackRate = nextRate;
		if (target.volume !== nextVolume) target.volume = nextVolume;
	};
	const enforcePause = () => {
		if (media && getMOOCVideoQuestion(root) && !media.paused) {
			resumeAfterQuestion = true;
			media.pause();
		}
	};
	const tick = () => {
		if (!active()) {
			dispose();
			return;
		}
		const nextMedia = root.querySelector<HTMLMediaElement>('video,audio') || undefined;
		if (nextMedia !== media) {
			unbind?.();
			media = nextMedia;
			resumeAfterQuestion = false;
			options.onMedia?.(media);
			if (media) {
				const target = media;
				const loaded = () => {
					if (active()) {
						configure(target);
						enforcePause();
					}
				};
				const ended = () => {
					if (active()) options.onEnded?.();
				};
				target.addEventListener('play', enforcePause);
				target.addEventListener('loadedmetadata', loaded);
				target.addEventListener('ended', ended);
				unbind = () => {
					target.removeEventListener('play', enforcePause);
					target.removeEventListener('loadedmetadata', loaded);
					target.removeEventListener('ended', ended);
				};
				configure(target);
				// One initial play attempt; never force replay on a pause event.
				if (!getMOOCVideoQuestion(root)) play(target);
			}
		}
		if (media) configure(media);
		const nextQuestion = getMOOCVideoQuestion(root);
		if (question && !nextQuestion && resumeAfterQuestion && media) {
			resumeAfterQuestion = false;
			play(media);
		}
		question = nextQuestion;
		enforcePause();
		if (question && options.autoAnswer() && !answerBusy && !attempted.has(question)) {
			attempted.add(question);
			const detected = question;
			answerBusy = true;
			Promise.resolve()
				.then(() => {
					if (active() && detected.isConnected && getMOOCVideoQuestion(root) === detected) {
						return options.onQuestion(detected);
					}
				})
				.catch(report)
				.finally(() => {
					answerBusy = false;
				});
		}
	};
	const observer = new MutationObserver(tick);
	observer.observe(root instanceof Document ? root.documentElement : root, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['class', 'style', 'hidden']
	});
	const interval = setInterval(tick, 500);
	const onRoute = () => {
		if (location.hash !== route) dispose();
	};
	window.addEventListener('hashchange', onRoute);
	window.addEventListener('pagehide', dispose);
	function dispose() {
		if (disposed) return;
		disposed = true;
		observer.disconnect();
		clearInterval(interval);
		unbind?.();
		window.removeEventListener('hashchange', onRoute);
		window.removeEventListener('pagehide', dispose);
		media = undefined;
		options.onMedia?.(undefined);
	}
	tick();
	return dispose;
}
