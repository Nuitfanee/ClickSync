/**
 * protocol_api.js
 *
 * 目标：把设备“后端协议 / API 接口”集中到单文件，便于 UI 层调用与适配。
 * 适用环境：浏览器（WebHID）。
 */

/* =====================================================================================
 * 1) WebHID 协议总览（ReportID = 2，Report 长度 = 32 bytes）
 * =====================================================================================
 *
 * 设备 → 网页（Input Report）：
 * ┌────────┬──────────────────────────────────────────────────────────────┐
 * │ Byte   │ 含义                                                         │
 * ├────────┼──────────────────────────────────────────────────────────────┤
 * │ [0]    │ 0x02：配置包；0x03：电量包                                    │
 * │        │                                                              │
 * │ 当 [0]==0x02（配置包）时：                                             │
 * │ [1..14]│ 7 个 uint16LE（共 14B）：                                     │
 * │        │   u16[0..5] = DPI1..DPI6（直接是 DPI 数值）                   │
 * │        │   u16[6]    = SlotInfo：                                     │
 * │        │     - 低 8 bit：当前挡位数量 currentSlotCount（1..6）         │
 * │        │     - 高 8 bit：当前选中 DPI 档位索引 currentDpiIndex（0..5） │
 * │ [15]   │ PollingRate 码值：1/2/4/8                                    │
 * │ [16]   │ ModeByte（bit0..7，详见下表）                                │
 * │ [17..18]│ sleep16（uint16LE）                                          │
 * │ [19]   │ Debounce/Anti-jitter（单位 ms，常见：1/2/4/8/15/20）          │
 * │ [20]   │ LED 相关 liangdu_s，可能是开关/亮度的                         │
 * │ [21]   │ 鼠标固件版本号（raw）                                         │
 * │ [22]   │ 接收器固件版本号（raw）                                       │
 * │ [23]   │ Sensor Angle                                                 │
 * │ [24]   │ Sensor Feel                                                  │
 * │ [25..31]│ 保留                                                        │
 * │                                                                  │
 * │ 当 [0]==0x03（电量包）时：                                             │
 * │ [1]    │ 电量百分比（0..100）                                          │
 * └────────┴──────────────────────────────────────────────────────────────┘
 *
 * 网页 → 设备（Output Report，sendReport(2, data_to_send)）：
 * data_to_send[0] = cmd，其余为 payload（未用字节可为 0）
 *
 * ┌────────┬───────────────┬───────────────────────────────────────────────┐
 * │ cmd    │ payload        │ 说明                                          │
 * ├────────┼───────────────┼───────────────────────────────────────────────┤
 * │ 0x11   │ [1]=0x01       │ 请求配置包（会回 0x02）                        │
 * │ 0x11   │ [1]=0x02       │ 请求电量包（会回 0x03）                        │
 * │ 0x12   │ [1..3]         │ 设置 DPI 并“选中/切换到该档位”                 │
 * │ 0x19   │ [1..3]         │ 设置 DPI 但“不切换当前档位”（编辑未选中档）   │
 * │ 0x20   │ [1]=count      │ 设置挡位数量 currentSlotCount（1..6）          │
 * │ 0x15   │ [1]=modeByte   │ 写入 ModeByte（bit0..7）                      │
 * │ 0x13   │ [1..4]         │ LED 开关                                      │
 * │ 0x16   │ [1]=1/2/4/8    │ 设置回报率（1K/500/250/125）                  │
 * │ 0x17   │ [1]=1..7       │ 休眠时间枚举（10s/30s/50s/1m/2m/15m/30m）      │
 * │ 0x18   │ [1]=ms         │ 防抖/anti-jitter（1/2/4/8/15/20）              │
 * │ 0x21   │ [1..3]         │ 按键映射：btnId(0..5), funckey, keycode       │
 * │ 0x22   │ [1]=angle      │ 传感器角度（-100..100，编码为 uint8）          │
 * │ 0x23   │ [1]=feel       │ 手感参数（固件定义；编码为 uint8）             │
 * │ 0xFF   │ (无)           │ 恢复出厂设置                                  │
 * └────────┴───────────────┴───────────────────────────────────────────────┘
 *
 * ModeByte（0x15 / 配置包[16]）位定义：
 * - bit0: LOD（lodRadioButtons[1] 为 1）
 * - bit1: switchButtons[0]
 * - bit2: switchButtons[1]
 * - bit3: switchButtons[2]
 * - bit6: switchButtons[4]
 * - bit4: 高性能（modeRadioButtons[2]）
 * - bit5: 竞技模式（modeRadioButtons[1]）
 * - bit7: 超频（modeRadioButtons[0]）
 *   低功耗：当 bit4/bit5/bit7 都不为 1 时，UI 认为是“低功耗”。
 */


const MOUSE_HID = {
  usagePage: 65290, // 默认 1K/有线 UsagePage
  usagePage8K: 65280, // 新增：8K 接收器专用 UsagePage
  vendorProductIds: [
    // CHAOS M1
    [0x1915, 0x521c], // 有线
    [0x1915, 0x520c], // 无线 1K
    [0x1915, 0x520b], // 无线 8K

    // CHAOS M1 PRO
    [0x1915, 0x531c], // 有线
    [0x1915, 0x530c], // 无线 1K
    [0x1915, 0x530b], // 无线 8K

    // CHAOS M2 PRO
    [0x1915, 0x541c], // 有线
    [0x1915, 0x540c], // 无线 1K
    [0x1915, 0x540b], // 无线 8K

    // CHAOS M3 PRO
    [0x1915, 0x551c], // 有线
    [0x1915, 0x550c], // 无线 1K
    [0x1915, 0x550b], // 无线 8K
  ],
  // WebHID requestDevice 可用的默认过滤器
  // 更新说明：1K 设备/有线模式使用 65290，8K 接收器使用 65280
  defaultFilters: [
    // --- CHAOS M1 ---
    { vendorId: 0x1915, productId: 0x521c, usagePage: 65290 }, // 有线
    { vendorId: 0x1915, productId: 0x520c, usagePage: 65290 }, // 无线 1K
    { vendorId: 0x1915, productId: 0x520b, usagePage: 65280 }, // 无线 8K (注意 usagePage)

    // --- CHAOS M1 PRO ---
    { vendorId: 0x1915, productId: 0x531c, usagePage: 65290 }, // 有线
    { vendorId: 0x1915, productId: 0x530c, usagePage: 65290 }, // 无线 1K
    { vendorId: 0x1915, productId: 0x530b, usagePage: 65280 }, // 无线 8K (注意 usagePage)

    // --- CHAOS M2 PRO ---
    { vendorId: 0x1915, productId: 0x541c, usagePage: 65290 }, // 有线
    { vendorId: 0x1915, productId: 0x540c, usagePage: 65290 }, // 无线 1K
    { vendorId: 0x1915, productId: 0x540b, usagePage: 65280 }, // 无线 8K (注意 usagePage)

    // --- CHAOS M3 PRO ---
    { vendorId: 0x1915, productId: 0x551c, usagePage: 65290 }, // 有线
    { vendorId: 0x1915, productId: 0x550c, usagePage: 65290 }, // 无线 1K
    { vendorId: 0x1915, productId: 0x550b, usagePage: 65280 }, // 无线 8K (注意 usagePage)
  ],

  reportId: 2,
  reportSize: 32,
  cmds: {
    GET: 0x11,
    SET_DPI_AND_SELECT: 0x12,
    SET_DPI_ONLY: 0x19,
    SET_SLOT_COUNT: 0x20,
    SET_MODE_BYTE: 0x15,
    SET_LED: 0x13,
    SET_POLLING: 0x16,
    SET_SLEEP: 0x17,
    SET_DEBOUNCE: 0x18,
    SET_BUTTON_MAP: 0x21,
    SET_SENSOR_ANGLE: 0x22,
    SET_SENSOR_FEEL: 0x23,
    FACTORY_RESET: 0xff,
  },
  getSubcmd: {
    CONFIG: 0x01,
    BATTERY: 0x02,
  },
  pollingCodeToHz: { 1: 1000, 2: 500, 4: 250, 8: 125, 0x20: 2000, 0x40: 4000, 0x80: 8000 },
  pollingHzToCode: { 1000: 1, 500: 2, 250: 4, 125: 8, 2000: 0x20, 4000: 0x40, 8000: 0x80 },
  sleepCodeToSeconds: { 1: 10, 2: 30, 3: 50, 4: 60, 5: 120, 6: 900, 7: 1800 },
};

