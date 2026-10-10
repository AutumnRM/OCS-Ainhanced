import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-ignore Legacy test DOM dependency.
import browserEnv from '../packages/scripts/node_modules/browser-env';
import { createMOOCStudyController, getMOOCVideoQuestion } from '../packages/scripts/src/utils/mooc-study';
browserEnv();
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

async function testStudy() {
	const root = document.createElement('div');
	root.innerHTML =
		'<div class="j-unitctBox"><video></video><div class="u-questionItem" style="display:none">题目</div></div>';
	document.body.append(root);
	const question = root.querySelector<HTMLElement>('.u-questionItem')!;
	question.getClientRects = () => [{ width: 100, height: 30 }] as any;
	const media = root.querySelector('video')!;
	let paused = true,
		plays = 0,
		pauses = 0,
		answers = 0,
		enabled = false,
		ended = 0;
	Object.defineProperties(media, { paused: { get: () => paused }, ended: { get: () => false } });
	media.play = async () => {
		paused = false;
		plays++;
		media.dispatchEvent(new window.Event('play'));
	};
	media.pause = () => {
		paused = true;
		pauses++;
		media.dispatchEvent(new window.Event('pause'));
	};
	const dispose = createMOOCStudyController({
		root,
		canRun: () => true,
		playbackRate: () => 1.5,
		volume: () => 0.4,
		autoAnswer: () => enabled,
		onQuestion: async () => {
			answers++;
		},
		onEnded: () => ended++
	});
	try {
		assert.equal(media.playbackRate, 1.5);
		assert.equal(media.volume, 0.4);
		assert.equal(plays, 1);
		assert.equal(getMOOCVideoQuestion(root), undefined);
		question.style.display = '';
		await flush();
		assert.equal(paused, true);
		assert.equal(pauses, 1);
		assert.equal(answers, 0, 'disabled AI must not run');
		await media.play();
		assert.equal(paused, true, 'play event must not bypass question pause');
		enabled = true;
		root.className = 'changed';
		await flush();
		assert.equal(answers, 1);
		root.className = 'changed-again';
		await flush();
		assert.equal(answers, 1);
		question.style.display = 'none';
		await flush();
		assert.equal(paused, false, 'resume only our question pause');
		media.pause();
		const previousPlays = plays;
		await flush();
		assert.equal(plays, previousPlays, 'manual pause must not trigger replay');
		question.style.display = '';
		await flush();
		question.style.display = 'none';
		await flush();
		assert.equal(plays, previousPlays, 'a previously paused video must remain paused');
		media.dispatchEvent(new window.Event('ended'));
		assert.equal(ended, 1);
		assert.equal(location.hash, '', 'no navigation on ended');
		dispose();
		question.style.display = '';
		await media.play();
		await flush();
		assert.equal(paused, false, 'disposed controller must remove play listener');
	} finally {
		dispose();
		root.remove();
	}
}

async function testRouteAndRebind() {
	const root = document.createElement('div');
	root.innerHTML = '<video></video>';
	document.body.append(root);
	const media = root.querySelector('video')!;
	let current: HTMLMediaElement | undefined;
	let plays = 0;
	media.play = async () => {
		plays++;
	};
	const dispose = createMOOCStudyController({
		root,
		canRun: () => true,
		playbackRate: () => 2,
		volume: () => 0,
		autoAnswer: () => false,
		onQuestion: () => {},
		onMedia: (m) => (current = m)
	});
	try {
		assert.equal(current, media);
		const replacement = document.createElement('video');
		replacement.play = async () => {
			plays++;
		};
		media.replaceWith(replacement);
		await flush();
		assert.equal(current, replacement);
		assert.equal(plays, 2);
		window.dispatchEvent(new window.Event('pagehide'));
		assert.equal(current, undefined);
		const before = plays;
		root.append(document.createElement('video'));
		await flush();
		assert.equal(plays, before);
	} finally {
		dispose();
		root.remove();
	}
}

const source = readFileSync(new URL('../packages/scripts/src/projects/icourse.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /gotoNextJob|async function next\(|video\.onpause|video\.onended|text-job-reload/);
testStudy()
	.then(testRouteAndRebind)
	.then(() => console.log('MOOC study tests passed'))
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
