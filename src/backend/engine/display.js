/**
 * @fileoverview 主显示器尺寸探测
 * @description 有头模式下用于把浏览器窗口调整为屏幕工作区大小（等价于"最大化"）。
 *              仅做只读探测，任何失败都返回 null，由调用方回退到指纹自带的窗口尺寸。
 */

import { execFile } from 'child_process';
import os from 'os';
import { logger } from '../../utils/logger.js';

// 进程内探测结果缓存（undefined=未探测, null=探测失败）
let displayCache;

/**
 * 执行命令并返回 stdout（失败/超时返回 null）
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
 * 从文本中解析 "宽x高"（兼容 "1920 1080"、"0, 0, 1920, 1080" 等格式）
 * @param {string|null} text
 * @returns {{width:number,height:number}|null}
 */
function parsePair(text) {
    if (!text) return null;
    const m = String(text).match(/(\d{2,5})\s*[xX, ]\s*(\d{2,5})/);
    if (!m) return null;
    const width = parseInt(m[1], 10);
    const height = parseInt(m[2], 10);
    if (!width || !height || width < 320 || height < 240) return null;
    return { width, height };
}

/**
 * 探测主显示器尺寸
 * @returns {Promise<{screenWidth:number,screenHeight:number,workWidth:number,workHeight:number}|null>}
 *          screen* 为分辨率，work* 为扣除任务栏后的工作区；探测失败返回 null
 */
export async function getPrimaryDisplayWorkArea() {
    // 进程内缓存：同一进程只探测一次
    if (displayCache !== undefined) return displayCache;
    displayCache = await detectPrimaryDisplay();
    return displayCache;
}

/**
 * 实际探测逻辑（平台相关）
 * @returns {Promise<object|null>}
 */
async function detectPrimaryDisplay() {
    const platform = os.platform();

    try {
        if (platform === 'win32') {
            // 一次拿到分辨率 + 工作区（PowerShell 默认 DPI 不感知，返回的坐标与 Firefox CSS 像素一致）
            const script =
                'Add-Type -AssemblyName System.Windows.Forms; ' +
                '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
                '$wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
                "Write-Output ($b.Width.ToString() + 'x' + $b.Height.ToString()); " +
                "Write-Output ($wa.Width.ToString() + 'x' + $wa.Height.ToString())";
            const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);

            if (out) {
                const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                const screen = parsePair(lines[0]);
                const work = parsePair(lines[1]) || screen;
                if (screen) {
                    return {
                        screenWidth: screen.width,
                        screenHeight: screen.height,
                        workWidth: work.width,
                        workHeight: work.height
                    };
                }
            }

            // 回退：仅分辨率（CIM，不依赖 WinForms 程序集）
            const res = await run('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                "(Get-CimInstance Win32_VideoController | Where-Object { $_.CurrentHorizontalResolution -gt 0 } | " +
                "Select-Object -First 1 | ForEach-Object { $_.CurrentHorizontalResolution.ToString() + 'x' + $_.CurrentVerticalResolution.ToString() })"
            ]);
            const fallback = parsePair(res);
            if (fallback) {
                return {
                    screenWidth: fallback.width,
                    screenHeight: fallback.height,
                    workWidth: fallback.width,
                    workHeight: fallback.height
                };
            }
            return null;
        }

        if (platform === 'darwin') {
            // "0, 0, 1440, 900"
            const out = await run('osascript', [
                '-e', 'tell application "Finder" to get bounds of window of desktop'
            ]);
            const nums = String(out || '').match(/\d+/g);
            if (nums && nums.length >= 4) {
                const w = parseInt(nums[2], 10) - parseInt(nums[0], 10);
                const h = parseInt(nums[3], 10) - parseInt(nums[1], 10);
                if (w >= 320 && h >= 240) {
                    return { screenWidth: w, screenHeight: h, workWidth: w, workHeight: h };
                }
            }
            return null;
        }

        // Linux / Xvfb
        const xdotool = await run('xdotool', ['getdisplaygeometry']);
        const parsed = parsePair(xdotool);
        if (parsed) {
            return {
                screenWidth: parsed.width,
                screenHeight: parsed.height,
                workWidth: parsed.width,
                workHeight: parsed.height
            };
        }
        const xdpyinfo = await run('xdpyinfo', []);
        const m = String(xdpyinfo || '').match(/dimensions:\s*(\d+)x(\d+)/);
        if (m) {
            const width = parseInt(m[1], 10);
            const height = parseInt(m[2], 10);
            return { screenWidth: width, screenHeight: height, workWidth: width, workHeight: height };
        }
        return null;
    } catch (e) {
        logger.debug('浏览器', `显示器尺寸探测失败: ${e.message}`);
        return null;
    }
}