// =====================================================================================
// 设备识别：VendorID/ProductID -> 设备显示名
// =====================================================================================
const MOUSE_DEVICE_DISPLAY_NAME_BY_PID = Object.freeze({
  // CHAOS M1
  0x521c: "CHAOS M1 有线",
  0x520c: "CHAOS M1 无线1K",
  0x520b: "CHAOS M1 无线8K",
  // CHAOS M1 PRO
  0x531c: "CHAOS M1 PRO 有线",
  0x530c: "CHAOS M1 PRO 无线1K",
  0x530b: "CHAOS M1 PRO 无线8K",
  // CHAOS M2 PRO
  0x541c: "CHAOS M2 PRO 有线",
  0x540c: "CHAOS M2 PRO 无线1K",
  0x540b: "CHAOS M2 PRO 无线8K",
  // CHAOS M3 PRO
  0x551c: "CHAOS M3 PRO 有线",
  0x550c: "CHAOS M3 PRO 无线1K",
  0x550b: "CHAOS M3 PRO 无线8K",
});

/**
 * 根据 (vendorId, productId) 获取网页显示的设备名称。
 * @param {number} vendorId
 * @param {number} productId
 * @param {string} [fallbackName]
 */
function resolveMouseDisplayName(vendorId, productId, fallbackName = "") {
  const vid = Number(vendorId) & 0xffff;
  const pid = Number(productId) & 0xffff;
  if (vid === 0x1915) {
    return MOUSE_DEVICE_DISPLAY_NAME_BY_PID[pid] || fallbackName || `0x${pid.toString(16)}`;
  }
  return fallbackName || `VID 0x${vid.toString(16)} PID 0x${pid.toString(16)}`;
}

// =====================================================================================
// 固件版本解析：Uint8(0~255) -> "Vx.y.z"
// =====================================================================================
/**
 * 将 0~255 的十进制数转为版本号：padStart(3) 后按 百位.十位.个位 显示。
 * 例：15 -> "015" -> V0.1.5
 * @param {number} n
 */
function uint8ToVersion(n) {
  const v = Math.max(0, Math.min(255, Number(n) | 0));
  const s = String(v).padStart(3, "0");
  return `V${s[0]}.${s[1]}.${s[2]}`;
}

/** 把 -128..127 的数写入 Uint8（补码） */
function int8ToUint8(v) {
  // 直接利用补码：对 JS 来说，(n & 0xFF) 等价于“转换为无符号字节”
  return (Number(v) | 0) & 0xff;
}

/**
 * 设备侧对 Angle / Feel 的“有符号值”编码在不同固件里存在差异：
 * 这里保留通用补码解码（uint8ToInt8），并提供 angle/feel 专用解码以兼容工程语义。
 */
function uint8ToInt8(u) {
  const n = u & 0xff;
  return n >= 128 ? n - 256 : n;
}

function decodeSensorAngleRaw(raw) {
  const n = raw & 0xff;
  return n > 125 ? n - 256 : n;
}

function decodeSensorFeelRaw(raw) {
  const n = raw & 0xff;
  if (n <= 127) return n > 65 ? n - 128 : n;
  // 兜底：若有固件使用标准补码，则回退
  return uint8ToInt8(n);
}

/**
 * HID：编码 DPI 写入/切换
 * 固件使用的 DPI 单位：50（index = dpi/50）
 * payload:
 *   b1 = (index>>8) | (slot<<5)   // slot: 1..6
 *   b2 = index & 0xFF
 *   b3 = 0x00
 */

function sanitizeDpiInput(dpi, { min = 50, max = 30000, step = 50 } = {}) {
  const n = Number(dpi);
  if (!Number.isFinite(n)) return null;

  // 1. 范围限制
  const clamped = Math.max(min, Math.min(max, n));
  
  // 2. 步进对齐 (四舍五入到最近的 step 倍数)
  // 避免浮点数除法残差，先除后乘
  const stepped = Math.round(clamped / step) * step;

  // 3. 再次夹紧 (防止 round 导致极其接近 max 时溢出)
  return Math.max(min, Math.min(max, stepped));
}



function encodeSetDpi(slot1to6, dpi, { select = false } = {}) {
  const slot = Math.max(1, Math.min(6, Number(slot1to6) | 0));
  // 调用工具函数清洗数据 (默认 50-30000, 步进 50)
  const safeDpi = sanitizeDpiInput(dpi);
  // 如果清洗结果为 null (无效输入)，则抛出异常，防止写入错误指令
  if (safeDpi === null) {
    throw new TypeError(`Invalid DPI value: ${dpi}`);
  }
  // 固件单位通常为 50（index = dpi/50）
  // 注意：safeDpi 已经是 50 的倍数，直接除即可
  const index = (safeDpi / 50) & 0xffff;

  const b1 = ((index >> 8) & 0x1f) | ((slot & 0x07) << 5);
  const b2 = index & 0xff;
  const cmd = select ? MOUSE_HID.cmds.SET_DPI_AND_SELECT : MOUSE_HID.cmds.SET_DPI_ONLY;
  return Uint8Array.from([cmd, b1, b2, 0x00]);
}

function encodeSetSlotCount(count1to6) {
  const c = Math.max(1, Math.min(6, Number(count1to6) | 0));
  return Uint8Array.from([MOUSE_HID.cmds.SET_SLOT_COUNT, c]);
}

function encodeSetPollingRateHz(hz) {
  const code = MOUSE_HID.pollingHzToCode[Number(hz)] ?? 1;
  return Uint8Array.from([MOUSE_HID.cmds.SET_POLLING, code]);
}

function encodeSetSleepSeconds(seconds) {
  // 反查最接近的 code；若 UI 只用枚举，建议直接用 code
  const sec = Number(seconds) | 0;
  let bestCode = 1;
  let bestDist = Infinity;
  for (const [codeStr, s] of Object.entries(MOUSE_HID.sleepCodeToSeconds)) {
    const dist = Math.abs(s - sec);
    if (dist < bestDist) { bestDist = dist; bestCode = Number(codeStr); }
  }
  return Uint8Array.from([MOUSE_HID.cmds.SET_SLEEP, bestCode]);
}

function encodeSetDebounceMs(ms) {
  const v = Math.max(0, Math.min(255, Number(ms) | 0));
  return Uint8Array.from([MOUSE_HID.cmds.SET_DEBOUNCE, v]);
}

function encodeSetModeByte(modeByte) {
  return Uint8Array.from([MOUSE_HID.cmds.SET_MODE_BYTE, Number(modeByte) & 0xff]);
}


// ====== 语义化状态 <-> modeByte（协议层负责位运算，UI 层不碰） ======
function decodeModeByteToState(modeByte) {
  const mb = Number(modeByte) & 0xff;

  const lodLow = (mb & (1 << 0)) !== 0;
  const motionSync = (mb & (1 << 1)) !== 0;
  const linearCorrection = (mb & (1 << 2)) !== 0;
  const rippleControl = (mb & (1 << 3)) !== 0;
  const glassMode = (mb & (1 << 6)) !== 0;

  let performanceMode = "low";
  if ((mb & (1 << 7)) !== 0) performanceMode = "oc";
  else if ((mb & (1 << 5)) !== 0) performanceMode = "sport";
  else if ((mb & (1 << 4)) !== 0) performanceMode = "hp";

  return {
    performanceMode,
    lodHeight: lodLow ? "low" : "high",
    motionSync,
    linearCorrection,
    rippleControl,
    glassMode,
    modeByte: mb,
  };
}

