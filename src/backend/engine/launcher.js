/**
 * @fileoverview 浏览器启动与生命周期管理
 * @description 负责启动 Camoufox（Playwright 内核）、注入指纹与代理，并在进程退出时做资源清理。
 *              导航和预热行为由工作池负责，本模块只负责启动浏览器。
 *
 * 约定：
 * - 登录模式会尽量保留 Profile（用户数据目录）
 * - 清理采用三级退出：Playwright close -> SIGTERM -> SIGKILL
 */

import { Camoufox } from 'camoufox-js';
import { sampleWebGL } from 'camoufox-js/dist/webgl/sample.js';
import { FingerprintGenerator } from 'fingerprint-generator';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createCursor } from 'ghost-cursor-playwright-port';
import { getRealViewport, clamp, random, sleep } from './utils.js';
import { getPrimaryDisplayWorkArea, applyDisplayToFingerprint, maximizeBrowserWindow } from './display.js';
import { logger } from '../../utils/logger.js';
import { getBrowserProxy, cleanupProxy } from '../../utils/proxy.js';

// 全局状态：用于在登录模式下管理残留进程与复用上下文
let globalBrowserProcess = null;
let globalContext = null; // 替代 globalBrowser

/**
 * 清理浏览器资源和进程
 * 实现三级退出机制: Playwright close -> SIGTERM -> SIGKILL
 * @returns {Promise<void>}
 */
export async function cleanup() {

    // Level 1: 通过 Playwright 协议优雅关闭 Context，保存 Profile
    if (globalContext) {
        try {
            logger.debug('浏览器', '正在断开远程调试连接并保存 Profile...');
            await globalContext.close();
            globalContext = null;
            logger.debug('浏览器', '已关闭浏览器上下文');
        } catch (e) {
            logger.warn('浏览器', `关闭上下文失败: ${e.message}`);
        }
    }

    // Level 2 & 3: 处理残留进程 (主要用于登录模式)
    if (globalBrowserProcess && !globalBrowserProcess.killed) {
        logger.info('浏览器', '正在终止浏览器进程...');
        try {
            // Level 2: 发送 SIGTERM (软杀)
            globalBrowserProcess.kill('SIGTERM');

            // 等待进程退出
            const start = Date.now();
            while (Date.now() - start < 2000) {
                try {
                    process.kill(globalBrowserProcess.pid, 0);
                    await new Promise(r => setTimeout(r, 200));
                } catch (e) {
                    break;
                }
            }
        } catch (e) { }

        // Level 3: 强制查杀 (SIGKILL)
        try {
            process.kill(globalBrowserProcess.pid, 0);
            logger.debug('浏览器', '浏览器进程无响应，执行强制终止 (SIGKILL)...');
            process.kill(-globalBrowserProcess.pid, 'SIGKILL');
        } catch (e) { }

        globalBrowserProcess = null;
        logger.info('浏览器', '浏览器进程已终止');
    }

    // 清理代理
    await cleanupProxy();
}

// 防止重复注册
let signalHandlersRegistered = false;

/**
 * 注册进程退出信号处理
 * @private
 */
function registerCleanupHandlers() {
    if (signalHandlersRegistered) return;

    process.on('exit', () => {
        if (globalBrowserProcess) globalBrowserProcess.kill();
    });

    process.on('SIGINT', async () => {
        await cleanup();
        process.exit();
    });

    process.on('SIGTERM', async () => {
        await cleanup();
        process.exit();
    });

    signalHandlersRegistered = true;
}

/**
 * 获取当前操作系统名称
 * 将 Node.js 的 platform 转换为 Camoufox/FingerprintGenerator 支持的格式
 */
function getCurrentOS() {
    const platform = os.platform();
    if (platform === 'win32') return 'windows';
    if (platform === 'darwin') return 'macos';
    // 其他情况默认为 linux
    return 'linux';
}

/**
 * 获取 WebGL 平台标识
 * 将操作系统名称转换为 sampleWebGL 支持的格式
 */
function getWebGLPlatform(osName) {
    if (osName === 'windows') return 'win';
    if (osName === 'macos') return 'mac';
    return 'lin';
}

/**
 * 获取或生成持久化指纹 (含 WebGL 配置校验)
 * @param {string} filePath - JSON文件保存路径
 */
