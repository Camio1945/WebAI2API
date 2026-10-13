#!/usr/bin/env node
/**
 * @fileoverview 通过 WebAI2API 向 DeepSeek 提问（支持联网搜索 / 深度思考 / 专业模式）
 *
 * 前置条件：
 *   1. data/config.yaml 中存在 type 为 deepseek_text 的 worker（默认已有名为 deepseek 的 worker）
 *   2. 该浏览器实例已登录 https://chat.deepseek.com/（用 npm start -- -login=deepseek 完成）
 *   3. 服务已启动（npm start）
 *
 * 用法：
 *   node scripts/ask-deepseek.mjs "帮我查一下今天上海的天气"
 *   node scripts/ask-deepseek.mjs --thinking "9.11 和 9.9 哪个大"
 *   node scripts/ask-deepseek.mjs --no-search "写一首关于秋天的诗"
 *   node scripts/ask-deepseek.mjs --expert "详细讲讲 Transformer 的注意力机制"
 *   node scripts/ask-deepseek.mjs --model deepseek-search "任意问题"
 *
 * 参数：
 *   --model <id>   直接指定模型 ID（优先级最高）
 *   --search       开启联网搜索（默认开启）
 *   --no-search    关闭联网搜索
 *   --thinking     开启深度思考 DeepThink
 *   --expert       使用 Expert 专业模式
 *   --base <url>   API 地址，默认 http://127.0.0.1:<配置端口>
 *   --key <token>  API 密钥，默认读取 data/config.yaml 的 server.auth
 *   --no-stream    关闭流式输出（不推荐，长任务容易超时）
 *   --raw          额外打印完整 JSON 响应
 *   -h, --help     显示帮助
 *
 * 环境变量：API_BASE / API_KEY
 */

import fs from 'fs';
import path from 'path';
import process from 'process';
import yaml from 'yaml';

const argv = process.argv.slice(2);

let modelArg = null;
let useSearch = true;
let useThinking = false;
let useExpert = false;
let baseUrl = process.env.API_BASE || '';
let apiKey = process.env.API_KEY || '';
let useStream = true;
let printRaw = false;
const promptParts = [];

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
        case '--model': modelArg = argv[++i]; break;
        case '--search': useSearch = true; break;
        case '--no-search': useSearch = false; break;
        case '--thinking': useThinking = true; break;
        case '--expert': useExpert = true; break;
        case '--base': baseUrl = argv[++i]; break;
        case '--key': apiKey = argv[++i]; break;
        case '--no-stream': useStream = false; break;
        case '--raw': printRaw = true; break;
        case '-h':
        case '--help': printHelp(); process.exit(0); break;
        default: promptParts.push(a);
    }
}

/** 读取项目配置，用于补全端口和鉴权 token */
function readConfig() {
    const candidates = [
        path.join(process.cwd(), 'data', 'config.yaml'),
        path.join(process.cwd(), 'config.yaml')
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            try { return yaml.parse(fs.readFileSync(p, 'utf8')) || {}; } catch { return {}; }
        }
    }
    return {};
}

function printHelp() {
    const self = path.relative(process.cwd(), new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    console.log(`
用法: node ${self} [选项] "你的问题"

选项:
  --model <id>   直接指定模型 ID
  --search       开启联网搜索 (默认)
  --no-search    关闭联网搜索
  --thinking     开启深度思考 DeepThink
  --expert       使用 Expert 专业模式
  --base <url>   API 地址 (默认 http://127.0.0.1:<配置端口>)
  --key <token>  API 密钥 (默认读取 data/config.yaml 的 server.auth)
  --no-stream    关闭流式输出
  --raw          额外打印完整 JSON

可用模型:
  deepseek / deepseek-thinking / deepseek-search / deepseek-thinking-search
  deepseek-expert / deepseek-thinking-expert / deepseek-search-expert
  deepseek-thinking-search-expert
`);
}

const config = readConfig();
const port = config?.server?.port || 46377;

if (!baseUrl) baseUrl = `http://127.0.0.1:${port}`;
baseUrl = baseUrl.replace(/\/+$/, '');
if (!apiKey) apiKey = config?.server?.auth || '';

// 组装模型 ID：顺序固定为 deepseek(-thinking)(-search)(-expert)
let model = modelArg;
if (!model) {
    const parts = ['deepseek'];
    if (useThinking) parts.push('thinking');
    if (useSearch) parts.push('search');
    if (useExpert) parts.push('expert');
    model = parts.join('-');
}

const prompt = promptParts.join(' ').trim();
if (!prompt) {
    printHelp();
    process.exit(1);
}

const isTty = process.stdout.isTTY;
const DIM = isTty ? '\x1b[2m' : '';
const RESET = isTty ? '\x1b[0m' : '';

async function main() {
    if (!useStream) {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                stream: false
            })
        });

        const json = await res.json();
        if (printRaw) console.log(JSON.stringify(json, null, 2));

        if (json.error) {
            console.error(`\n[错误] ${json.error.message || JSON.stringify(json.error)}`);
            process.exit(1);
        }
        const msg = json.choices?.[0]?.message || {};
        if (msg.reasoning_content) {
            console.log(`${DIM}[思考过程]\n${msg.reasoning_content}${RESET}\n`);
        }
        console.log(msg.content || '');
        return;
    }

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true
        })
    });

    if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        console.error(`\n[HTTP ${res.status}] ${text}`);
        process.exit(1);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let printedThinkingHeader = false;
    let printedContentHeader = false;
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) continue;

            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;

            let chunk;
            try { chunk = JSON.parse(payload); } catch { continue; }

            if (chunk.error) {
                console.error(`\n[错误] ${chunk.error.message || JSON.stringify(chunk.error)}`);
                process.exit(1);
            }

            const delta = chunk.choices?.[0]?.delta || {};

            if (delta.reasoning_content) {
                if (!printedThinkingHeader) {
                    process.stdout.write(`${DIM}[思考过程]\n`);
                    printedThinkingHeader = true;
                }
                process.stdout.write(`${DIM}${delta.reasoning_content}${RESET}`);
            }

            if (delta.content) {
                if (!printedContentHeader) {
                    if (printedThinkingHeader) process.stdout.write('\n\n');
                    printedContentHeader = true;
                }
                fullText += delta.content;
                process.stdout.write(delta.content);
            }
        }
    }

    process.stdout.write('\n');
    if (printRaw) console.log(JSON.stringify({ model, content: fullText }, null, 2));
}

main().catch((err) => {
    console.error(`\n[请求失败] ${err.message}`);
    console.error(`请确认服务已启动且已登录 DeepSeek: ${baseUrl}`);
    process.exit(1);
});