function encodeModeByteFromState(stateLike) {
  const s = stateLike && typeof stateLike === "object" ? stateLike : {};

  // 重要：支持“增量更新”。
  // - 如果调用方提供了 modeByte/mode_byte 作为 base，则先以 base 为起点。
  // - 仅当 payload 中“明确出现某字段”时，才更新对应 bit。
  // 这样可以避免 UI 只改一个开关时，其他 bit 被默认值覆盖（刷新页误开/误关）。

  const baseRaw = s.modeByte ?? s.mode_byte;
  let mb = Number.isFinite(Number(baseRaw)) ? (Number(baseRaw) & 0xff) : 0;

  const hasOwn = (k) => Object.prototype.hasOwnProperty.call(s, k);
  const hasAny = (keys) => keys.some(hasOwn);
  const pick = (keys) => {
    for (const k of keys) if (hasOwn(k)) return s[k];
    return undefined;
  };

  // bit0: LOD
  if (hasAny(["lodHeight", "lod", "lod_height"])) {
    const lod = String(pick(["lodHeight", "lod", "lod_height"]) ?? "high").toLowerCase();
    if (lod === "low") mb |= (1 << 0);
    else mb &= ~(1 << 0);
  }

  // bit1: motionSync
  if (hasAny(["motionSync", "motion_sync"])) {
    const v = !!pick(["motionSync", "motion_sync"]);
    if (v) mb |= (1 << 1);
    else mb &= ~(1 << 1);
  }

  // bit2: linearCorrection
  if (hasAny(["linearCorrection", "linear_correction"])) {
    const v = !!pick(["linearCorrection", "linear_correction"]);
    if (v) mb |= (1 << 2);
    else mb &= ~(1 << 2);
  }

  // bit3: rippleControl
  if (hasAny(["rippleControl", "ripple_control"])) {
    const v = !!pick(["rippleControl", "ripple_control"]);
    if (v) mb |= (1 << 3);
    else mb &= ~(1 << 3);
  }

  // bit6: glassMode
  if (hasAny(["glassMode", "glass_mode"])) {
    const v = !!pick(["glassMode", "glass_mode"]);
    if (v) mb |= (1 << 6);
    else mb &= ~(1 << 6);
  }

  // bit4/5/7: performanceMode
  if (hasAny(["performanceMode", "performance_mode"])) {
    const perf = String(pick(["performanceMode", "performance_mode"]) ?? "low").toLowerCase();

    // 先清空性能位
    mb &= ~((1 << 7) | (1 << 5) | (1 << 4));

    if (perf === "oc") mb |= (1 << 7);
    else if (perf === "sport") mb |= (1 << 5);
    else if (perf === "hp") mb |= (1 << 4);
    // low: no bits
  }

  return mb & 0xff;
}


function encodeSetLedEnabled(enabled) {
  return Uint8Array.from([MOUSE_HID.cmds.SET_LED, 0x00, 0x01, 0x00, enabled ? 0xff : 0x00]);
}

function encodeSetSensorAngle(angle) {
  const a = Math.max(-100, Math.min(100, Number(angle) | 0));
  return Uint8Array.from([MOUSE_HID.cmds.SET_SENSOR_ANGLE, int8ToUint8(a)]);
}

function encodeSetSensorFeel(feel) {
  const v = Number(feel) | 0;
  // 优先按 7-bit 规则编码（兼容面更广）
  const f = Math.max(-62, Math.min(65, v));
  const raw = f < 0 ? (128 + f) & 0x7f : (f & 0x7f);
  return Uint8Array.from([MOUSE_HID.cmds.SET_SENSOR_FEEL, raw]);
}

/**
 * 归一化按钮 ID：
 * - UI/逻辑里 ButtonId 语义通常是 1..6（人类可读）
 * - 固件侧通常是 0..5
 *
 * 这里做“尽量不抛异常”的归一化：任何异常输入都会被夹到 0..5，避免 UI 崩溃。
 * @param {number} btnId
 */
function normalizeButtonId(btnId) {
  const n = Number(btnId);
  if (!Number.isFinite(n)) return 0;
  const i = n | 0;
  if (i >= 1 && i <= 6) return i - 1;
  if (i >= 0 && i <= 5) return i;
  // 兜底：夹紧到合法范围，避免抛错导致 UI 直接崩
  return Math.max(0, Math.min(5, i));
}

/**
 * 按键映射 payload
 * [0]=0x21, [1]=btnId(0..5), [2]=funckey, [3]=keycode
 */
function encodeButtonMapping(btnId1to6, funckey, keycode) {
  const btn = normalizeButtonId(btnId1to6);
  return Uint8Array.from([
    MOUSE_HID.cmds.SET_BUTTON_MAP,
    btn & 0xff,
    Number(funckey) & 0xff,
    Number(keycode) & 0xff,
  ]);
}


/* =====================================================================================
 * 2) 按键映射：Select 字符串 → (funckey, keycode)
 * =====================================================================================
 *
 * 核心规则：
 * - 默认 funckey=0x60（键盘类）；bit0/1/2/3 分别代表 Ctrl/Shift/Alt/Win 修饰键。
 * - 鼠标基础功能：funckey=0x20，keycode 对应 左/右/中/后退/前进/DPI循环/禁用。
 * - 多媒体/系统功能：funckey=0x40，keycode 对应 音量/播放/亮度 等。
 * - 部分“常用快捷”在原工程里会直接写死 funckey（如 0x61=Ctrl, 0x62=Shift, 0x65=Ctrl+Alt），
 *   这类条目会覆盖 UI 勾选的修饰键。
 */

const KEYBOARD_MOD_BITS = Object.freeze({
  ctrl: 0x01,
  shift: 0x02,
  alt: 0x04,
  win: 0x08,
});