async function getPersistentFingerprint(filePath) {
    // 确保 data 目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let fingerprintData = null;
    let webglPair = null;
    let shouldSave = false;
    const currentOS = getCurrentOS();
    const targetWebGLOS = getWebGLPlatform(currentOS);

    // 1. 尝试读取现有指纹
    if (fs.existsSync(filePath)) {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf8');
            fingerprintData = JSON.parse(fileContent);
        } catch (e) {
            logger.warn('浏览器', `指纹文件损坏: ${e.message}`);
        }
    }

    // 2. 校验 WebGL 配置的有效性 (从 videoCard 读取)
    if (fingerprintData?.videoCard?.['webGl:vendor'] && fingerprintData?.videoCard?.['webGl:renderer']) {
        const savedVendor = fingerprintData.videoCard['webGl:vendor'];
        const savedRenderer = fingerprintData.videoCard['webGl:renderer'];
        try {
            // 拿着保存的配置，去数据库里"试探"一下是否存在
            await sampleWebGL(targetWebGLOS, savedVendor, savedRenderer);

            // 如果没报错，说明配置有效，保留使用
            webglPair = [savedVendor, savedRenderer];
            logger.debug('浏览器', `加载 WebGL 配置成功: ${savedRenderer}`);
        } catch (e) {
            // 数据库里没找到 -> 配置失效
            logger.warn('浏览器', `保存的 WebGL 配置与当前系统(${targetWebGLOS})不匹配，将重新生成`);
            webglPair = null;
            shouldSave = true;
        }
    }

    // 3. 如果指纹完全不存在，生成新的基础指纹
    if (!fingerprintData) {
        logger.info('浏览器', `正在为系统 [${currentOS}] 生成新指纹...`);
        const generatorOptions = {
            browsers: ['firefox'],
            operatingSystems: [currentOS],
            devices: ['desktop'],
            locales: ['en-US'],
            screen: { minWidth: 1280, maxWidth: 1366, minHeight: 720, maxHeight: 768 }
        };
        const generator = new FingerprintGenerator(generatorOptions);
        fingerprintData = generator.getFingerprint().fingerprint;

        // 清洗 UA 版本
        if (fingerprintData.navigator) {
            let ua = fingerprintData.navigator.userAgent;
            const TARGET_VERSION = "135.0";
            ua = ua.replace(/rv:[\d\.]+/g, `rv:${TARGET_VERSION}`);
            ua = ua.replace(/Firefox\/[\d\.]+/g, `Firefox/${TARGET_VERSION}`);
            fingerprintData.navigator.userAgent = ua;
        }

        // 清洗插件数据
        if (fingerprintData.pluginsData) {
            fingerprintData.pluginsData.plugins = [];
            fingerprintData.pluginsData.mimeTypes = [];
        }

        shouldSave = true;
    }

    // 4. 如果 WebGL 配置为空，重新生成
    if (!webglPair) {
        try {
            logger.info('浏览器', `正在生成新的 WebGL 配置 (${targetWebGLOS})...`);
            const webglData = await sampleWebGL(targetWebGLOS);
            webglPair = [webglData['webGl:vendor'], webglData['webGl:renderer']];

            // 覆盖 videoCard
            fingerprintData.videoCard = {
                'webGl:vendor': webglPair[0],
                'webGl:renderer': webglPair[1]
            };

            shouldSave = true;
        } catch (e) {
            logger.error('浏览器', `致命错误：无法生成 WebGL 配置: ${e.message}`);
        }
    }

    // 5. 如果 Canvas 噪点不存在，生成新的
    if (fingerprintData.canvasOffset === undefined) {
        const offset = Math.floor(Math.random() * 41) - 20;
        fingerprintData.canvasOffset = offset;
        logger.info('浏览器', `已生成 Canvas 噪点偏移: ${offset}`);
        shouldSave = true;
    }

    // 5. 如果有变动，保存回文件
    if (shouldSave) {
        fs.writeFileSync(filePath, JSON.stringify(fingerprintData, null, 2));
        logger.info('浏览器', `指纹已更新并保存至: ${filePath}`);
    }

    return fingerprintData;
}

/**
 * 启动浏览器实例 (仅负责启动，不负责导航和预热)
 * 
 * 导航到目标页面、注册导航处理器、预热行为由工作池 (pool.js) 负责。
 * 
 * @param {object} config - 全局配置对象
 * @param {object} options - 启动选项
 * @param {string} options.userDataDir - 用户数据目录路径
 * @param {string} [options.userDataMark] - 用户数据目录标识 (用于日志显示)
 * @param {object} [options.proxyConfig] - Worker 级代理配置
 * @returns {Promise<{context: object, page: object}>} 浏览器上下文和初始页面
 */
