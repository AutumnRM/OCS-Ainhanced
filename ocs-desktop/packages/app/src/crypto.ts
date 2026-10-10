import { safeStorage } from 'electron';

/**
 * Electron safeStorage is the only credential backend used by the application.
 * Keeping this module free of native third-party dependencies lets the main
 * process start before any user-facing recovery UI exists.
 */
export async function initAesKey(): Promise<void> {
	// Compatibility no-op for the existing startup task graph.
}

export function isEncryptionAvailable(): boolean {
	return safeStorage.isEncryptionAvailable();
}

export function encryptRenderString(plaintext: string): string {
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error('当前系统无法使用安全存储，拒绝保存敏感数据。');
	}
	return safeStorage.encryptString(plaintext).toString('base64');
}

export function decryptRenderString(encrypted: string): string {
	if (isLegacyAesCiphertext(encrypted)) {
		throw new Error('检测到旧版 keytar/AES 密文，需要重置旧配置。');
	}
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error('当前系统无法使用安全存储，无法读取敏感数据。');
	}
	return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
}

export function isLegacyAesCiphertext(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const parts = value.split(':');
	return parts.length >= 3 && parts.every((part) => /^[A-Za-z0-9+/]*={0,2}$/.test(part));
}

export function getDecryptedRenderData(store: { store: { render: any } }): any {
	if (typeof store?.store?.render === 'string') {
		return JSON.parse(decryptRenderString(store.store.render));
	}
	return store?.store?.render || {};
}