const KEYMAP_ACTIONS = Object.freeze({
  "MODIFIER_ONLY": { type: "keyboard", special: "MODIFIER_ONLY", keycode: 0, allowModifiers: true },
  "禁用按键": { type: "mouse", funckey: 0x20, keycode: 255, fixedFunckey: true, allowModifiers: false },
  "左键": { type: "mouse", funckey: 0x20, keycode: 0, fixedFunckey: true, allowModifiers: false },
  "右键": { type: "mouse", funckey: 0x20, keycode: 1, fixedFunckey: true, allowModifiers: false },
  "中键": { type: "mouse", funckey: 0x20, keycode: 2, fixedFunckey: true, allowModifiers: false },
  "后退": { type: "mouse", funckey: 0x20, keycode: 3, fixedFunckey: true, allowModifiers: false },
  "前进": { type: "mouse", funckey: 0x20, keycode: 4, fixedFunckey: true, allowModifiers: false },
  "DPI循环": { type: "mouse", funckey: 0x20, keycode: 5, fixedFunckey: true, allowModifiers: false },
  "音量上": { type: "system", funckey: 0x40, keycode: 0, fixedFunckey: true, allowModifiers: false },
  "音量下": { type: "system", funckey: 0x40, keycode: 1, fixedFunckey: true, allowModifiers: false },
  "静音": { type: "system", funckey: 0x40, keycode: 2, fixedFunckey: true, allowModifiers: false },
  "打开播放器": { type: "system", funckey: 0x40, keycode: 3, fixedFunckey: true, allowModifiers: false },
  "播放/暂停": { type: "system", funckey: 0x40, keycode: 4, fixedFunckey: true, allowModifiers: false },
  "下一曲": { type: "system", funckey: 0x40, keycode: 5, fixedFunckey: true, allowModifiers: false },
  "上一曲": { type: "system", funckey: 0x40, keycode: 6, fixedFunckey: true, allowModifiers: false },
  "停止播放": { type: "system", funckey: 0x40, keycode: 7, fixedFunckey: true, allowModifiers: false },
  "屏幕亮度增加": { type: "system", funckey: 0x40, keycode: 8, fixedFunckey: true, allowModifiers: false },
  "屏幕亮度减少": { type: "system", funckey: 0x40, keycode: 9, fixedFunckey: true, allowModifiers: false },
  "复制": { type: "keyboard", funckey: 0x61, keycode: 6, fixedFunckey: true, allowModifiers: false },
  "粘贴": { type: "keyboard", funckey: 0x61, keycode: 25, fixedFunckey: true, allowModifiers: false },
  "剪切": { type: "keyboard", funckey: 0x61, keycode: 27, fixedFunckey: true, allowModifiers: false },
  "撤销": { type: "keyboard", funckey: 0x61, keycode: 29, fixedFunckey: true, allowModifiers: false },
  "打开Linux终端": { type: "keyboard", funckey: 0x65, keycode: 23, fixedFunckey: true, allowModifiers: false },
  "复制(Ctrl+Insert)": { type: "keyboard", funckey: 0x61, keycode: 73, fixedFunckey: true, allowModifiers: false },
  "粘贴(Shift+Insert)": { type: "keyboard", funckey: 0x62, keycode: 73, fixedFunckey: true, allowModifiers: false },
  "移动到回收站(Delete)": { type: "keyboard", funckey: 0x60, keycode: 76, fixedFunckey: true, allowModifiers: false },
  "强制删除文件(Shift+Delete)": { type: "keyboard", funckey: 0x62, keycode: 76, fixedFunckey: true, allowModifiers: false },
  "A": { type: "keyboard", keycode: 4, allowModifiers: true },
  "B": { type: "keyboard", keycode: 5, allowModifiers: true },
  "C": { type: "keyboard", keycode: 6, allowModifiers: true },
  "D": { type: "keyboard", keycode: 7, allowModifiers: true },
  "E": { type: "keyboard", keycode: 8, allowModifiers: true },
  "F": { type: "keyboard", keycode: 9, allowModifiers: true },
  "G": { type: "keyboard", keycode: 10, allowModifiers: true },
  "H": { type: "keyboard", keycode: 11, allowModifiers: true },
  "I": { type: "keyboard", keycode: 12, allowModifiers: true },
  "J": { type: "keyboard", keycode: 13, allowModifiers: true },
  "K": { type: "keyboard", keycode: 14, allowModifiers: true },
  "L": { type: "keyboard", keycode: 15, allowModifiers: true },
  "M": { type: "keyboard", keycode: 16, allowModifiers: true },
  "N": { type: "keyboard", keycode: 17, allowModifiers: true },
  "O": { type: "keyboard", keycode: 18, allowModifiers: true },
  "P": { type: "keyboard", keycode: 19, allowModifiers: true },
  "Q": { type: "keyboard", keycode: 20, allowModifiers: true },
  "R": { type: "keyboard", keycode: 21, allowModifiers: true },
  "S": { type: "keyboard", keycode: 22, allowModifiers: true },
  "T": { type: "keyboard", keycode: 23, allowModifiers: true },
  "U": { type: "keyboard", keycode: 24, allowModifiers: true },
  "V": { type: "keyboard", keycode: 25, allowModifiers: true },
  "W": { type: "keyboard", keycode: 26, allowModifiers: true },
  "X": { type: "keyboard", keycode: 27, allowModifiers: true },
  "Y": { type: "keyboard", keycode: 28, allowModifiers: true },
  "Z": { type: "keyboard", keycode: 29, allowModifiers: true },
  "1": { type: "keyboard", keycode: 30, allowModifiers: true },
  "2": { type: "keyboard", keycode: 31, allowModifiers: true },
  "3": { type: "keyboard", keycode: 32, allowModifiers: true },
  "4": { type: "keyboard", keycode: 33, allowModifiers: true },
  "5": { type: "keyboard", keycode: 34, allowModifiers: true },
  "6": { type: "keyboard", keycode: 35, allowModifiers: true },
  "7": { type: "keyboard", keycode: 36, allowModifiers: true },
  "8": { type: "keyboard", keycode: 37, allowModifiers: true },
  "9": { type: "keyboard", keycode: 38, allowModifiers: true },
  "0": { type: "keyboard", keycode: 39, allowModifiers: true },
  "Enter": { type: "keyboard", keycode: 40, allowModifiers: true },
  "ESC": { type: "keyboard", keycode: 41, allowModifiers: true },
  "Back": { type: "keyboard", keycode: 42, allowModifiers: true },
  "TAB": { type: "keyboard", keycode: 43, allowModifiers: true },
  "Space": { type: "keyboard", keycode: 44, allowModifiers: true },
  "-": { type: "keyboard", keycode: 45, allowModifiers: true },
  "=": { type: "keyboard", keycode: 46, allowModifiers: true },
  "[": { type: "keyboard", keycode: 47, allowModifiers: true },
  "]": { type: "keyboard", keycode: 48, allowModifiers: true },
  "\\": { type: "keyboard", keycode: 49, allowModifiers: true },
  ";": { type: "keyboard", keycode: 51, allowModifiers: true },
  "'": { type: "keyboard", keycode: 52, allowModifiers: true },
  "`": { type: "keyboard", keycode: 53, allowModifiers: true },
  ",": { type: "keyboard", keycode: 54, allowModifiers: true },
  ".": { type: "keyboard", keycode: 55, allowModifiers: true },
  "/": { type: "keyboard", keycode: 56, allowModifiers: true },
  "CapsLock": { type: "keyboard", keycode: 57, allowModifiers: true },
  "F1": { type: "keyboard", keycode: 58, allowModifiers: true },
  "F2": { type: "keyboard", keycode: 59, allowModifiers: true },
  "F3": { type: "keyboard", keycode: 60, allowModifiers: true },
  "F4": { type: "keyboard", keycode: 61, allowModifiers: true },
  "F5": { type: "keyboard", keycode: 62, allowModifiers: true },
  "F6": { type: "keyboard", keycode: 63, allowModifiers: true },
  "F7": { type: "keyboard", keycode: 64, allowModifiers: true },
  "F8": { type: "keyboard", keycode: 65, allowModifiers: true },
  "F9": { type: "keyboard", keycode: 66, allowModifiers: true },
  "F10": { type: "keyboard", keycode: 67, allowModifiers: true },
  "F11": { type: "keyboard", keycode: 68, allowModifiers: true },
  "F12": { type: "keyboard", keycode: 69, allowModifiers: true },
  "Print": { type: "keyboard", keycode: 70, allowModifiers: true },
  "Scroll": { type: "keyboard", keycode: 71, allowModifiers: true },
  "Pause": { type: "keyboard", keycode: 72, allowModifiers: true },
  "INS": { type: "keyboard", keycode: 73, allowModifiers: true },
  "HOME": { type: "keyboard", keycode: 74, allowModifiers: true },
  "PGUP": { type: "keyboard", keycode: 75, allowModifiers: true },
  "DEL": { type: "keyboard", keycode: 76, allowModifiers: true },
  "END": { type: "keyboard", keycode: 77, allowModifiers: true },
  "PGDN": { type: "keyboard", keycode: 78, allowModifiers: true },
  "→": { type: "keyboard", keycode: 79, allowModifiers: true },
  "←": { type: "keyboard", keycode: 80, allowModifiers: true },
  "↓": { type: "keyboard", keycode: 81, allowModifiers: true },
  "↑": { type: "keyboard", keycode: 82, allowModifiers: true },
  "NumLock": { type: "keyboard", keycode: 83, allowModifiers: true },

});

/**
 * 把 Select + 修饰键 解析为固件可识别的 (funckey, keycode)。
 * @param {string} selectLabel
 * @param {{ctrl?:boolean,shift?:boolean,alt?:boolean,win?:boolean}} [mod]
 * @returns {{funckey:number,keycode:number, meta:object}}
 */
