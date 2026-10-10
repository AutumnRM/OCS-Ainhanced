import { app, dialog } from 'electron';

// GUI launches and detached test runners may close stdio while Electron keeps running.
// Swallow only broken-pipe errors so logging cannot recurse through uncaughtException.
for (const stream of [process.stdout, process.stderr]) {
	stream?.on('error', (error: NodeJS.ErrnoException) => {
		if (error.code !== 'EPIPE') throw error;
	});
}

process.on('uncaughtException', reportFatalStartupError);
process.on('unhandledRejection', reportFatalStartupError);

void import('./src/main')
	.then(({ startApplication }) => startApplication())
	.then(() => {
		process.off('uncaughtException', reportFatalStartupError);
		process.off('unhandledRejection', reportFatalStartupError);
	})
	.catch(reportFatalStartupError);

function reportFatalStartupError(error: unknown) {
	if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') return;
	const message = error instanceof Error ? error.stack || error.message : String(error);
	console.error('[OCS Desktop] fatal startup error', message);
	try {
		dialog.showErrorBox('OCS Desktop 启动失败', `${message}\n\n日志目录：${app.getPath('logs')}`);
	} finally {
		app.exit(1);
	}
}
