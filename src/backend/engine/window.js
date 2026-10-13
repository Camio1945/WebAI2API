/**
 * @fileoverview 浏览器窗口可见性保障
 * @description 有头模式下，浏览器窗口被其它窗口完全遮挡（或最小化）时，Firefox 会暂停
 *              刷新驱动（requestAnimationFrame 不再触发）。Playwright 的
 *              scrollIntoViewIfNeeded / click 都依赖 rAF 做 "stable" 检测，一旦 rAF
 *              被暂停就会永久挂起，最终表现为 `CLICK_TIMEOUT`。
 *
 *              本模块提供三件事：
 *              1. `probeRenderPaused`   - 页面内探测渲染是否被暂停（rAF 是否还在推进）
 *              2. `focusBrowserWindow`  - 系统级把 Camoufox 窗口恢复并提到前台
 *              3. `ensureWindowReady`   - 交互前的轻量守卫（节流），发现异常自动恢复
 *
 * 注意：真正根治遮挡问题的是 launcher 里注入的
 *      `widget.windows.window_occlusion_tracking.enabled = false`
 *      （Firefox 官方 WebDriver 推荐项，见 Bug 1802473）。
 *      本模块是兜底：处理窗口最小化、以及任何设置未生效的环境。
 */

import { execFile } from 'child_process';
import os from 'os';
import { logger } from '../../utils/logger.js';

/** 渲染暂停探测的节流间隔 (ms) —— 避免每次点击都做一次 evaluate */
const PROBE_INTERVAL = 1500;
/** 主动前置窗口的节流间隔 (ms) —— 系统级置顶有开销且会抢焦点，不宜频繁 */
const FOCUS_INTERVAL = 5000;
/** rAF 探测的判定窗口 (ms) */
const RAF_PROBE_WINDOW = 300;

/**
 * 执行外部命令并返回 stdout（失败/超时返回 null）
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} [timeout=5000]
 * @returns {Promise<string|null>}
 */
function run(cmd, args, timeout = 5000) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        try {
            const child = execFile(
                cmd,
                args,
                { timeout, windowsHide: true, maxBuffer: 64 * 1024 },
                (err, stdout) => {
                    if (err) return finish(null);
                    finish(String(stdout || '').trim());
                }
            );
            child.on('error', () => finish(null));
        } catch (e) {
            finish(null);
        }
    });
}

/**
 * 给任意 Promise 加一个硬超时，超时后返回 fallback（不抛错）
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };
        const timer = setTimeout(() => finish(fallback), ms);
        Promise.resolve(promise)
            .then((v) => finish(v))
            .catch(() => finish(fallback))
            .finally(() => clearTimeout(timer));
    });
}

/**
 * 执行一段 PowerShell 脚本（用 -EncodedCommand 传递，规避引号转义问题）
 * @param {string[]} scriptLines
 * @param {number} timeout
 * @returns {Promise<string|null>}
 */
function runPowerShell(scriptLines, timeout = 8000) {
    const script = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        ...scriptLines
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeout);
}

/**
 * 系统级把 Camoufox 窗口恢复（若最小化）并提到前台
 *
 * Windows 下 SetForegroundWindow 有"前台锁"限制：只有前台进程自己（或得到前台进程
 * 输入队列绑定的线程）才能真正切换前台窗口，否则只会在任务栏闪烁。
 * 这里使用 AttachThreadInput 绑定前台线程后再置顶，确保跨进程也能生效。
 *
 * @param {number} [timeoutMs=5000] - 等待窗口出现的超时（毫秒）
 * @returns {Promise<boolean>} 是否成功把窗口提到前台
 */
