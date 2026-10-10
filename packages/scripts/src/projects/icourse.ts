import { $, defaultWorkTypeResolver, OCSWorker, RemotePage } from '@ocsjs/core';
import { requestAIAnswerInfos } from '../ai';
import { $message, Project, Script, $ui } from 'easy-us';
import { CommonWorkOptions, playMedia } from '../utils';
import { CommonProject } from './common';
import { commonWork, optimizationElementWithImage, removeRedundantWords, simplifyWorkResult } from '../utils/work';
import { $console, BackgroundProject } from './background';
import { $playwright } from '../utils/app';
import { waitForElement, waitFor } from '../utils/study';
import { createMOOCStudyController, getMOOCVideoQuestion, isMOOCElementVisible } from '../utils/mooc-study';
import { playbackRate, volume } from '../utils/configs';
import { $render } from '../utils/render';

const $msg_and_log = (type: 'info' | 'warn' | 'error', msg: string) => {
	$message[type](msg);
	$console[type](msg);
};

const state = {
	currentMedia: undefined as HTMLMediaElement | undefined,
	currentUrlHash: '',
	currentRunningScriptName: '',
	current_job_id: '',
	stopStudy: undefined as (() => void) | undefined
};

export const ICourseProject = Project.create({
	name: '中国大学MOOC',
	domains: ['icourse163.org'],
	scripts: {
		dispatcher: new Script({
			name: '调度器',
			hideInPanel: true,
			matches: [['所有页面', 'icourse163.org']],
			oncomplete() {
				setInterval(() => {
					const hash = new URL(window.location.href).hash;
					if (state.currentUrlHash !== hash) {
						state.stopStudy?.();
						state.stopStudy = undefined;
						state.currentRunningScriptName = '';
					}
					state.currentUrlHash = hash;

					for (const key in ICourseProject.scripts) {
						if (Object.prototype.hasOwnProperty.call(ICourseProject.scripts, key)) {
							const script = (ICourseProject.scripts as any)[key] as Script<{
								runAtHash: { defaultValue: string | string[] };
							}>;
							const runAtHash = Array.isArray(script.cfg.runAtHash) ? script.cfg.runAtHash : [script.cfg.runAtHash];
							if (runAtHash.length && runAtHash.some((h) => state.currentUrlHash.includes(h))) {
								if (state.currentRunningScriptName !== script.name) {
									state.currentRunningScriptName = script.name;
									state.current_job_id = Math.random().toString(16).slice(2);
									const job_id = state.current_job_id;
									Promise.resolve(
										script.methods?.main?.({
											canRun: () => {
												return location.hash === hash && state.current_job_id === job_id;
											},
											job_id: state.current_job_id
										})
									).catch((error) => {
										if (location.hash === hash) $msg_and_log('error', 'MOOC 脚本运行失败：' + String(error));
									});
								}
								break;
							}
						}
					}
				}, 1000);
			}
		}),
		guide: new Script({
			name: '💡 使用提示',
			matches: [['', 'icourse163.org']],
			// 添加版本号是因为只有 notes 会强制更新，其他配置项不会，如果需要修改 runAtHash ，需要更新版本号
			namespace: 'icourse.guide-v1',
			configs: {
				notes: {
					defaultValue: $ui.notes(['手动进入任意课程里的课件/作业，即可开始自动学习']).outerHTML
				},
				runAtHash: {
					// 在没有进入学习页面前，都显示提示
					defaultValue: ['/home/course']
				}
			},
			methods() {
				return {
					main: async () => {
						console.log(state, this.cfg.runAtHash);

						CommonProject.scripts.render.methods.pin(this);
					}
				};
			}
		}),
		study: new Script({
			name: '🖥️ 学习脚本',
			// 添加版本号是因为只有 notes 会强制更新，其他配置项不会，如果需要修改 runAtHash ，需要更新版本号
			namespace: 'icourse.study-v1',
			matches: [
				['MOOC作业页面', 'icourse163.org/learn'],
				['SPOC作业页面', 'icourse163.org/spoc/learn']
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'请勿在使用过程中最小化浏览器',
						'视频弹题出现时自动暂停；自动答题关闭时请手动完成弹题。',
						'脚本不切换视频、章节或文档；视频连播请使用 MOOC 的“自动播放下一视频”。',
						'手动暂停不会被强制重播，页面切换后会清理旧播放任务。',
						'自动讨论默认关闭，如需开启请在下方设置中设置',
						'作业请完成课程后手动进入'
					]).outerHTML
				},
				runAtHash: {
					defaultValue: '/learn/content?type=detail'
				},
				playbackRate: playbackRate,
				volume: volume,
				readSpeed: {
					label: 'PPT翻阅速度（秒）',
					attrs: { type: 'number', step: '1', min: '1', max: '10' },
					defaultValue: 1
				},
				discussionStrategy: {
					label: '讨论自动回复方式',
					tag: 'select',
					defaultValue: 'not-reply' as 'not-reply' | 'max-show-up' | 'max-fav' | 'use-newest',
					options: [
						['not-reply', '不讨论回复'],
						['max-show-up', '获取出现最多的评论进行回复'],
						['max-fav', '获取最多点赞的评论进行回复'],
						['use-newest', '获取最新的评论进行回复']
					]
				},
				enableChapterTest: {
					label: '随堂测验自动答题',
					attrs: {
						type: 'checkbox',
						title: '默认关闭。关闭时仍暂停视频，但不启动 AI；开启后按现有保存/提交策略处理弹题。'
					},
					defaultValue: false
				}
			},
			oncomplete() {
				this.onConfigChange('playbackRate', (playbackRate) => {
					state.currentMedia && (state.currentMedia.playbackRate = parseFloat(playbackRate.toString()));
				});
				this.onConfigChange('volume', (v) => state.currentMedia && (state.currentMedia.volume = v));
			},
			methods() {
				return {
					main: async ({ canRun, job_id }: { canRun: () => boolean; job_id: string }) => {
						const active = () => canRun() && state.current_job_id === job_id;
						CommonProject.scripts.render.methods.pin(this);
						$render.moveToEdge();
						state.stopStudy?.();
						state.stopStudy = createMOOCStudyController({
							canRun: active,
							playbackRate: () => Number(this.cfg.playbackRate),
							volume: () => Number(this.cfg.volume),
							autoAnswer: () => this.cfg.enableChapterTest,
							onMedia: (media) => {
								state.currentMedia = media;
							},
							play: (media) => playMedia(() => (active() && !getMOOCVideoQuestion() ? media.play() : undefined)),
							onError: (error) => $msg_and_log('error', 'MOOC 学习处理失败：' + String(error)),
							onEnded: () => $msg_and_log('info', '当前视频播放结束，下一视频由 MOOC 原生连播处理。'),
							onQuestion: async (question) => {
								$msg_and_log('info', '检测到视频弹题，保持暂停并开始 AI 答题。');
								await ICourseProject.scripts.work.methods.start(
									'chapter-test',
									() =>
										active() && this.cfg.enableChapterTest && question.isConnected && isMOOCElementVisible(question),
									(worker) => {
										worker.once('done', async () => {
											if (!active() || getMOOCVideoQuestion()) return;
											const button = document.querySelector<HTMLElement>('.j-unitctBox .j-continue');
											if (!button || !isMOOCElementVisible(button)) return;
											try {
												const remote = await BackgroundProject.scripts.dev.methods.getRemotePlaywrightCurrentPage();
												if (remote && active() && button.isConnected && !getMOOCVideoQuestion())
													await remote.click(button);
											} catch (error) {
												if (active()) $msg_and_log('error', '继续播放失败：' + String(error));
											}
										});
									}
								);
							}
						});
						const unit = await waitFor(() => active() && document.querySelector('.j-unitslist li.current'), {
							timeout_seconds: 20,
							check_period_ms: 250
						});
						if (!active() || !unit) return;
						$msg_and_log(
							'info',
							'正在学习：' + (unit.querySelector('.unit-name')?.textContent || unit.textContent || '当前内容')
						);
						if (unit.querySelector('[class*=u-icon-video]')) return;
						if (unit.querySelector('[class*=u-icon-text]')) {
							$msg_and_log('info', '文档已打开，进度由 MOOC 记录；不自动刷新或切换内容。');
							return;
						}
						if (unit.querySelector('[class*=u-icon-discuss]') && this.cfg.discussionStrategy === 'not-reply') return;
						const remote = await BackgroundProject.scripts.dev.methods.getRemotePlaywrightCurrentPage();
						if (!active()) return;
						if (!remote) return $playwright.showError();
						if (unit.querySelector('[class*=u-icon-doc]')) {
							await waitForElement('.ux-pdf-reader', { timeout_seconds: 20 });
							if (active()) await readPPT(remote, this.cfg.readSpeed, active);
						} else if (unit.querySelector('[class*=u-icon-discuss]')) {
							if (this.cfg.discussionStrategy === 'not-reply') return;
							await waitForElement('.j-reply-all', { timeout_seconds: 20 });
							if (active()) await discussion(remote, this.cfg.discussionStrategy, active);
						} else if (unit.querySelector('[class*=u-icon-test]') && this.cfg.enableChapterTest) {
							const question = await waitFor(
								() => active() && document.querySelector<HTMLElement>('.u-questionItem:not(.analysisMode)'),
								{ timeout_seconds: 20 }
							);
							if (active() && question && isMOOCElementVisible(question))
								await ICourseProject.scripts.work.methods.start('chapter-test', active);
						}
					}
				};
			}
		}),
		work: new Script({
			name: '✍️ 作业考试脚本',
			// 添加版本号是因为只有 notes 会强制更新，其他配置项不会，如果需要修改 runAtHash ，需要更新版本号
			namespace: 'icourse.work-v3',
			matches: [
				['MOOC作业页面', 'icourse163.org/learn'],
				['SPOC作业页面', 'icourse163.org/spoc/learn'],
				['考试页面', 'icourse163.org/mooc/main/newExam']
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'请先启动桌面客户端并完成 AI 地址、模型和 API Key 配置。',
						'⚠️禁止同时开多个作业/考试页面。',
						[
							'⚠️由于MOOC限制、答题速度和搜题速度将默认调慢',
							' 防止出现网络并发，导致无法选上选项的问题。',
							' 答题和搜题过慢是正常情况。'
						]
					]).outerHTML
				},
				runAtHash: {
					defaultValue: ['/learn/quiz', '/learn/hw', '/learn/examObject']
				}
			},
			methods() {
				const start = async (
					type: 'chapter-test' | 'work' | 'exam',
					canRun: () => boolean,
					onWorkerCreated?: (worker: any) => void
				) => {
					// 检查是否为软件环境
					const remotePage = await BackgroundProject.scripts.dev.methods.getRemotePlaywrightCurrentPage();
					// 检查是否为软件环境
					if (!remotePage) {
						return $playwright.showError();
					}

					// 等待加载题目
					await waitForQuestion(canRun);
					if (
						type !== 'exam' &&
						!document.querySelector(
							'.u-questionItem input:not([disabled]),.u-questionItem textarea:not([disabled]),.u-questionItem .j-answer .ql-editor[contenteditable="true"]'
						)
					) {
						$msg_and_log('info', '当前答卷为只读或没有可填写控件，不调用 AI。');
						return;
					}

					CommonProject.scripts.render.methods.pin(this);
					CommonProject.scripts.render.methods.normal();

					$msg_and_log('info', '开始答题');
					CommonProject.scripts.render.methods.pin(this);
					commonWork(this, {
						beforeRunning: () => {
							if (!canRun()) throw new Error('页面或题目已切换，取消旧答题任务。');
						},
						workerProvider: (opts) => {
							const worker = workAndExam(remotePage, type, opts);
							worker.once('close', () => {
								clearInterval(interval);
							});
							const interval = setInterval(() => {
								if (canRun() === false) {
									$msg_and_log('warn', '检测到页面切换，无法继续答题，将关闭自动答题。');
									clearInterval(interval);
									worker.emit('close');
								}
							}, 1000);
							worker.once('done', () => clearInterval(interval));
							return worker;
						},
						onWorkerCreated: onWorkerCreated,
						enable_control_panel: true,
						start_delay_seconds: 3
					});
				};
				return {
					main: async ({ canRun }: { canRun: () => boolean; job_id: string }) => {
						if (/learn\/(quizscore|hwscore|examObjectScore)/.test(location.hash)) {
							$message.success('当前作业已完成，自动答题关闭。');
							return;
						}
						return start('work', canRun);
					},
					start: start
				};
			},
			// 考试是新开一个界面所以会直接触发
			oncomplete() {
				if (
					(location.href.includes('/learn/examObject') &&
						// 考试成绩解析页面
						!location.href.includes('learn/examObjectScore')) ||
					// 新版考试界面
					location.href.includes('/mooc/main/newExam')
				) {
					this.methods.start('exam', () => true);
				}
			}
		}),
		passportRedirect: new Script({
			name: '登录重定向修复',
			matches: [['登录重定向', 'passport/logingate/changeCookie.htm']],
			configs: {
				notes: {
					defaultValue: $ui.notes(['检测到页面重定向到空白页面', '程序将会自动修复']).outerHTML
				}
			},
			hideInPanel: true,
			oncomplete(...args) {
				CommonProject.scripts.render.methods.pin(this);
				$message.info('检测到中国大学MOOC空白页面，即将重定向修复...');
				setTimeout(() => {
					location.href = 'https://www.icourse163.org/';
				}, 3000);
			}
		})
	}
});

