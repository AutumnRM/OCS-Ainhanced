// @ts-check

import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { OriginalAppStore, store } from '../store';
import { valid, coerce, clean, gt, SemVer } from 'semver';
import defaultsDeep from 'lodash/defaultsDeep';
import { Logger } from '../logger';
import path from 'path';
import { isLegacyAesCiphertext } from '../crypto';

const logger = Logger('store-init');

/**
 * 初始化配置
 */
export function initStore() {
	resetLegacyEncryptedStore();
	const version = store.store.version;
	logger.log('version', version);

	if (typeof version === 'string') {
		// 当前app版本
		const appVersion = parseVersion(app.getVersion());
		// 本地存储的app版本
		const originVersion = parseVersion(version);
		// 是否需要更新设置
		if (gt(appVersion, originVersion)) {
			store.store = defaultsDeep(store.store, OriginalAppStore);
		}
	}
	//  初始化
	else {
		const render = store.store.render ? JSON.parse(JSON.stringify(store.store.render)) : {};
		OriginalAppStore.render = render;
		// 初始化设置
		store.store = OriginalAppStore;

		// Do not log the complete store: it contains encrypted AI credential material.
		logger.log('store initialized');
	}

	/**
	 * 如果浏览器缓存为空，则初始化，如果不为空那就是用户自己设置了
	 */
	if (!store.store.paths.userDataDirsFolder) {
		OriginalAppStore.paths.userDataDirsFolder = path.resolve(app.getPath('userData'), './userDataDirs');
	} else {
		OriginalAppStore.paths.userDataDirsFolder = store.store.paths.userDataDirsFolder;
	}

	// 新增配置项需要兼容已有版本，即使应用版本号没有变化也要补齐默认值。
	store.set('ai', defaultsDeep(store.store.ai || {}, OriginalAppStore.ai));

	// 强制更新路径
	store.set('paths', OriginalAppStore.paths);

	if (!existsSync(store.store.paths.userDataDirsFolder)) {
		mkdirSync(store.store.paths.userDataDirsFolder, { recursive: true });
	}
	if (!existsSync(store.store.paths.extensionsFolder)) {
		mkdirSync(store.store.paths.extensionsFolder, { recursive: true });
	}
	if (!existsSync(store.store.paths.downloadFolder)) {
		mkdirSync(store.store.paths.downloadFolder, { recursive: true });
	}
}

/**
 * keytar was previously used for both renderer settings and the AI key. A
 * package without keytar cannot decrypt that format, so keep a recoverable
 * copy and start from safe defaults instead of crashing at module load.
 */
function resetLegacyEncryptedStore() {
	const legacyRender = isLegacyAesCiphertext(store.store.render);
	const legacyAIKey = isLegacyAesCiphertext(store.store.ai?.apiKeyEncrypted);
	if (!legacyRender && !legacyAIKey) return;

	const configPath = path.resolve(app.getPath('userData'), 'config.json');
	if (existsSync(configPath)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = path.resolve(app.getPath('userData'), `config.legacy-keytar-${stamp}.json`);
		copyFileSync(configPath, backupPath);
		logger.warn('检测到旧版 keytar/AES 配置，已备份并重置', { backupPath });
	}

	store.clear();
	store.store = JSON.parse(JSON.stringify(OriginalAppStore));
}

/** 字符串转换成版本对象 */
function parseVersion(version: string) {
	return new SemVer(valid(coerce(clean(version, { loose: true }))) || '0.0.0');
}