function resolveKeyAction(selectLabel, mod = {}) {
  // 兼容旧数据：历史上部分按键标签“多写了反斜杠”（如 "\\["），这里做一次归一化
  const normalizedLabel = (() => {
    if (typeof selectLabel !== "string") return String(selectLabel);
    if (KEYMAP_ACTIONS[selectLabel]) return selectLabel;
    // 单字符转义："\\[" -> "["、"\\;" -> ";"、"\\'" -> "'" 等
    if (selectLabel.length === 2 && selectLabel[0] === "\\") return selectLabel[1];
    // 反斜杠本身："\\\\"(两字符) -> "\\"(一字符)
    if (selectLabel === "\\\\") return "\\";
    return selectLabel;
  })();

  const meta = KEYMAP_ACTIONS[normalizedLabel];
  if (!meta) {
    throw new Error(`Unknown Select label: ${selectLabel}`);
  }

  // 非键盘类（鼠标/媒体）
  if (meta.type !== "keyboard" || meta.fixedFunckey) {
    return { funckey: meta.funckey ?? 0x60, keycode: meta.keycode ?? 0, meta };
  }

  // 键盘类：基底 0x60 + UI 修饰键位
  let funckey = 0x60;
  if (mod.ctrl) funckey |= KEYBOARD_MOD_BITS.ctrl;
  if (mod.shift) funckey |= KEYBOARD_MOD_BITS.shift;
  if (mod.alt) funckey |= KEYBOARD_MOD_BITS.alt;
  if (mod.win) funckey |= KEYBOARD_MOD_BITS.win;

  // MODIFIER_ONLY：只下发修饰键，不附带普通键码
  const keycode = meta.special === "MODIFIER_ONLY" ? 0 : (meta.keycode ?? 0);
  return { funckey, keycode, meta };
}


// (funckey, keycode) -> label（用于 UI 从设备回包同步显示）
const __KEYMAP_REVERSE = (() => {
  const rev = new Map();
  for (const [label, info] of Object.entries(KEYMAP_ACTIONS || {})) {
    if (!label || label === "MODIFIER_ONLY" || !info) continue;
    const type = info.type;
    const kc = Number(info.keycode) & 0xff;
    let fk = info.funckey != null ? (Number(info.funckey) & 0xff) : null;
    if (fk == null && type === "keyboard") fk = 0x60;
    if (fk == null) continue;
    rev.set(`${fk}-${kc}`, label);
  }
  return rev;
})();

function labelFromFunckeyKeycode(funckey, keycode) {
  const fk = Number(funckey) & 0xff;
  const kc = Number(keycode) & 0xff;
  const exact = __KEYMAP_REVERSE.get(`${fk}-${kc}`);
  if (exact) return exact;
  // 忽略键盘修饰位（0x60..0x6F）
  if ((fk & 0xF0) === 0x60) return __KEYMAP_REVERSE.get(`${0x60}-${kc}`) || null;
  return null;
}


/**
 * 便于 UI 做下拉框：按 type 返回可选项（保持表内顺序）。
 * - 仅支持三类：mouse / keyboard / system
 * - 懒加载缓存：避免重复遍历大对象
 * - 返回值被冻结：请把它当成只读数据
 * @returns {{type:string, items:string[]}[]}
 */
const _listKeyActionsByTypeCache = { value: null };
function listKeyActionsByType() {
  if (_listKeyActionsByTypeCache.value) return _listKeyActionsByTypeCache.value;

  // 固定顺序：与 UI Tab 对齐
  const order = ["mouse", "keyboard", "system"];
  const map = new Map(order.map((t) => [t, []]));

  for (const [label, meta] of Object.entries(KEYMAP_ACTIONS)) {
    const t = meta.type === "mouse" || meta.type === "keyboard" || meta.type === "system" ? meta.type : "system";
    map.get(t).push(label);
  }

  const result = order.map((t) => Object.freeze({ type: t, items: Object.freeze(map.get(t).slice()) }));
  _listKeyActionsByTypeCache.value = Object.freeze(result);
  return _listKeyActionsByTypeCache.value;
}

/**
 * 兼容旧调用：历史上这里按 category 分组；现在统一按 type。
 * @deprecated 请使用 listKeyActionsByType()
 */
function listKeyActionsByCategory() {
  return listKeyActionsByType().map((g) => ({ category: g.type, items: g.items }));
}

function encodeFactoryReset() {
  return Uint8Array.from([MOUSE_HID.cmds.FACTORY_RESET]);
}

function encodeRequestConfig() {
  return Uint8Array.from([MOUSE_HID.cmds.GET, MOUSE_HID.getSubcmd.CONFIG]);
}
function encodeRequestBattery() {
  return Uint8Array.from([MOUSE_HID.cmds.GET, MOUSE_HID.getSubcmd.BATTERY]);
}

// =====================================================================================
// Input Report 解析（DataView 优先；支持旧签名 Uint8Array）
// =====================================================================================
function _asDataView(report) {
  if (!report) return null;
  if (report instanceof DataView) return report;

  // 兼容：Uint8Array / ArrayBuffer
  if (report instanceof Uint8Array) {
    return new DataView(report.buffer, report.byteOffset, report.byteLength);
  }
  if (report instanceof ArrayBuffer) return new DataView(report);

  // 兜底：只要长得像 {buffer, byteOffset, byteLength} 的都试着包一层
  if (report.buffer instanceof ArrayBuffer) {
    const byteOffset = Number(report.byteOffset) || 0;
    const byteLength = Number(report.byteLength) || report.buffer.byteLength;
    return new DataView(report.buffer, byteOffset, byteLength);
  }
  return null;
}

/**
 * 解析 Input Report
 * @param {DataView|Uint8Array|ArrayBuffer} report - 推荐直接传 event.data(DataView)
 */
function parseInputReport(report, { reportId = null } = {}) {
  const dv = _asDataView(report);
  if (!dv || dv.byteLength < 1) return { type: "unknown", rawType: -1, raw: null };

  // 结构化校验：ReportID 必须命中（若调用方提供）
  if (reportId != null && Number(reportId) !== MOUSE_HID.reportId) {
    const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    return { type: "unknown", rawType: -1, raw, error: "UNEXPECTED_REPORT_ID", reportId: Number(reportId) };
  }

  const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const type = dv.getUint8(0);

  // ---- Battery (0x03) ----
  if (type === 0x03) {
    if (dv.byteLength < 2) {
      return { type: "unknown", rawType: type, raw, error: "BATTERY_REPORT_TOO_SHORT" };
    }
    const pct = Math.max(0, Math.min(100, dv.getUint8(1)));
    return { type: "battery", batteryPercent: pct, raw };
  }

  // ---- Config (0x02) ----
  if (type !== 0x02) {
    return { type: "unknown", rawType: type, raw };
  }

  // Config 包至少要能覆盖：dpi(1..12) + slotInfo(13..14)
  // 实际 WebHID 传输中，OS 往往把 report data 补齐到固定长度（例如 32），但仍要兼容短包。
  const MIN_CONFIG_LEN = 15;
  if (dv.byteLength < MIN_CONFIG_LEN) {
    return { type: "unknown", rawType: type, raw, error: "CONFIG_REPORT_TOO_SHORT", expectedMin: MIN_CONFIG_LEN };
  }

  const getU8 = (off, def = 0) => (off >= 0 && off < dv.byteLength ? dv.getUint8(off) : def);
  const getU16 = (off, def = 0) => (off >= 0 && off + 1 < dv.byteLength ? dv.getUint16(off, true) : def);

  // DPI slots：6 x uint16LE from bytes [1..12]
  const dpiSlots = [
    getU16(1, 0),
    getU16(3, 0),
    getU16(5, 0),
    getU16(7, 0),
    getU16(9, 0),
    getU16(11, 0),
  ];

  const slotInfo = getU16(13, 0);
  const currentSlotCountRaw = slotInfo & 0x00ff;
  const currentDpiIndexRaw = (slotInfo >> 8) & 0x00ff;

  // 语义校验（不抛异常）：避免异常值直接污染 UI / 写回逻辑
  const currentSlotCount = (currentSlotCountRaw >= 1 && currentSlotCountRaw <= 6) ? currentSlotCountRaw : null;
  const currentDpiIndex = (currentDpiIndexRaw >= 0 && currentDpiIndexRaw <= 5) ? currentDpiIndexRaw : null;

  const pollingCode = getU8(15, 0);
  const modeByte = getU8(16, 0);
  const sleep16 = getU16(17, 0);

  const deviceState = decodeModeByteToState(modeByte);

  const debounceMs = getU8(19, 0);
  const ledRaw = getU8(20, 0);
  const mouseFwRaw = getU8(21, 0);
  const receiverFwRaw = getU8(22, 0);
  const sensorAngleRaw = getU8(23, 0);
  const sensorFeelRaw = getU8(24, 0);

  // 若固件在 config 包尾部携带按键映射(6组 funckey/keycode)，则一并解析
  let buttonMappings = null;
  if (dv.byteLength >= 25 + 12) {
    const out = [];
    for (let i = 0; i < 6; i++) {
      out.push({ funckey: getU8(25 + i * 2, 0), keycode: getU8(25 + i * 2 + 1, 0) });
    }
    buttonMappings = out;
  }

  return {
    type: "config",
    dpiSlots,
    currentSlotCount,
    currentDpiIndex,
    // 保留 raw 值，方便调试/兼容
    currentSlotCountRaw,
    currentDpiIndexRaw,
    pollingCode,
    pollingHz: MOUSE_HID.pollingCodeToHz[pollingCode] ?? null,
    modeByte,
    deviceState,
    performanceMode: deviceState.performanceMode,
    lodHeight: deviceState.lodHeight,
    motionSync: deviceState.motionSync,
    linearCorrection: deviceState.linearCorrection,
    rippleControl: deviceState.rippleControl,
    glassMode: deviceState.glassMode,
    sleep16,
    debounceMs,
    ledRaw,
    mouseFwRaw,
    receiverFwRaw,
    mouseFw: uint8ToVersion(mouseFwRaw),
    receiverFw: uint8ToVersion(receiverFwRaw),
    sensorAngleRaw,
    sensorAngle: decodeSensorAngleRaw(sensorAngleRaw),
    sensorFeelRaw,
    sensorFeel: decodeSensorFeelRaw(sensorFeelRaw),
    buttonMappings,
    raw,
  };
}