/**
 * 把浏览器窗口真正最大化（等价于点击标题栏的最大化按钮）
 *
 * 说明：Camoufox 通过指纹的 window.outerWidth/outerHeight 决定窗口尺寸，但那只是"把窗口
 *       调大到工作区大小"，Firefox 的 sizemode 仍是 normal（可拖动、最大化按钮显示为"最大化"）。
 *       这里在浏览器启动后调用系统 API 触发真正的最大化状态。
 *
 * @param {number} [timeoutMs=8000] - 等待窗口出现的超时（毫秒）
 * @returns {Promise<boolean>} 是否成功最大化
 */
export async function maximizeBrowserWindow(timeoutMs = 8000) {
    const platform = os.platform();
    const wait = Math.max(1000, timeoutMs);

    try {
        if (platform === 'win32') {
            // 用 -EncodedCommand 传脚本，彻底规避 Windows 命令行引号转义问题
            const script = [
                "$ErrorActionPreference = 'SilentlyContinue'",
                'Add-Type -TypeDefinition ' +
                "'using System; using System.Runtime.InteropServices; " +
                'public class WbMaxNative { [DllImport("user32.dll")] ' +
                "public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); }'",
                `$deadline = (Get-Date).AddMilliseconds(${wait})`,
                'while ((Get-Date) -lt $deadline) {',
                '  $w = Get-Process camoufox -ErrorAction SilentlyContinue | ' +
                'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
                '  if ($w) {',
                '    [WbMaxNative]::ShowWindow($w.MainWindowHandle, 3) | Out-Null', // SW_MAXIMIZE = 3
                // Camoufox 可能在窗口创建后仍会套用一次指纹尺寸，稍后再确认一次最大化
                '    Start-Sleep -Milliseconds 1500',
                '    [WbMaxNative]::ShowWindow($w.MainWindowHandle, 3) | Out-Null',
                '    Write-Output "maximized"',
                '    exit 0',
                '  }',
                '  Start-Sleep -Milliseconds 400',
                '}',
                'Write-Output "no-window"'
            ].join('\n');

            const encoded = Buffer.from(script, 'utf16le').toString('base64');
            const out = await run(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
                wait + 5000
            );

            if (/maximized/.test(out || '')) return true;
            logger.debug('浏览器', `窗口最大化未生效: ${out || '无输出'}`);
            return false;
        }

        if (platform === 'linux') {
            // 优先 wmctrl（按窗口类匹配），回退 xdotool
            const wmctrlScript = [
                'id=$(wmctrl -lx 2>/dev/null | grep -i camoufox | awk \'{print $1}\' | head -1)',
                'if [ -n "$id" ]; then wmctrl -i -r "$id" -b add,maximized_vert,maximized_horz && echo ok; fi'
            ].join('\n');
            const wmctrlOut = await run('bash', ['-lc', wmctrlScript], 8000);
            if (/ok/.test(wmctrlOut || '')) return true;

            const xdotoolScript = [
                'id=$(xdotool search --onlyvisible --class camoufox 2>/dev/null | head -1)',
                'if [ -n "$id" ]; then xdotool windowmove "$id" 0 0; xdotool windowsize "$id" 100% 100%; echo ok; fi'
            ].join('\n');
            const xdotoolOut = await run('bash', ['-lc', xdotoolScript], 8000);
            return /ok/.test(xdotoolOut || '');
        }

        // macOS 暂不处理（本项目主要运行在 Windows / Linux / Docker）
        return false;
    } catch (e) {
        logger.debug('浏览器', `窗口最大化失败: ${e.message}`);
        return false;
    }
}

/**
 * 把探测到的显示器尺寸写入指纹，使 Camoufox 以该尺寸创建窗口
 * （Camoufox 依据指纹的 window.outerWidth/outerHeight 决定实际窗口大小）
 * @param {object} fingerprint - 指纹对象（会被原地修改）
 * @param {{screenWidth:number,screenHeight:number,workWidth:number,workHeight:number}} display
 * @returns {boolean} 是否已应用
 */
export function applyDisplayToFingerprint(fingerprint, display) {
    if (!fingerprint || !fingerprint.screen || !display) return false;

    const sw = Math.round(display.screenWidth);
    const sh = Math.round(display.screenHeight);
    const ww = Math.round(display.workWidth || display.screenWidth);
    const wh = Math.round(display.workHeight || display.screenHeight);
    if (!sw || !sh || !ww || !wh) return false;

    const s = fingerprint.screen;
    // 屏幕分辨率
    s.width = sw;
    s.height = sh;
    // 工作区（可用区域）
    s.availWidth = ww;
    s.availHeight = wh;
    // 窗口尺寸 = 工作区，等价于最大化
    s.outerWidth = ww;
    s.outerHeight = wh;
    // 窗口贴左上角
    s.screenX = 0;
    s.screenY = 0;
    s.availLeft = 0;
    s.availTop = 0;

    return true;
}
