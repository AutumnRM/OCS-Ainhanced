import { app, BrowserWindow } from 'electron';
import path from 'path';
import { remoteRegister } from './tasks/remote.register';
import { initStore } from './tasks/init.store';
import { autoLaunch } from './tasks/auto.launch';
import { createWindow } from './window';
import { globalListenerRegister } from './tasks/global.listener';
import { task } from './utils';
import { handleError } from './tasks/error.handler';
import { updater } from './tasks/updater';
import { startupServer } from './tasks/startup.server';
import { initChrome } from './tasks/init.chrome';
import { store } from './store';
import { initAesKey } from './crypto';

let mainWindow: BrowserWindow | undefined;
let closing = false;
let closeFallback: NodeJS.Timeout | undefined;

function requestGracefulClose(window: BrowserWindow) {
	if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('close');
	if (!closeFallback) {
		closeFallback = setTimeout(() => {
			closing = true;
			app.exit(0);
		}, 10000);
	}
}

export function startApplication(): Promise<void> {
	app.setName('ocs');
	app.commandLine.appendSwitch('no-sandbox');
	app.commandLine.appendSwitch('disable-gpu');
	app.commandLine.appendSwitch('disable-software-rasterizer');
	app.commandLine.appendSwitch('disable-gpu-compositing');
	app.commandLine.appendSwitch('disable-gpu-rasterization');
	app.commandLine.appendSwitch('disable-gpu-sandbox');
	app.disableHardwareAcceleration();

	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return Promise.resolve();
	}

	return bootstrap();
}

async function bootstrap() {
	await task('OCS启动程序', async () => {
		handleError();
		await initAesKey();
		initStore();

		await Promise.all([
			task('启动接口服务', () => startupServer()),
			task('初始化自动启动', () => autoLaunch()),
			task('启动渲染进程', () => openMainWindow())
		]);
	});
}

async function openMainWindow() {
	app.commandLine.appendSwitch(
		'webrtc-max-cpu-consumption-percentage',
		(store.store.app?.video_frame_rate ?? 1).toString()
	);

	await app.whenReady();
	const window = createWindow();
	mainWindow = window;
	const relaunched = await task('初始化谷歌浏览器', () => initChrome(window));
	if (relaunched) return;

	window.on('close', (event) => {
		if (closing) return;
		event.preventDefault();
		requestGracefulClose(window);
	});
	window.webContents.on('render-process-gone', () => {
		if (!closing && !window.isDestroyed()) void window.reload();
	});

	app.on('before-quit', (event) => {
		if (closing) return;
		event.preventDefault();
		if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
			requestGracefulClose(window);
		} else {
			closing = true;
			app.quit();
		}
	});

	window.webContents.once('did-finish-load', () => {
		setTimeout(() => {
			if (app.isPackaged) void task('软件更新', () => updater());
		}, 1000);
	});

	task('初始化远程通信模块', () => remoteRegister(window));
	task('注册app事件监听器', () => globalListenerRegister(window));

	if (app.isPackaged) {
		await window.loadFile(path.join(app.getAppPath(), 'public', 'index.html'));
	} else {
		await window.loadURL('http://localhost:3000');
		window.webContents.openDevTools();
	}
	window.show();
}

export function markApplicationClosing() {
	closing = true;
	if (closeFallback) clearTimeout(closeFallback);
}

export function getMainWindow() {
	return mainWindow;
}