/**
 * WebHID 高层封装：把“发命令/收回包”封装成 UI 友好的方法。
 *
 * 用法示例：
 *   const api = new MouseMouseHidApi();
 *   await api.requestDevice();
 *   await api.open();
 *   api.onConfig(cfg => console.log(cfg));
 *   await api.requestConfig();
 */

function normalizeCapabilities(cap) {
  const c = (cap && typeof cap === "object") ? cap : {};
  const dpiSlotCount = Number.isFinite(Number(c.dpiSlotCount)) ? Math.max(1, Math.trunc(Number(c.dpiSlotCount))) : 6;
  const maxDpi = Number.isFinite(Number(c.maxDpi)) ? Math.max(1, Math.trunc(Number(c.maxDpi))) : 26000;
  const pollingRates = Array.isArray(c.pollingRates)
    ? c.pollingRates.map(Number).filter(Number.isFinite)
    : null;
  return { dpiSlotCount, maxDpi, pollingRates };
}

/**
 * 获取设备的默认能力配置（DPI 档位数、回报率列表）
 * 删除不稳定的 usagePage 检测，改为根据 PID 白名单直接判定
 */
function defaultCapabilitiesForDevice(dev) {
  // 1. 基础默认配置（适用于：有线模式、普通 1K 接收器）
  // 通常支持：125, 250, 500, 1000
  const base = { 
    dpiSlotCount: 6, 
    maxDpi: 26000, 
    pollingRates: [125, 250, 500, 1000] 
  };

  // 如果没有设备信息，直接返回默认值
  if (!dev) return base;

  // 2. 定义 8K 接收器的 PID 白名单
  // 依据 MOUSE_HID.vendorProductIds 中的定义，结尾为 0x...0b 的均为 8K 接收器
  const PIDS_8K = [
    0x520b, // CHAOS M1 无线 8K
    0x530b, // CHAOS M1 PRO 无线 8K
    0x540b, // CHAOS M2 PRO 无线 8K
    0x550b  // CHAOS M3 PRO / VT0 Air Max 无线 8K
  ];

  // 3. 新策略：如果 PID 在白名单中，强制覆盖为 8K 回报率列表
  if (PIDS_8K.includes(dev.productId)) {
    base.pollingRates = [125, 250, 500, 1000, 2000, 4000, 8000];
  }

  return base;
}


class MouseMouseHidApi {

  constructor({ device = null, txTimeoutMs = 2000, clearListenersOnClose = true, capabilities = null } = {}) {
    // 1. 初始化私有变量
    this._device = null;
    
    // 2. 通过 setter 设置设备 (这会自动调用 defaultCapabilitiesForDevice)
    this.device = device; 

    // 注意：如果构造函数传入了 explicit capabilities，则覆盖自动计算的值
    if (capabilities) {
        this.capabilities = normalizeCapabilities(capabilities);
    }

    this._onConfig = new Set();
    this._onBattery = new Set();
    this._onRawReport = new Set();

    // 最近一次收到的配置快照（用于“增量写 modeByte”时的 base）
    this._lastConfig = null;
    this._lastModeByte = null;

    this._boundHandler = (e) => this._handleInputReport(e);

    // ===== Tx: 预分配 Buffer + 异步发送队列（避免 sendReport 并发/顺序错乱） =====
    this._txBuffer = new Uint8Array(MOUSE_HID.reportSize);
    this._txQueue = Promise.resolve();

    // sendReport 超时：WebHID 本身没有内置超时；驱动/固件异常时 promise 可能悬挂导致队列堆积
    this._txTimeoutMs = Number.isFinite(Number(txTimeoutMs)) ? Math.max(0, Number(txTimeoutMs)) : 2000;
    this._clearListenersOnClose = !!clearListenersOnClose;
  }

  // device 的 getter/setter
  get device() {
    return this._device;
  }

  set device(dev) {
    this._device = dev;
    // 设备变更时清空快照，避免把上一只设备的 modeByte 当作 base 写入
    this._lastConfig = null;
    this._lastModeByte = null;
    // 设备变更时立即根据 PID 重新计算能力（有线/无线8K）
    // 确保 app.js 设置 device 后，hidApi.capabilities 立即更新为最新值
    this.capabilities = normalizeCapabilities(defaultCapabilitiesForDevice(dev));
  }

  async requestDevice({ filters = MOUSE_HID.defaultFilters } = {}) {
    const devs = await navigator.hid.requestDevice({ filters });
    this.device = devs?.[0] ?? null;
    
    return this.device;
  }

  async open() {
    if (!this.device) throw new Error("No HID device selected.");

    // 强力重置逻辑：防止设备被旧句柄占用
    if (this.device.opened) {
      try { await this.device.close(); } catch (_) {}
      // 等待释放
      await new Promise(r => setTimeout(r, 100));
    }

    try {
      await this.device.open();
    } catch (e) {
      const msg = String(e?.message || e);
      // 如果提示已经打开或被占用，尝试关闭后重试
      if (msg.includes("open") || msg.includes("lock")) {
         try { await this.device.close(); } catch (_) {}
         await new Promise(r => setTimeout(r, 200));
         await this.device.open();
      } else {
         throw e;
      }
    }
    
    // 使用 addEventListener，避免覆盖已有的事件监听器
    if (this._boundHandler) {
      this.device.removeEventListener("inputreport", this._boundHandler);
    } else {
      this._boundHandler = (e) => this._handleInputReport(e);
    }
    this.device.addEventListener("inputreport", this._boundHandler);
  }

  async close({ clearListeners = this._clearListenersOnClose } = {}) {
    if (!this.device) return;
    // 使用 removeEventListener 确保清理事件监听器
    if (this._boundHandler) {
      this.device.removeEventListener("inputreport", this._boundHandler);
    }
    this.device.oninputreport = null;
    // 重要：SPA 页面切换时，若不清理回调，Set 会长期持有闭包导致内存泄漏
    if (clearListeners) this.removeAllListeners();
    // 让后续 send 不再等待旧队列
    this._txQueue = Promise.resolve();
    if (this.device.opened) await this.device.close();
  }

  /** 清空所有事件监听（用于页面卸载/切换） */
  removeAllListeners() {
    this._onConfig.clear();
    this._onBattery.clear();
    this._onRawReport.clear();
  }

  /** 修改 sendReport 默认超时（ms）。传 0 可禁用超时。 */
  setTxTimeoutMs(ms) {
    const n = Number(ms);
    this._txTimeoutMs = Number.isFinite(n) ? Math.max(0, n) : this._txTimeoutMs;
  }