export async function focusBrowserWindow(timeoutMs = 5000) {
    const wait = Math.max(800, timeoutMs);
    const platform = os.platform();

    try {
        if (platform === 'win32') {
            const script = [
                'Add-Type -TypeDefinition ' +
                "'using System; using System.Runtime.InteropServices; " +
                'public class WbFocusNative { ' +
                '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); ' +
                '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); ' +
                '[DllImport("user32.dll")] public static extern uint GetCurrentThreadId(); ' +
                '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach); ' +
                '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
                '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd); ' +
                '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); ' +
                '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); ' +
                '[DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd); ' +
                "}'",
                `$deadline = (Get-Date).AddMilliseconds(${wait})`,
                'while ((Get-Date) -lt $deadline) {',
                '  $p = Get-Process camoufox -ErrorAction SilentlyContinue | ' +
                'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
                '  if ($p) {',
                '    $hwnd = $p.MainWindowHandle',
                // SW_RESTORE = 9：最小化时先还原，否则置顶无效
                '    if ([WbFocusNative]::IsIconic($hwnd)) { [WbFocusNative]::ShowWindow($hwnd, 9) | Out-Null; Start-Sleep -Milliseconds 300 }',
                '    $fg = [WbFocusNative]::GetForegroundWindow()',
                '    if ($fg -ne $hwnd) {',
                '      $fgPid = [uint32]0',
                '      $fgTid = [WbFocusNative]::GetWindowThreadProcessId($fg, [ref]$fgPid)',
                '      $curTid = [WbFocusNative]::GetCurrentThreadId()',
                '      [WbFocusNative]::AttachThreadInput($fgTid, $curTid, $true) | Out-Null',
                '      [WbFocusNative]::SetForegroundWindow($hwnd) | Out-Null',
                '      [WbFocusNative]::BringWindowToTop($hwnd) | Out-Null',
                '      [WbFocusNative]::SetFocus($hwnd) | Out-Null',
                '      [WbFocusNative]::AttachThreadInput($fgTid, $curTid, $false) | Out-Null',
                '    }',
                '    Start-Sleep -Milliseconds 150',
                '    if ([WbFocusNative]::GetForegroundWindow() -eq $hwnd) { Write-Output "focused"; exit 0 }',
                '    Write-Output "not-focused"; exit 0',
                '  }',
                '  Start-Sleep -Milliseconds 250',
                '}',
                'Write-Output "no-window"'
            ];

            const out = await runPowerShell(script, wait + 4000);
            return /focused/.test(out || '');
        }

        if (platform === 'linux') {
            // Xvfb / 普通 X11 桌面：优先 wmctrl，回退 xdotool
            const wmctrlOut = await run('bash', ['-lc',
                'id=$(wmctrl -lx 2>/dev/null | grep -i camoufox | awk \'{print $1}\' | head -1); ' +
                'if [ -n "$id" ]; then wmctrl -i -a "$id" && echo ok; fi'
            ], 8000);
            if (/ok/.test(wmctrlOut || '')) return true;

            const xdotoolOut = await run('bash', ['-lc',
                'id=$(xdotool search --onlyvisible --class camoufox 2>/dev/null | head -1); ' +
                'if [ -n "$id" ]; then xdotool windowactivate --sync "$id" && echo ok; fi'
            ], 8000);
            return /ok/.test(xdotoolOut || '');
        }

        if (platform === 'darwin') {
            const out = await run('osascript', ['-e',
                'tell application "System Events" to set frontmost of (first process whose name contains "camoufox") to true'
            ], 8000);
            return out !== null;
        }

        return false;
    } catch (e) {
        logger.debug('浏览器', `窗口前置失败: ${e.message}`);
        return false;
    }
}

/**
 * 把页面/窗口提到前台（先走 Playwright 的 bringToFront，失败再用系统级方案）
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<boolean>} 是否成功
 */
export async function bringPageToFront(page, meta = {}) {
    try {
        if (!page || page.isClosed()) return false;

        // 1. Playwright/Juggler 层：激活标签页（开销极低）
        await withTimeout(page.bringToFront(), 3000, null);

        // 2. 系统层：真正把 OS 窗口提到前台（覆盖最小化/遮挡）
        const ok = await focusBrowserWindow(4000);
        logger.debug('浏览器', `[窗口] 已尝试将浏览器窗口置前 (${ok ? '成功' : '未确认'})`, meta);
        return ok;
    } catch (e) {
        logger.debug('浏览器', `[窗口] 窗口置前异常: ${e.message}`, meta);
        return false;
    }
}