async function waitForQuestion(canRun: () => boolean) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline && canRun()) {
		if (document.querySelector('.u-questionItem,[class*=questionBody]')) return;
		await $.sleep(250);
	}
	throw new Error(canRun() ? '30 秒内未加载出题目，请进入答题页面后重新开始。' : '页面已切换，取消等待题目。');
}

function workAndExam(
	rp: RemotePage,
	type: 'chapter-test' | 'work' | 'exam',
	{ redundanceWordsText, upload, stopSecondWhenFinish, answerSeparators }: CommonWorkOptions
) {
	CommonProject.scripts.workResults.methods.init({
		questionPositionSyncHandlerType: 'icourse'
	});

	const titleTransform = (titles: (HTMLElement | undefined)[]) => {
		return removeRedundantWords(
			titles
				.filter((t) => t?.innerText || t?.querySelector('img'))
				.map((t) => {
					if (t) {
						const el = optimizationElementWithImage(t, true);
						// textContent can still read the hidden image URL placeholders.
						return (el.textContent || '').replace(/\s+/g, ' ').trim() || '';
					}
					return '';
				})
				.filter((t) => t.trim() !== '')
				.join(',')
				// /\u200B/g 排除不可见的空格
				.replace(/[\u200A-\u200F]/g, ''),
			redundanceWordsText.split('\n')
		);
	};
	const work_type = type;

	/** 新建答题器 */
	const worker = new OCSWorker({
		root:
			type === 'exam'
				? '[class*=questionBody]'
				: type === 'chapter-test'
				? Array.from(document.querySelectorAll<HTMLElement>('.u-questionItem:not(.analysisMode)')).filter(
						isMOOCElementVisible
				  )
				: '.u-questionItem',
		elements: {
			title: type === 'exam' ? '[class*=questionInfo]' : '.j-title .j-richTxt',
			options:
				type === 'exam'
					? '[class*=index-module__optionBody]'
					: '.choices li,.inputArea textarea,.inputArea input[type="text"],.inputArea [contenteditable="true"],.j-answer .ql-editor[contenteditable="true"]'
		},
		thread: 1,
		sequential: true,
		answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
		/** 默认搜题方法构造器 */
		answerer: (elements, ctx) => {
			if (!ctx.root.isConnected) throw new Error('题目已被页面替换，请在当前页面重新开始答题。');
			if (ctx.root.querySelector('.j-title a[href*="attachment"]')) {
				throw new Error('题干包含附件，尚未读取附件内容；请查看附件后人工回答，避免 AI 缺失条件。');
			}
			const title = titleTransform(elements.title);
			if (title) {
				return requestAIAnswerInfos(elements.title, {
					titleElements: elements.title,
					options: ctx.elements.options,
					root: ctx.root,
					type: ctx.root.matches('.u-analysisQuestion') ? 'essay' : ctx.type
				});
			} else {
				throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
			}
		},
		work: {
			type(ctx) {
				const label = ctx.root.querySelector('.j-qacate')?.textContent || '';
				if (label.includes('判断')) return 'judgement';
				if (label.includes('多选')) return 'multiple';
				if (label.includes('单选')) return 'single';
				return ctx.elements.options.some((option) => isCompletionControl(option))
					? 'completion'
					: defaultWorkTypeResolver(ctx);
			},
			/** 自定义处理器 */
			async handler(type, answer, option) {
				if (!option.isConnected) throw new Error('题目已被页面替换，停止填写旧题目。');
				if (type === 'judgement' || type === 'single' || type === 'multiple') {
					const input = option.querySelector<HTMLInputElement>('input[type="radio"],input[type="checkbox"],input');
					if (input?.disabled) throw new Error('当前是只读答卷，不能自动填写。');
					if (input && !input.checked) await selectMOOCOption(rp, option, input, work_type === 'exam');
				} else if (type === 'completion' && answer.trim()) {
					await fillMOOCBlank(rp, option, answer.trim());
				}
			}
		},
		onElementSearched(elements, root) {
			elements.options.forEach((el) => {
				optimizationElementWithImage(el);
				const correct = el.querySelector<HTMLElement>('.u-icon-correct');
				const wrong = el.querySelector<HTMLElement>('.u-icon-wrong');
				if (correct) {
					correct.replaceWith('对');
				}
				if (wrong) {
					wrong.replaceWith('错');
				}
			});
		},
		/** 完成答题后 */
		onResultsUpdate(curr, _, res) {
			CommonProject.scripts.workResults.methods.setResults(simplifyWorkResult(res, titleTransform));
			CommonProject.scripts.workResults.methods.updateWorkStateByResults(res);
		}
	});

	worker
		.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug })
		.then(async (results) => {
			if (worker.isClose) {
				return;
			}
			if (type === 'chapter-test') {
				$msg_and_log('info', `答题完成，将等待 ${stopSecondWhenFinish} 秒后进行保存或提交。`);
				await $.sleep(stopSecondWhenFinish * 1000);
				if (worker.isClose) {
					return;
				}
				// 处理提交
				await worker.uploadHandler({
					type: upload,
					results,
					async callback(finishedRate, uploadable) {
						const content = `完成率 ${finishedRate.toFixed(2)}% :  ${
							uploadable ? '3秒后将自动提交' : '3秒后将自动跳过（没保存按钮）'
						} `;
						$console.info(content);
						$message.success({ content: content, duration: type === 'chapter-test' ? 10 : 0 });

						await $.sleep(3000);
						if (worker.isClose) {
							return;
						}
						if (uploadable) {
							// 先收起面板防止阻挡，元素无法通过移动脚本面板去点击
							CommonProject.scripts.render.methods.minimize();
							CommonProject.scripts.render.methods.setPosition(100, 200);

							const sumbit = document.querySelector('.j-submit');
							if (sumbit) {
								await rp.click(sumbit);
							} else {
								$msg_and_log('warn', '没有找到提交按钮，将跳过提交。');
							}
						}
					}
				});
			} else {
				$message.success({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
			}

			worker.emit('done');
		})
		.catch((err) => {
			$message.error({ content: '答题程序发生错误 : ' + err.message, duration: 0 });
		});

	return worker;
}

async function readPPT(remotePage: RemotePage, readSpeed: number, canRun: () => boolean) {
	const reader = document.querySelector('.ux-pdf-reader');
	if (reader) {
		const total = parseInt(
			document
				.querySelector('.ux-h5pdfreader_container_footer_pages_total')
				?.childNodes[1]?.textContent?.replace(/\s/, '') || '0'
		);
		const start = parseInt(
			document.querySelector<HTMLInputElement>('.ux-h5pdfreader_container_footer_pages_in')?.value || '1'
		);
		for (let index = start; index < total && canRun() && reader.isConnected; index++) {
			const next = document.querySelector<HTMLElement>('.ux-h5pdfreader_container_footer_pages_next');
			if (next) {
				await remotePage.click(next);
			} else {
				$msg_and_log('error', '未找到PPT的下一页按钮！');
			}
			await $.sleep(Math.max(1, Number(readSpeed) || 1) * 1000);
		}
	}
}

async function discussion(
	remotePage: RemotePage,
	discussionStrategy: typeof ICourseProject.scripts.study.cfg.discussionStrategy,
	canRun: () => boolean
) {
	if (discussionStrategy === 'not-reply') {
		return $msg_and_log('warn', '讨论自动回复功能已关闭（上方菜单栏-中国大学MOOC-学习脚本中开启）。');
	}

	let res = '';

	if (discussionStrategy === 'max-show-up') {
		const list = Array.from(document.querySelectorAll('.j-reply-all .f-pr .j-content'));
		const mapping = new Map();
		for (const item of list) {
			mapping.set(item.textContent, (mapping.get(item.textContent) || 0) + 1);
		}
		const content = [...mapping.entries()].sort((a, b) => b[1] - a[1])?.[0]?.[0];
		if (!content) {
			$msg_and_log('error', '读取出现最多评论失败！');
		}
		res = content;
	} else if (discussionStrategy === 'max-fav') {
		const list = Array.from(document.querySelectorAll('.j-reply-all .f-pr'));
		let max = 0;
		let maxEl = undefined as Element | undefined;
		for (const item of list) {
			const num = parseInt(item.querySelector('.bar .num')?.textContent || '0');
			if (num > max) {
				max = num;
				maxEl = item;
			}
		}
		const content = maxEl?.querySelector('.j-content')?.textContent || '';
		if (!content) {
			$msg_and_log('error', '读取最多点赞评论失败！');
		}
		res = content;
	} else if (discussionStrategy === 'use-newest') {
		const content = document.querySelector('.j-reply-all .f-pr .first .j-content')?.textContent || '';
		if (!content) {
			$msg_and_log('error', '读取最新评论失败！');
		}
		res = content;
	}

	if (!res.trim() || !canRun()) return;
	const p = document.querySelector<HTMLDivElement>('.j-reply-add .ql-editor[contenteditable="true"]');
	if (p) {
		await fillMOOCBlank(remotePage, p, res);
		await $.sleep(1000);
		if (!canRun() || !p.isConnected) return;
		const submit = document.querySelector('.j-reply-add .editbtn');
		if (submit) {
			await remotePage.click(submit);
			$message.info('提交回复成功！');
		} else {
			$msg_and_log('error', '获取提交按钮失败！');
		}
		await $.sleep(2000);
	} else {
		$msg_and_log('error', '获取评论输入框失败！');
	}
}

/**
 * 执行回调，并且检测是否触发并发限制
 * 如果限制，等待一段时间后重新执行回调
 */
async function networkIdleRequire(rp: RemotePage, cb: () => void | Promise<void>) {
	await cb();
	// ux-modal  ux-modal-fadeIn
	const modal = await waitFor(() => document.querySelector('.ux-modal_content_content'), {
		check_period_ms: 200,
		timeout_seconds: 1
	});
	if (modal) {
		const msg = $message.warn('答题速度过快导致并发限制、3秒后再继续答题。');
		await rp.click('.ux-modal-btn');
		await $.sleep(3000);
		await cb();
		msg?.remove();
	}
}

function isCompletionControl(element: HTMLElement) {
	return element.matches('textarea,input[type="text"],[contenteditable="true"]');
}

async function selectMOOCOption(rp: RemotePage, option: HTMLElement, input: HTMLInputElement, isExam: boolean) {
	const target = isExam
		? option
		: option.querySelector<HTMLElement>('.f-richEditorText,label,[class*="option"]') || option;
	await networkIdleRequire(rp, async () => {
		await $.sleep(150);
		await rp.click(target, { timeout: 5000 });
	});
	await $.sleep(100);
	if (!input.checked) {
		// Some MOOC themes render the label outside the real input hit area.
		// A native fallback keeps the framework change event in the page context.
		input.click();
		await $.sleep(100);
	}
	if (!input.checked) throw new Error('MOOC 选项点击后未选中，请检查页面是否已切换。');
}

async function fillMOOCBlank(rp: RemotePage, option: HTMLElement, answer: string) {
	const field = isCompletionControl(option)
		? option
		: option.querySelector<HTMLElement>('textarea,input[type="text"],[contenteditable="true"]');
	if (!field) throw new Error('未找到 MOOC 填空输入框。');
	const current =
		field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field.innerText;
	if (current.trim() === answer) return;

	const marker = `ocs-ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	field.setAttribute('data-ocs-ai-fill', marker);
	try {
		await networkIdleRequire(rp, async () => {
			await $.sleep(150);
			await rp.fill(`[data-ocs-ai-fill="${marker}"]`, answer);
		});
	} finally {
		field.removeAttribute('data-ocs-ai-fill');
	}
	const filled =
		field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field.innerText;
	if (filled.trim() !== answer.trim()) throw new Error('MOOC 输入后内容未保留，请检查编辑器或页面状态。');
}