  onConfig(cb) { this._onConfig.add(cb); return () => this._onConfig.delete(cb); }
  onBattery(cb) { this._onBattery.add(cb); return () => this._onBattery.delete(cb); }
  onRawReport(cb) { this._onRawReport.add(cb); return () => this._onRawReport.delete(cb); }

  _ensureReady() {
    if (!this.device || !this.device.opened) throw new Error("HID device not opened.");
  }

  _enqueueSend(taskFn) {
    // 关键点：保证“串行”，且前一个任务失败不会阻断后续队列
    const p = this._txQueue.then(taskFn);
    this._txQueue = p.catch(() => undefined);
    return p;
  }

  async _sendFromBytes(payloadBytes, { timeoutMs } = {}) {
    this._ensureReady();

    const buf = this._txBuffer;
    // 32 bytes，fill 成本固定且很低；避免 “上次残留字节” 带来隐性 bug
    buf.fill(0);

    // payloadBytes 可能是 Uint8Array / ArrayLike<number>
    const len = Math.min(MOUSE_HID.reportSize, payloadBytes?.length ?? 0);
    for (let i = 0; i < len; i++) buf[i] = payloadBytes[i] & 0xff;

    await this._sendReport(buf, { timeoutMs });
  }

  _sendReport(buf, { timeoutMs } = {}) {
    this._ensureReady();
    const msRaw = timeoutMs == null ? this._txTimeoutMs : Number(timeoutMs);
    const ms = Number.isFinite(msRaw) ? Math.max(0, msRaw) : this._txTimeoutMs;

    const p = this.device.sendReport(MOUSE_HID.reportId, buf);
    if (ms <= 0) return p;

    let timer = null;
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`sendReport timeout after ${ms}ms`));
      }, ms);
    });

    return Promise.race([p, timeoutP]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  // 快速路径：避免为高频指令创建临时 Uint8Array
  _send1(cmd, { timeoutMs } = {}) {
    return this._enqueueSend(async () => {
      this._ensureReady();
      const buf = this._txBuffer;
      buf.fill(0);
      buf[0] = cmd & 0xff;
      await this._sendReport(buf, { timeoutMs });
    });
  }
  _send2(cmd, b1, { timeoutMs } = {}) {
    return this._enqueueSend(async () => {
      this._ensureReady();
      const buf = this._txBuffer;
      buf.fill(0);
      buf[0] = cmd & 0xff;
      buf[1] = b1 & 0xff;
      await this._sendReport(buf, { timeoutMs });
    });
  }
  _send4(cmd, b1, b2, b3, { timeoutMs } = {}) {
    return this._enqueueSend(async () => {
      this._ensureReady();
      const buf = this._txBuffer;
      buf.fill(0);
      buf[0] = cmd & 0xff;
      buf[1] = b1 & 0xff;
      buf[2] = b2 & 0xff;
      buf[3] = b3 & 0xff;
      await this._sendReport(buf, { timeoutMs });
    });
  }
  _send5(cmd, b1, b2, b3, b4, { timeoutMs } = {}) {
    return this._enqueueSend(async () => {
      this._ensureReady();
      const buf = this._txBuffer;
      buf.fill(0);
      buf[0] = cmd & 0xff;
      buf[1] = b1 & 0xff;
      buf[2] = b2 & 0xff;
      buf[3] = b3 & 0xff;
      buf[4] = b4 & 0xff;
      await this._sendReport(buf, { timeoutMs });
    });
  }

  /**
   * 通用 send：仍保留给外部/测试使用
   * - 现在不会再 new Uint8Array(32)
   * - 内部走发送队列，避免 sendReport 并发拥塞/乱序
   */
  async send(payloadBytes, { timeoutMs } = {}) {
    return this._enqueueSend(() => this._sendFromBytes(payloadBytes, { timeoutMs }));
  }

  // ===== 高频/常用 API（尽量走快速路径，减少临时对象） =====
  async requestConfig({ timeoutMs } = {}) {
    return this._send2(MOUSE_HID.cmds.GET, MOUSE_HID.getSubcmd.CONFIG, { timeoutMs });
  }
  async requestBattery({ timeoutMs } = {}) {
    return this._send2(MOUSE_HID.cmds.GET, MOUSE_HID.getSubcmd.BATTERY, { timeoutMs });
  }

  /** 等待下一次 config 包；超时会自动移除临时监听，避免泄漏 */
  waitForConfig({ timeoutMs = 1000 } = {}) {
    const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 1000;
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.onConfig((cfg) => {
        if (timer) clearTimeout(timer);
        off();
        resolve(cfg);
      });
      if (ms > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`waitForConfig timeout after ${ms}ms`));
        }, ms);
      }
    });
  }

  /** 等待下一次 battery 包；超时会自动移除临时监听，避免泄漏 */
  waitForBattery({ timeoutMs = 1000 } = {}) {
    const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 1000;
    return new Promise((resolve, reject) => {
      let timer = null;
      const off = this.onBattery((bat) => {
        if (timer) clearTimeout(timer);
        off();
        resolve(bat);
      });
      if (ms > 0) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`waitForBattery timeout after ${ms}ms`));
        }, ms);
      }
    });
  }

  /** 请求 config 并等待回包（可用于 UI 的“请求-响应”逻辑，避免无响应时一直挂起） */
  async requestConfigAndWait({ txTimeoutMs, responseTimeoutMs = 1000 } = {}) {
    await this.requestConfig({ timeoutMs: txTimeoutMs });
    return this.waitForConfig({ timeoutMs: responseTimeoutMs });
  }

  /** 请求 battery 并等待回包（可用于 UI 的“请求-响应”逻辑，避免无响应时一直挂起） */
  async requestBatteryAndWait({ txTimeoutMs, responseTimeoutMs = 1000 } = {}) {
    await this.requestBattery({ timeoutMs: txTimeoutMs });
    return this.waitForBattery({ timeoutMs: responseTimeoutMs });
  }

  async setDpi(slot1to6, dpi, { select = false } = {}) {
    // DPI 指令 payload 4 bytes，频率相对低；保留 encoder（可读性更强）
    return this.send(encodeSetDpi(slot1to6, dpi, { select }));
  }

  async setSlotCount(count1to6) { return this.send(encodeSetSlotCount(count1to6)); }
  async setPollingRateHz(hz) { return this.send(encodeSetPollingRateHz(hz)); }
  async setSleepSeconds(sec) { return this.send(encodeSetSleepSeconds(sec)); }


// ===== 统一化设置接口（供 UI 使用） =====
async setFeature(key, value) {
  const k = String(key || "").trim().toLowerCase();
  switch (k) {
    case "polling_rate":
    case "polling_rate_hz":
      return this.setPollingRateHz(value);
    case "sleep_timeout":
    case "sleep_seconds":
      return this.setSleepSeconds(value);
    case "debounce_ms":
      return this.setDebounceMs(value);
    case "rgb_switch":
    case "led_enabled":
      return this.setLedEnabled(!!value);
    // UI 侧常用 camelCase：sensorAngle
    case "sensorangle":
    case "sensor_angle":
      return this.setSensorAngle(value);
    // UI 侧常用 camelCase：sensorFeel
    case "sensorfeel":
    case "sensor_feel":
      return this.setSensorFeel(value);
    case "slot_count":
      return this.setSlotCount(value);
    default:
      throw new Error(`Unknown feature key: ${k}`);
  }
}