/**
 * 探测页面是否处于"不可交互渲染"状态
 *
 * 判定为 true 的两种情况：
 * 1. document.visibilityState === 'hidden' —— 窗口被最小化
 * 2. requestAnimationFrame 超时未触发 —— 刷新驱动被暂停（窗口被完全遮挡等）
 *
 * 这两种状态下 Playwright 的 stable 检测 / contentQuads 都会失效，
 * 点击会一直重试到超时（CLICK_TIMEOUT）。
 *
 * @param {import('playwright-core').Page} page - 页面对象
 * @returns {Promise<boolean|null>} true=需要恢复窗口, false=正常, null=无法判断
 */
export async function probeRenderPaused(page) {
    if (!page || page.isClosed()) return null;

    try {
        return await withTimeout(
            page.evaluate((probeWindow) => new Promise((resolve) => {
                let settled = false;
                const finish = (v) => {
                    if (settled) return;
                    settled = true;
                    resolve(v);
                };

                // 1. 窗口最小化 / 标签页在后台：Firefox 会把页面标记为 hidden
                try {
                    if (document.visibilityState === 'hidden') {
                        finish(true);
                        return;
                    }
                } catch (e) { /* ignore */ }

                // 2. rAF 能触发 => 刷新驱动正常
                try {
                    requestAnimationFrame(() => finish(false));
                } catch (e) {
                    finish(false);
                }

                // 3. 超时仍未触发 => 渲染被暂停
                setTimeout(() => finish(true), probeWindow);
            }), RAF_PROBE_WINDOW),
            1500,
            null
        );
    } catch (e) {
        return null;
    }
}

/**
 * 交互前的窗口守卫：发现渲染被暂停时自动把窗口提到前台
 *
 * 节流策略：
 * - 未开启 windowAutoFocus 时：每 PROBE_INTERVAL 最多探测一次（一次 evaluate，开销极小）
 * - 开启 windowAutoFocus 时：每 FOCUS_INTERVAL 主动置前一次
 *
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<void>}
 */
export async function ensureWindowReady(page, meta = {}) {
    try {
        if (!page || page.isClosed()) return;

        const ctx = typeof page.context === 'function' ? page.context() : null;
        // 仅无头模式关闭该守卫（无头窗口不存在遮挡问题）；默认开启
        const enabled = page._windowReadyCheck ?? ctx?._windowReadyCheck ?? true;
        if (!enabled) return;

        const autoFocus = page._windowAutoFocus === true;
        const now = Date.now();
        const interval = autoFocus ? FOCUS_INTERVAL : PROBE_INTERVAL;
        if (now - (page._lastWindowCheckAt || 0) < interval) return;
        page._lastWindowCheckAt = now;

        if (autoFocus) {
            await bringPageToFront(page, meta);
            return;
        }

        const paused = await probeRenderPaused(page);
        if (paused === true) {
            logger.warn('浏览器', '[窗口] 检测到浏览器渲染被暂停（窗口可能被遮挡或最小化），正在将其置前...', meta);
            await bringPageToFront(page, meta);
        }
    } catch (e) {
        logger.debug('浏览器', `[窗口] 窗口守卫异常: ${e.message}`, meta);
    }
}

/**
 * 把浏览器窗口相关配置挂到 page 上，供引擎层读取
 * @param {import('playwright-core').Page} page - 页面对象
 * @param {object} [browserConfig={}] - browser 配置段
 * @param {boolean} [headless=false] - 是否无头模式
 * @returns {void}
 */
export function applyWindowOptions(page, browserConfig = {}, headless = false) {
    if (!page) return;
    page._windowAutoFocus = browserConfig?.windowAutoFocus === true;
    page._windowReadyCheck = !headless;
}
