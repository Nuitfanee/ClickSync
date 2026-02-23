// ==UserScript==
// @name         WebHID Workbench
// @namespace    webhid-workbench-cn
// @version      2.2.3
// @description  WebHID 工作台
// @match        https://hub.rapoo.cn/*
// @match        https://hub.atk.pro/*
// @match        https://www.rawmtech.com/*
// @match        https://www.mchose.com.cn/*
// @match        https://hub.miracletek.net/*
// @match        https://www.chaos.vin/*
// @match        https://chaos.vin/*
// @run-at       document-start
// @inject-into  page
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    "use strict";

    // =============================================================================
    // 🔧 协议解析规则配置 (可以在这里添加新的规则)
    // =============================================================================
    const PARSER_RULES = [
        {
            name: "Rapoo_DPI表",
            match: (id, data) => {
                if (id !== 1 || data.length !== 20) return false;
                const u16 = (off) => data[off] + (data[off + 1] << 8);
                const v1 = u16(4);
                return v1 >= 50 && v1 <= 30000;
            },
            decode: (id, data) => {
                const u16 = (off) => data[off] + (data[off + 1] << 8);
                const dpis = [];
                for (let i = 4; i < data.length - 1; i += 2) {
                    const val = u16(i);
                    if (val === 0 || val === 0xFFFF) break;
                    dpis.push(val);
                }
                return { 类型: "DPI配置表", 数值: dpis };
            }
        },
        {
            name: "Rapoo_按键映射",
            match: (id, data) => id === 1 && data.length > 5 && data[1] === 0x00 && data[3] === 0x00,
            decode: (id, data) => ({ 类型: "按键映射数据", 原始Hex: hex(data) })
        },
        {
            name: "设备状态报告(20)",
            match: (id, data) => data[0] === 0x20 && data.length >= 10,
            decode: (id, data) => {
                const u16 = (off) => data[off] + (data[off + 1] << 8);
                return {
                    类型: "设备状态",
                    当前DPI: u16(2),
                    DPI档位: u16(4),
                    电量: data[7] + "%"
                };
            }
        },
        {
            name: "配置读取请求(CFG1)",
            match: (id, data) => data.length >= 8 && data[0] === 0x01 && data[4] === 0x43 && data[5] === 0x46,
            decode: (id, data) => ({ 类型: "命令:读取配置", 标记: "CFG1" })
        }
    ];

    // =============================================================================
    // 核心工具库
    // =============================================================================
    const HOOK_KEY = "__WEBHID_WORKBENCH__";
    const UW = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // 防止重复注入
    if (UW[HOOK_KEY]?.installed) {
        console.log("WebHID Workbench 已运行");
        return;
    }

    const utils = {
        now: () => {
            const t = new Date().toISOString().split('T')[1].replace('Z', '');
            // 统一保证包含毫秒 (HH:MM:SS.mmm)
            return t.includes('.') ? t : (t + '.000');
        },
        nowISO: () => new Date().toISOString(),
        nowMs: () => Date.now(),

        extractDeviceInfo: (dev) => {
            if (!dev) return null;
            // WebHID HIDDevice 常用识别字段
            const vid = (typeof dev.vendorId === 'number') ? dev.vendorId : null;
            const pid = (typeof dev.productId === 'number') ? dev.productId : null;
            const info = {
                vid,
                pid,
                productName: dev.productName || "",
                // collections 里包含 usagePage/usage 以及不同方向 reportId
                collections: Array.isArray(dev.collections) ? dev.collections.map(c => ({
                    usagePage: c.usagePage,
                    usage: c.usage,
                    reportIds: {
                        input: Array.isArray(c.inputReports) ? c.inputReports.map(r => r.reportId) : [],
                        output: Array.isArray(c.outputReports) ? c.outputReports.map(r => r.reportId) : [],
                        feature: Array.isArray(c.featureReports) ? c.featureReports.map(r => r.reportId) : []
                    }
                })) : []
            };
            return info;
        },
        fileStamp: () => {
            // YYYYMMDD-HHMMSS
            const d = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const y = d.getFullYear();
            const m = pad(d.getMonth() + 1);
            const day = pad(d.getDate());
            const hh = pad(d.getHours());
            const mm = pad(d.getMinutes());
            const ss = pad(d.getSeconds());
            return `${y}${m}${day}-${hh}${mm}${ss}`;
        },
        downloadText: (filename, text, mime = 'application/json;charset=utf-8') => {
            try {
                const blob = new Blob([text], { type: mime });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return true;
            } catch (e) {
                console.error('downloadText failed:', e);
                return false;
            }
        },
        toU8: (data) => {
            if (!data) return new Uint8Array(0);
            if (data instanceof Uint8Array) return data;
            if (data instanceof DataView) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (Array.isArray(data)) return Uint8Array.from(data);
            return new Uint8Array(0);
        },
        hex: (u8) => {
            if (!u8) return "";
            return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(' ');
        },
        hexToBytes: (hexStr) => {
            const clean = hexStr.replace(/\s+/g, '');
            if (clean.length % 2 !== 0) return null;
            const bytes = new Uint8Array(clean.length / 2);
            for (let i = 0; i < clean.length; i += 2) {
                bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
            }
            return bytes;
        }
    };
    const { hex, toU8 } = utils;

    // =============================================================================
    // 状态管理
    // =============================================================================
    const state = {
        enabled: true,
        capturing: true, // 开始/暂停：是否记录报文到 log/buffer
        log: [], // 全量报文日志 (不清空)
        buffer: [], // 实时缓冲区 (从上一次快照至今)
        snapshots: [], // 快照列表
        baselineId: null, // 基准快照ID
        nextSnapshotId: 1,
        lastSnapLogIndex: 0, // 上一次快照对应的 log 位置
        openedDevices: new Set(),
        deviceInfo: null, // 最近一次打开的设备信息 (vid/pid/usage/reportId)
        ui: {
            tab: 'capture', // capture (仅保留捕获功能)
            isMinimized: false
        },
        replay: {
            running: false,
            cancel: false,
            snapshotId: null,
            sent: 0,
            total: 0,
            error: ""
        }
    };

    // =============================================================================
    // 逻辑控制器
    // =============================================================================
    const Decoder = {
        parse: (reportId, dataBytes) => {
            for (const rule of PARSER_RULES) {
                try {
                    if (rule.match(reportId, dataBytes)) {
                        return { ruleName: rule.name, result: rule.decode(reportId, dataBytes) };
                    }
                } catch (e) { console.error("Rule error:", rule.name, e); }
            }
            return null;
        }
    };

    const SnapshotManager = {
        capture: (note = "") => {
            // 每次快照只捕获“本次与上次快照之间”的报文段（delta window）
            const from = state.lastSnapLogIndex;
            const to = state.log.length;
            const packets = state.log.slice(from, to);
            if (packets.length === 0) {
                alert("本次快照区间为空（本次与上次快照之间没有新报文）。\n请先操作页面或设备产生报文。");
                return;
            }
            const snapId = state.nextSnapshotId++;
            const snapshot = {
                id: snapId,
                timestamp: utils.now(),
                timestampISO: utils.nowISO(),
                note: note || `快照 #${snapId}`,
                range: { from, to },
                packets,
                count: packets.length,
                prevSnapshotId: (state.snapshots.length ? state.snapshots[state.snapshots.length - 1].id : null)
            };
            state.snapshots.push(snapshot);
            state.lastSnapLogIndex = to;
            state.buffer = []; // 清空“本段”缓冲区
            if (state.baselineId === null) state.baselineId = snapId; // 默认第一个为基准
            UI.render();
        },
        clearBuffer: () => {
            state.buffer = [];
            // 清空缓冲区意味着用户希望重新开始“区间”
            state.lastSnapLogIndex = state.log.length;
            UI.render();
        },

        start: () => {
            state.capturing = true;
            UI.render();
        },
        pause: () => {
            state.capturing = false;
            UI.render();
        },
                exportJSON: () => {
            // 导出格式：
            // - device 仅保留 vid / pid
            // - snapshots 保留编号/备注
            // - packets 以“usagePage/usage + 方向 + ReportID + Hex” 的可读行输出
            const deviceRaw = state.deviceInfo
                || (state.openedDevices.size ? utils.extractDeviceInfo(Array.from(state.openedDevices)[0]) : null)
                || null;

            const device = deviceRaw ? { vid: deviceRaw.vid, pid: deviceRaw.pid } : null;

            // 根据 reportId + 方向 从 collections 中反查 usagePage / usage
            const lookupUsage = (pkt) => {
                if (!deviceRaw || !Array.isArray(deviceRaw.collections)) return null;
                const rid = Number(pkt.reportId);
                const kind = (pkt.dir === 'in') ? 'input'
                    : (pkt.dir === 'out') ? 'output'
                    : 'feature'; // sendFeature/receiveFeature 也按 feature 处理
                for (const c of deviceRaw.collections) {
                    const ids = (c?.reportIds && Array.isArray(c.reportIds[kind])) ? c.reportIds[kind] : [];
                    if (ids.includes(rid)) return { usagePage: c.usagePage, usage: c.usage };
                }
                return null;
            };

            const dirLabel = (d) => (d === 'out') ? 'OUT'
                : (d === 'in') ? 'IN'
                : (d === 'sendFeature') ? 'sendFeature'
                : (d === 'receiveFeature') ? 'receiveFeature'
                : 'feature';

            const formatPacketLine = (p) => {
                const u = lookupUsage(p) || { usagePage: '?', usage: '?' };
                return `usagePage:${u.usagePage} usage:${u.usage} ${dirLabel(p.dir)} ID:${p.reportId} ${utils.hex(p.data)}`;
            };

            const payload = {
                device,
                snapshots: state.snapshots.map(s => ({
                    n: s.id,           // 快照次数/编号
                    note: s.note || "",
                    packets: (s.packets || []).map(formatPacketLine)
                }))
            };

            const filename = `webhid-workbench-snapshots-${utils.fileStamp()}.json`;
            const ok = utils.downloadText(filename, JSON.stringify(payload, null, 2));
            if (!ok) alert('导出失败：浏览器阻止了下载或 Blob 创建失败。请打开控制台查看错误信息。');
        },
        setBaseline: (id) => {
            state.baselineId = id;
            UI.render();
        },
        replaySnapshot: async (id) => {
            // 再次点击可停止复刻
            if (state.replay?.running) {
                state.replay.cancel = true;
                UI.render();
                return;
            }

            const snap = state.snapshots.find(s => s.id === id);
            if (!snap) return;

            const outs = (snap.packets || []).filter(p => p.dir === 'out');
            if (outs.length === 0) {
                alert(`快照 #${id} 中没有 OUT 报文，无法复刻。`);
                return;
            }

            // 优先按快照里报文的 vid/pid 找到当前已打开设备
            const wantVid = (outs.find(p => p.vid != null)?.vid ?? state.deviceInfo?.vid ?? null);
            const wantPid = (outs.find(p => p.pid != null)?.pid ?? state.deviceInfo?.pid ?? null);

            let dev = null;
            for (const d of state.openedDevices) {
                try {
                    const okVid = (wantVid == null) || (typeof d.vendorId === 'number' && d.vendorId === wantVid);
                    const okPid = (wantPid == null) || (typeof d.productId === 'number' && d.productId === wantPid);
                    if (okVid && okPid) { dev = d; break; }
                } catch (e) { /* ignore */ }
            }
            if (!dev) dev = state.openedDevices.values().next().value || null;

            if (!dev) {
                alert("未找到可用的 HID 设备。\n请先在页面里连接/打开设备，然后再尝试复刻。");
                return;
            }

            try {
                if (!dev.opened) await dev.open();
            } catch (e) {
                // 可能权限/设备状态问题；继续尝试发送，由底层抛错
            }

            const sleep = (ms) => new Promise(r => setTimeout(r, ms));

            state.replay = {
                running: true,
                cancel: false,
                snapshotId: id,
                sent: 0,
                total: outs.length,
                error: ""
            };
            UI.render();

            const t0 = outs[0].tms;
            let last = t0;

            try {
                for (const p of outs) {
                    if (state.replay.cancel) throw new Error("复刻已停止");

                    const wait = Math.max(0, (p.tms || 0) - (last || 0));
                    if (wait > 0) await sleep(wait);

                    // 按抓取时序重新发送
                    await dev.sendReport(p.reportId, p.data);

                    state.replay.sent++;
                    last = p.tms;

                    if (state.ui.tab === 'capture' && !document.hidden) requestAnimationFrame(UI.render);
                }

                alert(`✅ 复刻完成：快照 #${id}（已发送 ${state.replay.sent}/${state.replay.total} 条 OUT 报文）`);
            } catch (e) {
                const msg = (e && (e.message || e.toString())) ? (e.message || e.toString()) : "未知错误";
                state.replay.error = msg;

                if (state.replay.cancel) {
                    alert(`⏹ 已停止复刻：快照 #${id}（已发送 ${state.replay.sent}/${state.replay.total}）`);
                } else {
                    alert(`❌ 复刻失败：${msg}
快照 #${id}（已发送 ${state.replay.sent}/${state.replay.total}）`);
                }
            } finally {
                state.replay.running = false;
                state.replay.cancel = false;
                state.replay.snapshotId = null;
                UI.render();
            }
        },
deleteSnapshot: (id) => {
            state.snapshots = state.snapshots.filter(s => s.id !== id);
            if (state.baselineId === id) state.baselineId = null;
            UI.render();
        }
    };

    // =============================================================================
    // UI 渲染 (修复版)
    // =============================================================================
    const UI = {
        root: null,
        init: () => {
            if (document.getElementById('webhid-bench-root')) return;
            const div = document.createElement('div');
            div.id = "webhid-bench-root";
            // 样式优化：修复布局问题
            div.style.cssText = `
                position: fixed; top: 20px; right: 20px; width: 480px; height: 85vh;
                background: #1e1e1e; color: #ccc; z-index: 2147483647;
                border: 1px solid #444; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
                font-family: "Microsoft YaHei", "Segoe UI", monospace; font-size: 12px;
                display: flex; flex-direction: column;
                border-radius: 8px; overflow: hidden; transition: height 0.3s;
            `;
            document.body.appendChild(div);
            UI.root = div;

            // 简单的拖拽支持
            let isDragging = false, startY, startX, startTop, startLeft;
            div.addEventListener('mousedown', (e) => {
                // 仅点击头部时拖拽
                if (e.target.closest('.bench-header')) {
                    isDragging = true;
                    startY = e.clientY; startX = e.clientX;
                    startTop = div.offsetTop; startLeft = div.offsetLeft;
                    e.preventDefault();
                }
            });
            window.addEventListener('mousemove', (e) => {
                if(isDragging) {
                    div.style.top = (startTop + e.clientY - startY) + "px";
                    div.style.left = (startLeft + e.clientX - startX) + "px";
                    div.style.right = 'auto'; // 清除 right 定位
                }
            });
            window.addEventListener('mouseup', () => isDragging = false);

            UI.render();
        },

        render: () => {
            if (!UI.root) return;

            // 1. 生成 HTML 字符串
            const headerHtml = `
                <div class="bench-header" style="padding: 10px 15px; background: #2d2d2d; border-bottom: 1px solid #333; display:flex; justify-content:space-between; align-items:center; cursor: move; user-select:none;">
                    <span style="font-weight:bold; color: #61dafb; font-size:14px;">⚡ WebHID 工作台</span>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <span style="font-size:11px; color: #888;">缓冲区: ${state.buffer.length}</span><span style="font-size:11px; color: ${state.capturing ? '#98c379' : '#e5c07b'};">${state.capturing ? '运行中' : '已暂停'}</span>
                        <button id="bench-toggle" style="background:transparent; border:1px solid #555; color:#888; border-radius:4px; cursor:pointer;">${state.ui.isMinimized ? '展开' : '收起'}</button>
                    </div>
                </div>
            `;

            if (state.ui.isMinimized) {
                UI.root.style.height = '45px';
                UI.root.innerHTML = headerHtml;
                document.getElementById('bench-toggle').addEventListener('click', () => {
                    state.ui.isMinimized = false;
                    UI.render();
                });
                return;
            } else {
                UI.root.style.height = '85vh';
            }

            let contentHtml = `<div style="flex:1; overflow:hidden; display:flex; flex-direction:column; padding:0;">`;

            // --- 标签页: 捕获 (Capture) ---

                contentHtml += `
                    <div style="padding:10px; border-bottom:1px solid #333; display:flex; gap:8px;">
                        <button id="btn-start" style="width:72px; background:${state.capturing ? '#007acc' : '#218838'}; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;" title="开始记录报文" ${state.capturing ? 'disabled' : ''}>▶ 开始</button>
                        <button id="btn-pause" style="width:72px; background:${state.capturing ? '#caa000' : '#444'}; color:${state.capturing ? '#111' : '#888'}; border:none; border-radius:4px; cursor:pointer; font-weight:bold;" title="暂停记录报文" ${state.capturing ? '' : 'disabled'}>⏸ 暂停</button>
                        <button id="btn-snap" style="flex:1; padding:8px; background:#218838; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">📸 捕获快照</button>
                        <button id="btn-export" style="width:72px; background:#444; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;" title="导出所有快照为 JSON">💾 导出</button>
                        <button id="btn-clear" style="width:40px; background:#dc3545; color:white; border:none; border-radius:4px; cursor:pointer; font-size:16px;" title="清空缓冲区">🗑️</button>
                    </div>

                    <!-- 快照列表区域 (固定高度) -->
                    <div style="height: 180px; overflow-y: auto; padding: 10px; background: #222; border-bottom: 2px solid #333;">
                        <div style="font-size:11px; color:#666; margin-bottom:5px; text-transform:uppercase;">已保存的快照</div>
                        ${state.snapshots.length === 0 ? '<div style="text-align:center; color:#555; padding:20px;">暂无快照<br>请在操作后点击绿色按钮捕获</div>' : ''}
                        ${state.snapshots.slice().reverse().map(snap => {
                            const isBase = snap.id === state.baselineId;
                            const isReplay = !!(state.replay && state.replay.running && state.replay.snapshotId === snap.id);
                            const replayDisabled = !!(state.replay && state.replay.running && state.replay.snapshotId !== snap.id);
                            const replayText = isReplay ? `停止复刻 (${state.replay.sent}/${state.replay.total})` : '复刻操作';
                            return `
                                <div style="background: ${isBase ? '#1a3c40' : '#2b2b2b'}; padding: 8px; margin-bottom: 6px; border-left: 3px solid ${isBase?'#61dafb':'#444'}; border-radius: 4px;">
                                    <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                                        <span style="font-weight:bold; color:#eee;">#${snap.id} ${snap.note}</span>
                                        <span style="color:#888; font-size:10px;">${snap.timestamp}</span>
                                    </div>
                                    <div style="font-size:10px; color:#aaa; margin-bottom:6px;">报文数: ${snap.count}</div>
                                    <div style="display:flex; gap:6px;">
                                        <button class="act-btn" data-action="setBase" data-id="${snap.id}" style="font-size:10px; padding:3px 8px; cursor:pointer; background:#444; color:#fff; border:none; border-radius:3px;">${isBase ? '当前基准' : '设为基准'}</button>

                                        <button class="act-btn" data-action="replaySnap" data-id="${snap.id}" ${replayDisabled ? 'disabled' : ''} style="font-size:10px; padding:3px 8px; cursor:pointer; background:${isReplay ? '#8b3a3a' : '#444'}; color:#fff; border:none; border-radius:3px; opacity:${replayDisabled ? 0.5 : 1};">
                                            ${replayText}
                                        </button>
<button class="act-btn" data-action="viewSnap" data-id="${snap.id}" style="font-size:10px; padding:3px 8px; cursor:pointer; background:#444; color:#fff; border:none; border-radius:3px;">查看详情</button>
                                        <button class="act-btn" data-action="delSnap" data-id="${snap.id}" style="font-size:10px; padding:3px 8px; cursor:pointer; background:#522; color:#fcc; border:none; border-radius:3px;">删除</button>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>

                    <!-- 实时缓冲区 (自动填充剩余空间) -->
                    <div style="flex:1; display:flex; flex-direction:column; min-height:0; background: #111;">
                        <div style="padding: 5px 10px; background:#1e1e1e; color:#888; font-size:11px; border-bottom:1px solid #333; display:flex; justify-content:space-between;">
                            <span>实时缓冲区 (显示最近 50 条)</span>
                            <span style="color:#555;">Live Buffer</span>
                        </div>
                        <div style="flex:1; overflow-y: auto; padding: 10px; font-family: 'Consolas', monospace;">
                            ${state.buffer.length === 0 ? '<div style="color:#444; padding:10px;">等待设备数据...</div>' : ''}
                            ${state.buffer.slice().reverse().slice(0, 50).map(pkt => {
                                const decoded = Decoder.parse(pkt.reportId, pkt.data);
                                const decHtml = decoded ? `<span style="color:#98c379; margin-left:10px; font-size:10px; border:1px solid #3a4a30; padding:0 4px; border-radius:3px;">${decoded.result.类型 || decoded.ruleName}</span>` : "";
                                let dirIcon = '';
                                if (pkt.dir === 'out') {
                                    dirIcon = '<span style="color:#d19a66;">OUT</span>';
                                } else if (pkt.dir === 'sendFeature') {
                                    dirIcon = '<span style="color:#c678dd;">sendFeature</span>';
                                } else if (pkt.dir === 'receiveFeature') {
                                    dirIcon = '<span style="color:#c678dd;">receiveFeature</span>';
                                } else if (pkt.dir === 'feature') {
                                    dirIcon = '<span style="color:#c678dd;">FEATURE</span>';
                                } else {
                                    dirIcon = '<span style="color:#61dafb;">IN </span>';
                                }
                                return `<div style="margin-bottom:2px; font-size:11px; color:#aaa; white-space:nowrap;">
                                    <span style="color:#555; margin-right:5px;">[${pkt.ts}]</span>
                                    ${dirIcon}
                                    <span style="color:#e06c75; font-weight:bold;">ID:${pkt.reportId}</span>
                                    <span>${utils.hex(pkt.data)}</span>
                                    ${decHtml}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                `;

            // (已移除：对比与发送模块)

            contentHtml += `</div>`; // end content flex

            // 2. 将 HTML 写入容器
            UI.root.innerHTML = headerHtml + contentHtml;

            // 3. 绑定事件 (使用 addEventListener，解决 Userscript 环境下 onclick 无效的问题)
            const bind = (id, fn) => { const el = document.getElementById(id); if(el) el.addEventListener('click', fn); };

            bind('bench-toggle', () => { state.ui.isMinimized = !state.ui.isMinimized; UI.render(); });

            // 捕获页按钮
            bind('btn-start', SnapshotManager.start);
            bind('btn-pause', SnapshotManager.pause);
            bind('btn-snap', () => {
                const note = prompt("📝 给快照加个备注 (例如: 修改DPI为1600):", "");
                if (note !== null) SnapshotManager.capture(note);
            });
            bind('btn-clear', SnapshotManager.clearBuffer);
            bind('btn-export', SnapshotManager.exportJSON);

            // 快照列表中的动态按钮
            document.querySelectorAll('.act-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const action = e.target.getAttribute('data-action');
                    const id = parseInt(e.target.getAttribute('data-id'));
                    if (action === 'setBase') SnapshotManager.setBaseline(id);
                    if (action === 'delSnap') { if(confirm('确定删除此快照？')) SnapshotManager.deleteSnapshot(id); }
                    if (action === 'viewSnap') {
                        const s = state.snapshots.find(x => x.id === id);
                        console.log(`%c[快照 #${id} 详情]`, "color:#61dafb; font-weight:bold; font-size:14px;");
                        console.table(s.packets.map(p => ({
                            方向: p.dir,
                            ID: p.reportId,
                            HEX数据: utils.hex(p.data),
                            解析结果: Decoder.parse(p.reportId, p.data)?.result || ""
                        })));
                        alert(`快照 #${id} 的完整数据已打印到浏览器控制台 (F12)`);
                    }
                                    if (action === 'replaySnap') await SnapshotManager.replaySnapshot(id);
});
            });

        }
    };

    // =============================================================================
    // WebHID Hook 注入
    // =============================================================================
    function installHooks() {
        const hookProto = (cls, method, wrapperFactory) => {
            if (!window[cls]) return;
            const orig = window[cls].prototype[method];
            window[cls].prototype[method] = wrapperFactory(orig);
        };

        const outputHook = (orig) => async function(reportId, data) {
            if (!state.capturing) return orig.apply(this, arguments);
            const pkt = {
                dir: 'out',
                reportId,
                data: utils.toU8(data),
                ts: utils.now(),
                tms: utils.nowMs(),
                vid: (typeof this.vendorId === 'number') ? this.vendorId : null,
                pid: (typeof this.productId === 'number') ? this.productId : null
            };
            state.log.push(pkt);
            state.buffer.push(pkt);
            // 限制 UI 刷新频率，避免卡顿
            if (state.ui.tab === 'capture' && !document.hidden) requestAnimationFrame(UI.render);
            return orig.apply(this, arguments);
        };

        const featureOutputHook = (orig) => async function(reportId, data) {
            if (!state.capturing) return orig.apply(this, arguments);
            const pkt = {
                dir: 'sendFeature',
                reportId,
                data: utils.toU8(data),
                ts: utils.now(),
                tms: utils.nowMs(),
                vid: (typeof this.vendorId === 'number') ? this.vendorId : null,
                pid: (typeof this.productId === 'number') ? this.productId : null
            };
            state.log.push(pkt);
            state.buffer.push(pkt);
            if (state.ui.tab === 'capture' && !document.hidden) requestAnimationFrame(UI.render);
            return orig.apply(this, arguments);
        };


        // Feature IN: receiveFeatureReport (同步到实时缓冲区)
        const featureInputHook = (orig) => async function (reportId) {
            const res = await orig.apply(this, arguments); // res: DataView
            if (!state.capturing) return res;
            try {
                const pkt = {
                    dir: 'receiveFeature',
                    reportId,
                    data: utils.toU8(res),
                    ts: utils.now(),
                    tms: utils.nowMs(),
                    vid: (typeof this.vendorId === 'number') ? this.vendorId : null,
                    pid: (typeof this.productId === 'number') ? this.productId : null
                };
                state.log.push(pkt);
                state.buffer.push(pkt);
                // 限制 UI 刷新频率，避免卡顿
                if (state.ui.tab === 'capture' && !document.hidden) requestAnimationFrame(UI.render);
            } catch (e) {
                console.warn('receiveFeatureReport hook parse failed:', e);
            }
            return res;
        };

        hookProto('HIDDevice', 'sendReport', outputHook);
        hookProto('HIDDevice', 'sendFeatureReport', featureOutputHook);
        hookProto('HIDDevice', 'receiveFeatureReport', featureInputHook);

        hookProto('HIDDevice', 'open', (orig) => async function() {
            state.openedDevices.add(this);
            // 记录设备协议信息（用于导出）
            try { state.deviceInfo = utils.extractDeviceInfo(this); } catch (e) {}
            return orig.apply(this, arguments);
        });

        const origAddEL = window.HIDDevice?.prototype?.addEventListener;
        if (origAddEL) {
            window.HIDDevice.prototype.addEventListener = function(type, listener, options) {
                if (type === 'inputreport') {
                    const hookedListener = (e) => {
                        if (!state.capturing) { listener(e); return; }
                        const pkt = {
                            dir: 'in',
                            reportId: e.reportId,
                            data: new Uint8Array(e.data.buffer),
                            ts: utils.now(),
                            tms: utils.nowMs(),
                            vid: (typeof this.vendorId === 'number') ? this.vendorId : null,
                            pid: (typeof this.productId === 'number') ? this.productId : null
                        };
                        state.log.push(pkt);
                        state.buffer.push(pkt);
                        // 收到数据时如果处于捕获页，则刷新 UI (加一点防抖)
                        if (state.ui.tab === 'capture' && Math.random() > 0.6) requestAnimationFrame(UI.render);
                        listener(e);
                    };
                    return origAddEL.call(this, type, hookedListener, options);
                }
                return origAddEL.apply(this, arguments);
            };

            // 兼容 oninputreport 属性赋值
            Object.defineProperty(window.HIDDevice.prototype, 'oninputreport', {
                set: function(fn) {
                    this.addEventListener('inputreport', fn);
                }
            });
        }
    }

    // =============================================================================
    // 启动
    // =============================================================================

    installHooks();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', UI.init);
    } else {
        UI.init();
    }

    UW[HOOK_KEY] = { installed: true, state };
    console.log("%c[WebHID 工作台] 已加载。按 F12 可查看更多调试信息。", "color:#61dafb;font-size:12px;");

})();
