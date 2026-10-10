import { app } from 'electron';
import { Logger } from '../logger';

/**
 * 处理错误
 */
export function handleError() {
	const logger = Logger('error');
	let handlingProcessError = false;
	const logProcessError = (label: string, error: unknown) => {
		if ((error as NodeJS.ErrnoException)?.code === 'EPIPE' || handlingProcessError) return;
		handlingProcessError = true;
		try {
			logger.error(label, error);
		} finally {
			handlingProcessError = false;
		}
	};

	app.on('render-process-gone', (e, c, details) => {
		logger.error('render-process-gone', details);
		// 渲染进程崩溃不应直接结束主进程，否则会连带关闭自动化浏览器。
		// Electron 主窗口可以在需要时自行重建；至少保留服务和浏览器进程，
		// 让 AI 请求失败不会表现为整个客户端闪退。
	});
	app.on('child-process-gone', (e, details) => {
		logger.error('child-process-gone', details);
		// 子进程异常只记录，避免一个辅助进程退出导致客户端和浏览器一起退出。
	});

	process.on('uncaughtException', (e) => {
		logProcessError('uncaughtException', e);
	});
	process.on('unhandledRejection', (e) => {
		logProcessError('unhandledRejection', e);
	});
}
