const { series, src, dest } = require('gulp');
const del = require('del');
const zip = require('gulp-zip');
const { execOut } = require('./utils');
const { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync, readdirSync } = require('fs');
const path = require('path');
const chromeInstall = require('./chrome.install').default;

let buildStagingDir;

function packageVersionPath(packagePath) {
	return path.resolve(packagePath);
}

function getDesktopVersion() {
	return JSON.parse(readFileSync(packageVersionPath('../package.json')).toString()).version;
}

function buildWeb() {
	return execOut('pnpm build', { cwd: '../packages/web' });
}

function bundleEnhancedOCS() {
	const sourceDir = path.resolve('../../dist');
	const targetDir = path.resolve('../packages/app/public/ocsjs');
	mkdirSync(targetDir, { recursive: true });
	copyFileSync(path.join(sourceDir, 'index.js'), path.join(targetDir, 'index.js'));
	copyFileSync(path.join(sourceDir, 'style.css'), path.join(targetDir, 'style.css'));
	copyFileSync(path.join(sourceDir, 'ocs.user.js'), path.join(targetDir, 'ocs.user.js'));
	return Promise.resolve();
}

function buildApp() {
	const version = getDesktopVersion();
	buildStagingDir = path.resolve(`../packages/app/.app-deploy-${version}`);
	const appDir = path.resolve('../packages/app');
	const builderConfig = path.resolve('../packages/app/electron.builder.json');
	const stagingBuilderConfig = path.join(buildStagingDir, 'electron.builder.json');

	return (async () => {
		// Never package stale TypeScript output. buildApp is also exposed as a resumable task.
		await runCommand('pnpm --filter @ocs-desktop/common tsc', { cwd: path.resolve('..') });
		await runCommand('pnpm --filter @ocs-desktop/app exec tsc', { cwd: path.resolve('..') });
		await del(buildStagingDir, { force: true });
		await runCommand(
			`pnpm --filter @ocs-desktop/app deploy --prod --ignore-scripts "${buildStagingDir}"`,
			{
			cwd: path.resolve('..')
			}
		);

		const stagingConfig = JSON.parse(readFileSync(builderConfig).toString());
		for (const target of ['win', 'mac', 'linux']) {
			for (const resource of stagingConfig[target]?.extraResources || []) {
				if (typeof resource.from === 'string') resource.from = resource.from.replace('../../bin/', '../../../bin/');
			}
		}
		writeFileSync(stagingBuilderConfig, `${JSON.stringify(stagingConfig, null, '\t')}\n`);
		cpSync(path.join(appDir, 'lib'), path.join(buildStagingDir, 'lib'), { recursive: true });
		cpSync(path.join(appDir, 'public'), path.join(buildStagingDir, 'public'), { recursive: true });

		await runCommand(
			`pnpm exec electron-builder --projectDir "${buildStagingDir}" --config "${stagingBuilderConfig}" --win --x64 --publish never`,
			{
				cwd: appDir
			}
		);
		auditPackagedApp(path.join(buildStagingDir, 'dist', 'win-unpacked', 'resources', 'app'));

		const stagingDist = path.join(buildStagingDir, 'dist');
		const outputDist = path.join(appDir, 'dist');
		for (const fileName of [`ocs-${version}-setup-win-x64.exe`, `ocs-${version}-setup-win-x64.exe.blockmap`]) {
			const source = path.join(stagingDist, fileName);
			if (require('fs').existsSync(source)) copyFileSync(source, path.join(outputDist, fileName));
		}
	})();
}

function auditPackagedApp(appPath) {
	const required = [
		'lib/index.js',
		'public/index.html',
		'public/ocsjs/ocs.user.js',
		'node_modules/@ocs-desktop/common/package.json'
	];
	for (const relative of required) {
		if (!existsSync(path.join(appPath, relative))) throw new Error(`安装包缺少运行时文件: ${relative}`);
	}
	const stack = [appPath];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (/keytar/i.test(entry.name)) throw new Error(`安装包仍包含已禁用的 keytar: ${path.join(dir, entry.name)}`);
			if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
		}
	}
	const mainSource = readFileSync(path.join(appPath, 'lib', 'index.js'), 'utf8');
	if (/require\(["']keytar["']\)/.test(mainSource)) throw new Error('主入口仍引用 keytar');
	if (!/require\(["']\.\/src\/main["']\)/.test(mainSource)) throw new Error('主入口不是新的动态启动入口，疑似打包了旧编译产物');
	console.log('安装包审计通过：入口、渲染页、增强脚本和工作区依赖完整，且不含 keytar。');
}

function runCommand(command, options) {
	return new Promise((resolve, reject) => {
		const child = execOut(command, options);
		child.once('error', reject);
		child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`命令执行失败(${code}): ${command}`))));
	});
}

function cleanOutput() {
	return del([`../packages/app/dist/app${getDesktopVersion()}.zip`], { force: true });
}

function cleanStaging() {
	return del(['../packages/app/.app-deploy-*'], { force: true });
}

function packResource() {
	const platform = process.env.PLATFORM || 'win';
	const unpackedDirs = {
		win: '../packages/app/dist/win-unpacked',
		mac: '../packages/app/dist/mac-unpacked',
		linux: '../packages/app/dist/linux-unpacked'
	};
	const persistedStagingDir = path.resolve(`../packages/app/.app-deploy-${getDesktopVersion()}`);
	const activeStagingDir = buildStagingDir || (existsSync(persistedStagingDir) ? persistedStagingDir : undefined);
	const unpackedDir = activeStagingDir
		? path.join(activeStagingDir, 'dist', platform === 'win' ? 'win-unpacked' : `${platform}-unpacked`)
		: unpackedDirs[platform] || unpackedDirs.win;
	return src(`${unpackedDir}/resources/app/**/*`)
		.pipe(zip(`app${getDesktopVersion()}.zip`))
		.pipe(dest('../packages/app/dist'));
}

exports.default = series(
	cleanOutput,
	buildWeb,
	bundleEnhancedOCS,
	chromeInstall,
	buildApp,
	packResource
);

// Named tasks make packaging/auditing resumable after a dependency or signing failure.
exports.buildApp = buildApp;
exports.bundleEnhancedOCS = bundleEnhancedOCS;
exports.packResource = packResource;
exports.cleanStaging = cleanStaging;