async setBatchFeatures(obj) {
  const payload = (obj && typeof obj === "object") ? obj : {};
  // Chaos：批量写入允许同时带上 polling_rate 等独立 feature。
  // 关键点：polling_rate 不能走 modeByte，否则会被“吞掉”或导致误覆盖。

  // 1) 独立 feature
  const poll = payload.polling_rate ?? payload.polling_rate_hz ?? payload.pollingHz ?? payload.polling_hz;
  if (poll != null) {
    await this.setPollingRateHz(poll);
  }

  // 其它独立 feature（避免被 UI 的 enqueueDevicePatch 走 batch 时“吞掉”）
  // 说明：这里只处理 Chaos 支持的 key；未知 key 直接忽略，交由上层决定是否降级。
  const sleep = payload.sleep_timeout ?? payload.sleep_seconds;
  if (sleep != null) {
    await this.setSleepSeconds(sleep);
  }

  const deb = payload.debounce_ms;
  if (deb != null) {
    await this.setDebounceMs(deb);
  }

  const led = payload.rgb_switch ?? payload.led_enabled;
  if (led != null) {
    await this.setLedEnabled(!!led);
  }

  const angle = payload.sensor_angle ?? payload.sensorAngle;
  if (angle != null) {
    await this.setSensorAngle(angle);
  }

  const feel = payload.sensor_feel ?? payload.sensorFeel;
  if (feel != null) {
    await this.setSensorFeel(feel);
  }

  const slotCount = payload.slot_count ?? payload.slotCount;
  if (slotCount != null) {
    await this.setSlotCount(slotCount);
  }

  // 2) modeByte 相关字段（只要 payload 中包含这些字段之一，就写 modeByte）
  const hasModeField = Object.prototype.hasOwnProperty.call(payload, "modeByte") ||
    Object.prototype.hasOwnProperty.call(payload, "mode_byte") ||
    Object.prototype.hasOwnProperty.call(payload, "performanceMode") ||
    Object.prototype.hasOwnProperty.call(payload, "performance_mode") ||
    Object.prototype.hasOwnProperty.call(payload, "lodHeight") ||
    Object.prototype.hasOwnProperty.call(payload, "lod") ||
    Object.prototype.hasOwnProperty.call(payload, "lod_height") ||
    Object.prototype.hasOwnProperty.call(payload, "motionSync") ||
    Object.prototype.hasOwnProperty.call(payload, "motion_sync") ||
    Object.prototype.hasOwnProperty.call(payload, "linearCorrection") ||
    Object.prototype.hasOwnProperty.call(payload, "linear_correction") ||
    Object.prototype.hasOwnProperty.call(payload, "rippleControl") ||
    Object.prototype.hasOwnProperty.call(payload, "ripple_control") ||
    Object.prototype.hasOwnProperty.call(payload, "glassMode") ||
    Object.prototype.hasOwnProperty.call(payload, "glass_mode");

  if (!hasModeField) return;

  // 如果调用方没有显式提供 base modeByte，则用最近一次 config 回包的 modeByte 作为 base。
  // 这样只改一两个开关时，不会把其它 bit 重置成默认值（刷新页误开/误关的核心原因）。
  const p2 = { ...payload };
  if (p2.modeByte == null && p2.mode_byte == null) {
    if (Number.isFinite(Number(this._lastModeByte))) {
      p2.modeByte = this._lastModeByte;
    } else {
      // 兜底：如果刷新后 UI 很早就触发了写入（尚未收到 config 回包），
      // 先拉一次 config 作为 base，避免用 0 作为 base 把其它 bit 误重置。
      try {
        const cfg = await this.requestConfigAndWait({ responseTimeoutMs: 400 });
        if (Number.isFinite(Number(cfg?.modeByte))) {
          this._lastModeByte = Number(cfg.modeByte) & 0xff;
          p2.modeByte = this._lastModeByte;
        }
      } catch (_) {
        // ignore
      }
    }
  }

  const mb = encodeModeByteFromState(p2);
  await this.setModeByte(mb);
}


  async setDebounceMs(ms) {
    const v = Math.max(0, Math.min(255, Number(ms) | 0));
    return this._send2(MOUSE_HID.cmds.SET_DEBOUNCE, v);
  }

  async setModeByte(modeByte) {
    const mb = Number(modeByte) & 0xff;
    // 乐观更新：避免下一次增量写仍然拿到旧 base
    this._lastModeByte = mb;
    return this._send2(MOUSE_HID.cmds.SET_MODE_BYTE, mb);
  }

  async setLedEnabled(enabled) {
    // [cmd, 0x00, 0x01, 0x00, 0xFF/0x00]
    return this._send5(MOUSE_HID.cmds.SET_LED, 0x00, 0x01, 0x00, enabled ? 0xff : 0x00);
  }

  async setSensorAngle(angle) {
    const a = Math.max(-100, Math.min(100, Number(angle) | 0));
    return this._send2(MOUSE_HID.cmds.SET_SENSOR_ANGLE, int8ToUint8(a));
  }

  async setSensorFeel(feel) {
    const v = Number(feel) | 0;
    const f = Math.max(-62, Math.min(65, v));
    const raw = f < 0 ? (128 + f) & 0x7f : (f & 0x7f);
    return this._send2(MOUSE_HID.cmds.SET_SENSOR_FEEL, raw);
  }

  async setButtonMapping(btnId1to6, funckey, keycode) {
    // 低频；保留 encoder
    return this.send(encodeButtonMapping(btnId1to6, funckey, keycode));
  }

  /**
   * Select 字符串设置按键映射（推荐 UI 使用）。
   * @param {number} btnId - 1..6（UI 语义）或 0..5（固件语义）
   * @param {string} selectLabel - 如 “左键”“A”“复制”“音量上”
   * @param {{ctrl?:boolean,shift?:boolean,alt?:boolean,win?:boolean}} [mod]
   */
  async setButtonMappingBySelect(btnId, selectLabel, mod = {}) {
    const { funckey, keycode } = resolveKeyAction(selectLabel, mod);
    return this.setButtonMapping(btnId, funckey, keycode);
  }

  async factoryReset() { return this._send1(MOUSE_HID.cmds.FACTORY_RESET); }

  _handleInputReport(event) {
    // 允许 ReportID=0（部分设备/系统特性）
    if (event.reportId !== 0 && event.reportId !== MOUSE_HID.reportId) return;

    try {
      // event.data 本身就是 DataView，直接解析即可（避免额外创建/复制）
      const dv = event.data;
      if (!dv || dv.byteLength < 2) return;

      // 可选：raw 回调（默认不建议在高频场景打开）
      if (this._onRawReport.size) {
        this._onRawReport.forEach((cb) => cb(dv, event));
      }

      const parsed = parseInputReport(dv, { reportId: event.reportId });

      if (parsed.type === "config") {
        if (!parsed.capabilities) parsed.capabilities = this.capabilities;
        else parsed.capabilities = { ...this.capabilities, ...normalizeCapabilities(parsed.capabilities) };

        // 记录最近一次配置，用于后续 setBatchFeatures 做 modeByte 的“增量写”
        this._lastConfig = parsed;
        if (Number.isFinite(Number(parsed.modeByte))) {
          this._lastModeByte = Number(parsed.modeByte) & 0xff;
        }

        this._onConfig.forEach((cb) => cb(parsed, event));
      } else if (parsed.type === "battery") {
        this._onBattery.forEach((cb) => cb(parsed, event));
      }
    } catch (err) {
      // 生产环境建议保持静默，避免控制台刷屏导致卡顿
      // console.error(err);
    }
  }
}

/* 兼容非模块引入：<script src="protocol_api.js"></script> */
if (typeof window !== "undefined") {
  window.ProtocolApi = {
    MOUSE_HID,
    resolveMouseDisplayName,
    uint8ToVersion,
    MouseMouseHidApi,
    // 编码/解析辅助
    encodeRequestConfig,
    encodeRequestBattery,
    sanitizeDpiInput,
    encodeSetDpi,
    encodeSetSlotCount,
    encodeSetPollingRateHz,
    encodeSetSleepSeconds,
    encodeSetDebounceMs,
    encodeSetModeByte,
    decodeModeByteToState,
    encodeModeByteFromState,
    encodeSetLedEnabled,
    encodeButtonMapping,
    // Select 字符串 → (funckey,keycode) 映射
    KEYMAP_ACTIONS,
    KEYBOARD_MOD_BITS,
    resolveKeyAction,
    labelFromFunckeyKeycode,
    listKeyActionsByType,
    listKeyActionsByCategory,
    encodeSetSensorAngle,
    encodeSetSensorFeel,
    encodeFactoryReset,
    parseInputReport,
    // 新增：工具函数（便于外部按需使用）
    normalizeButtonId,
    int8ToUint8,
    uint8ToInt8,
    decodeSensorAngleRaw,
    decodeSensorFeelRaw,
  };
}
