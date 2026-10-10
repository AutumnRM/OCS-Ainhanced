<template>
	<div class="ai-config">
		<a-alert
			type="info"
			class="mb-3"
		>
			<div>AI 是自动答题的唯一答案来源，请在开始答题前完成连接测试。</div>
			<div>建议填写支持视觉输入的多模态模型 Responses API 地址。</div>
			<div>API Key 由桌面端加密保存，不会写入浏览器脚本配置。</div>
		</a-alert>

		<a-form
			:model="config"
			layout="vertical"
		>
			<a-form-item label="启用 AI 答题">
				<a-switch v-model="config.enabled" />
			</a-form-item>

			<a-form-item
				label="Responses API 请求地址"
				required
			>
				<a-input
					v-model="config.endpoint"
					placeholder="例如：https://api.deepseek.com/responses"
				/>
				<div class="field-note">地址会按填写内容原样请求，不会自动追加路径。</div>
			</a-form-item>

			<a-form-item
				label="模型 ID"
				required
			>
				<div class="model-row">
					<a-select
						v-model="config.modelId"
						allow-clear
						allow-search
						placeholder="输入或选择模型 ID"
					>
						<a-option
							v-for="model in models"
							:key="model.id"
							:value="model.id"
						>
							{{ model.name ? `${model.id}（${model.name}）` : model.id }}
						</a-option>
					</a-select>
					<a-button
						:loading="state.loadingModels"
						@click="loadModels"
						>获取模型</a-button
					>
				</div>
				<div class="field-note">请明确输入模型 ID，或保存地址和 Key 后获取模型列表。</div>
			</a-form-item>

			<a-form-item label="API Key">
				<a-input-password
					v-model="apiKey"
					placeholder="留空表示保持现有 Key"
				/>
				<div class="field-note">
					{{ config.keyConfigured ? '当前已保存 API Key；留空不会覆盖。' : '尚未保存 API Key。' }}
				</div>
			</a-form-item>

			<a-form-item label="附加系统提示词">
				<a-textarea
					v-model="config.extraInstructions"
					:auto-size="{ minRows: 4, maxRows: 10 }"
					placeholder="例如：优先依据教材术语作答。内置答题格式约束仍然有效。"
				/>
			</a-form-item>
		</a-form>

		<div class="actions">
			<a-button
				type="primary"
				:loading="state.saving"
				@click="save"
				>保存配置</a-button
			>
			<a-button
				:loading="state.testing"
				@click="test"
				>测试连接</a-button
			>
			<a-button
				status="danger"
				:disabled="!config.keyConfigured"
				@click="clearKey"
				>清除 API Key</a-button
			>
		</div>

		<a-alert
			v-if="state.message"
			:type="state.error ? 'error' : 'success'"
			class="mt-3"
		>
			{{ state.message }}
		</a-alert>
		<div
			v-if="state.loaded"
			class="status mt-3"
		>
			当前状态：{{ config.enabled && config.endpoint && config.keyConfigured ? '已配置' : '未完成配置' }}
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { remote } from '../utils/remote';

const config = reactive({
	enabled: false,
	endpoint: '',
	modelId: '',
	extraInstructions: '',
	keyConfigured: false
});
const apiKey = ref('');
const models = ref<{ id: string; name?: string }[]>([]);
const state = reactive({
	loaded: false,
	saving: false,
	testing: false,
	loadingModels: false,
	error: false,
	message: ''
});

function showMessage(message: string, error = false) {
	state.message = message;
	state.error = error;
}

async function loadModels() {
	state.loadingModels = true;
	showMessage('正在获取模型列表...');
	try {
		models.value = await remote.methods.call('listAIModels');
		showMessage(models.value.length ? `已获取 ${models.value.length} 个模型。` : '接口返回了空模型列表。');
	} catch (error) {
		showMessage(`获取模型失败：${String(error)}`, true);
	} finally {
		state.loadingModels = false;
	}
}

async function load() {
	try {
		Object.assign(config, await remote.methods.call('getAIConfig'));
	} catch (error) {
		showMessage(`读取 AI 配置失败：${String(error)}`, true);
	}
	state.loaded = true;
}

async function save() {
	state.saving = true;
	showMessage('');
	try {
		const input: Record<string, any> = {
			enabled: config.enabled,
			endpoint: config.endpoint,
			modelId: config.modelId,
			extraInstructions: config.extraInstructions
		};
		if (apiKey.value.trim()) input.apiKey = apiKey.value.trim();
		Object.assign(config, await remote.methods.call('saveAIConfig', input));
		apiKey.value = '';
		showMessage('AI 配置已保存。');
	} catch (error) {
		showMessage(`保存 AI 配置失败：${String(error)}`, true);
	} finally {
		state.saving = false;
	}
}

async function test() {
	state.testing = true;
	showMessage('正在测试 Responses API...');
	try {
		const result = await remote.methods.call('testAIConnection');
		showMessage(result?.can_answer ? '连接成功，模型返回格式正常。' : '连接成功，但模型没有返回可用答案。');
	} catch (error) {
		showMessage(`连接测试失败：${String(error)}`, true);
	} finally {
		state.testing = false;
	}
}

async function clearKey() {
	try {
		Object.assign(config, await remote.methods.call('clearAIKey'));
		apiKey.value = '';
		showMessage('API Key 已清除。');
	} catch (error) {
		showMessage(`清除 API Key 失败：${String(error)}`, true);
	}
}

onMounted(load);
</script>

<style scoped>
.ai-config {
	max-width: 760px;
	margin: 0 auto;
	padding-bottom: 32px;
}

.field-note,
.status {
	color: #86909c;
	font-size: 12px;
	line-height: 1.6;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.model-row {
	display: flex;
	gap: 8px;
	align-items: center;
}

.model-row .arco-select {
	flex: 1;
}
</style>