export async function initBrowserBase(config, options = {}) {
    const {
        userDataDir,
        instanceName = null,
        proxyConfig = null
    } = options;

    // 日志标识 (优先使用实例名称)
    const markLabel = instanceName || '默认';

    // 检测登录模式和 Xvfb 模式
    const isLoginMode = process.argv.some(arg => arg.startsWith('-login'));
    const isXvfbMode = process.env.XVFB_RUNNING === 'true';
    const headlessMode = config?.browser?.headless && !isLoginMode && !isXvfbMode;

    // 如果配置了无头模式但被强制禁用，输出原因
    if (config?.browser?.headless && !headlessMode) {
        const reasons = [];
        if (isLoginMode) reasons.push('登录模式');
        if (isXvfbMode) reasons.push('Xvfb 模式');
        logger.info('浏览器', `[${markLabel}] 无头模式已被禁用 (${reasons.join(' + ')})`);
    }

    logger.info('浏览器', `[${markLabel}] 启动浏览器实例...`);

    const browserConfig = config?.browser || {};

    // 有头模式：不强制固定视口，让页面内容跟随窗口尺寸（避免窗口最大化后右侧/底部出现空白）
    const useRealWindowViewport = !headlessMode;
    // 有头模式：把窗口调整为屏幕工作区大小（等价于最大化），可通过 browser.windowMaximized 关闭
    const wantMaximizedWindow = useRealWindowViewport && browserConfig.windowMaximized !== false;

    // 获取指纹对象（指纹文件放在对应的 userDataDir 内）
    const fingerprintPath = path.join(userDataDir, 'fingerprint.json');
    const myFingerprint = await getPersistentFingerprint(fingerprintPath);

    // 按主显示器尺寸调整窗口（仅修改内存中的指纹，不回写文件）
    if (wantMaximizedWindow) {
        const display = await getPrimaryDisplayWorkArea();
        if (display && applyDisplayToFingerprint(myFingerprint, display)) {
            logger.info('浏览器', `[${markLabel}] 窗口将按主显示器工作区调整: ${display.workWidth}x${display.workHeight} (分辨率 ${display.screenWidth}x${display.screenHeight})`);
        } else {
            logger.debug('浏览器', `[${markLabel}] 未能探测显示器尺寸，窗口沿用指纹尺寸`);
        }
    }

    // 构造 Camoufox 启动选项
    const currentOS = getCurrentOS();
    const camoufoxLaunchOptions = {
        executable_path: browserConfig.path || undefined,
        headless: headlessMode,
        user_data_dir: userDataDir,
        ff_version: 135,
        fingerprint: myFingerprint,
        os: currentOS,
        i_know_what_im_doing: true,
        webgl_config: myFingerprint.videoCard ? [myFingerprint.videoCard['webGl:vendor'], myFingerprint.videoCard['webGl:renderer']] : undefined,
        block_webrtc: true,
        exclude_addons: ['UBO'],
        geoip: true,
        humanize: browserConfig.humanizeCursor === 'camou',
        config: {
            forceScopeAccess: true,
            // Canvas 抗指纹：注入固定噪点偏移
            'canvas:aaOffset': myFingerprint.canvasOffset ?? 0,
            'canvas:aaCapOffset': true
        },
        // 关闭动画减轻资源压力
        firefox_user_prefs: {
            // 禁用背景模糊滤镜 (高 CPU 消耗)
            'layout.css.backdrop-filter.enabled': false,
            // 告诉网页用户倾向于减少动画 (触发网页自身的优化)
            'ui.prefersReducedMotion': 1,
            // 站点隔离
            ...(browserConfig.fission === false ? { 'fission.autostart': false } : {})
        }
    };

    // 有头模式：禁用 Playwright 的固定视口（viewport: null），
    // 让页面使用真实窗口尺寸，窗口被放大/最大化时内容会自动铺满，不再出现空白区域
    if (useRealWindowViewport) {
        camoufoxLaunchOptions.viewport = null;
    }

    // 代理配置
    const proxyObj = await getBrowserProxy(proxyConfig);
    if (proxyObj) {
        camoufoxLaunchOptions.proxy = proxyObj;
    }

    // 内容进程沙箱默认关闭 (MOZ_DISABLE_CONTENT_SANDBOX=1)
    // 原因: 部分环境 (受限的 Windows / 虚拟机 / 容器) 下 Firefox 内容进程沙箱不可用，
    //       会导致浏览器启动卡到 180s 超时并降级进入安全模式 (表现为 /v1 接口 503)。
    // 策略: 仅在用户未显式设置该环境变量时注入默认值；显式设置可覆盖。
    //       如需保留沙箱，可将 browser.disableContentSandbox 设为 false。
    if (browserConfig.disableContentSandbox !== false && process.env.MOZ_DISABLE_CONTENT_SANDBOX === undefined) {
        process.env.MOZ_DISABLE_CONTENT_SANDBOX = '1';
        logger.info('浏览器', `[${markLabel}] 已默认禁用内容进程沙箱 (MOZ_DISABLE_CONTENT_SANDBOX=1)`);
    }

    // 启动 Camoufox
    const context = await Camoufox(camoufoxLaunchOptions);
    globalContext = context;

    // 构建状态描述
    const statusParts = [];
    statusParts.push(`无头模式: ${headlessMode ? '是' : '否'}`);
    if (proxyObj) statusParts.push('代理: 已配置');
    logger.info('浏览器', `[${markLabel}] 浏览器已启动 (${statusParts.join(', ')})`);

    // 注册清理处理器
    registerCleanupHandlers();

    // 注册断开连接事件（不再自动退出进程，由 Worker 决定后续行为）
    context.on('close', async () => {
        logger.warn('浏览器', `[${markLabel}] 浏览器已断开连接`);
        // 清理全局状态，但不退出进程
        globalContext = null;
        globalBrowserProcess = null;
    });

    // 获取或创建 Page
    let page;
    const existingPages = context.pages();
    if (existingPages.length > 0) {
        page = existingPages[0];
    } else {
        page = await context.newPage();
    }

    // 视口处理：
    // - 无头模式：强制固定视口为指纹屏幕尺寸（保证渲染稳定、坐标可预期）
    // - 有头模式：已通过 viewport: null 使用真实窗口尺寸，无需（也不应）再固定视口
    if (!useRealWindowViewport) {
        const screenWidth = myFingerprint.screen?.availWidth || 1366;
        const screenHeight = myFingerprint.screen?.availHeight || 768;
        await page.setViewportSize({ width: screenWidth, height: screenHeight });
    }

    // 有头模式：真正最大化窗口（等价于点击最大化按钮）
    // 指纹里的窗口尺寸只是把窗口"调大"，sizemode 仍是 normal；这里再触发一次系统级最大化
    if (wantMaximizedWindow) {
        const maximized = await maximizeBrowserWindow();
        if (maximized) {
            logger.info('浏览器', `[${markLabel}] 窗口已最大化`);
        } else {
            logger.warn('浏览器', `[${markLabel}] 窗口最大化未生效，窗口尺寸将保持为主显示器工作区大小`);
        }
    }

    // CSS 性能优化注入
    const cssInjectConfig = browserConfig.cssInject || {};
    const cssToInject = [];

    if (cssInjectConfig.animation) {
        cssToInject.push(`
            *, *::before, *::after {
                /* 过渡和关键帧动画 */
                transition: none !important;
                animation: none !important;
                transition-property: none !important;
                
                /* 平滑滚动 */
                scroll-behavior: auto !important;
            }
            
            /* transform 动画 */
            *:not(dummy-selector) {
                transition-duration: 0s !important;
                animation-duration: 0s !important;
                transition-delay: 0s !important;
                animation-delay: 0s !important;
            }
        `);
    }

    if (cssInjectConfig.filter) {
        cssToInject.push(`
            *, *::before, *::after {
                filter: none !important;
                backdrop-filter: none !important;
                box-shadow: none !important;
                text-shadow: none !important;
                mix-blend-mode: normal !important;
            }
        `);
    }

    if (cssInjectConfig.font) {
        cssToInject.push(`
            html, body {
                text-rendering: optimizeSpeed !important;
            }
        `);
    }

    // 只有当至少一个开关启用时才进行注入，防止影响浏览器指纹
    if (cssToInject.length > 0) {
        const cssString = cssToInject.join('\n');
        await context.addInitScript(`
            (function() {
                const style = document.createElement('style');
                style.textContent = ${JSON.stringify(cssString)};
                if (document.head) {
                    document.head.appendChild(style);
                } else {
                    document.addEventListener('DOMContentLoaded', () => {
                        document.head.appendChild(style);
                    });
                }
            })();
        `);
        const enabledFeatures = [];
        if (cssInjectConfig.animation) enabledFeatures.push('动画禁用');
        if (cssInjectConfig.filter) enabledFeatures.push('滤镜禁用');
        if (cssInjectConfig.font) enabledFeatures.push('字体优化');
        logger.info('浏览器', `[${markLabel}] CSS 注入已启用: ${enabledFeatures.join(', ')}`);
    }

    // 返回 context 和 page（导航、预热、cursor 初始化由工作池负责）
    return {
        context,
        page
    };
}

// 导出工具函数供 pool.js 使用
export { createCursor, getRealViewport, clamp, random, sleep };
