const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { parseAIAnswer } = require('../ocs-desktop/packages/app/lib/src/ai.protocol');
http
	.createServer((req, res) => {
		if (req.method === 'POST' && req.url === '/ai/responses') {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				const { index } = JSON.parse(body);
				const answers = [
					['选项乙'],
					['选项一', '选项二'],
					['对'],
					['填充值甲', '填充值乙'],
					['这是用于验证富文本填写的模拟答复。']
				][index];
				const raw = {
					output_text: '',
					output: [
						{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '{not an answer}' }] },
						{
							type: 'message',
							content: [{ type: 'output_text', text: JSON.stringify({ can_answer: true, answers, confidence: 1 }) }]
						}
					]
				};
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify(parseAIAnswer(raw)));
			});
		} else if (req.url === '/study.js') {
			const ts = require('typescript');
			const source = fs.readFileSync(path.join(__dirname, '../packages/scripts/src/utils/mooc-study.ts'), 'utf8');
			res.setHeader('Content-Type', 'text/javascript');
			res.end(
				ts.transpileModule(source, {
					compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 }
				}).outputText
			);
		} else if (req.url === '/study') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(fs.readFileSync(path.join(__dirname, 'mooc-study-fixture.html')));
		} else if (req.url === '/core.js') {
			res.setHeader('Content-Type', 'text/javascript');
			res.end(fs.readFileSync(path.join(__dirname, '../dist/core.js')));
		} else if (req.url === '/') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(fs.readFileSync(path.join(__dirname, 'mooc-browser-fixture.html')));
		} else {
			res.statusCode = 404;
			res.end();
		}
	})
	.listen(15320, '127.0.0.1', () => console.log('MOOC regression fixture: http://127.0.0.1:15320'));
