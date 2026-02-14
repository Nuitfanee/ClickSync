
const MOUSE_HID = {
  usagePage: 65290, // 1K/有线 UsagePage
  usagePage8K: 65280, // 8K 接收器
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
  // 1K 设备/有线模式使用 65290，8K 接收器使用 65280
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
  0x521c: "CHAOS M1 ",
  0x520c: "CHAOS M1 ",
  0x520b: "CHAOS M1 ",
  // CHAOS M1 PRO
  0x531c: "CHAOS M1 PRO ",
  0x530c: "CHAOS M1 PRO ",
  0x530b: "CHAOS M1 PRO ",
  // CHAOS M2 PRO
  0x541c: "CHAOS M2 PRO ",
  0x540c: "CHAOS M2 PRO ",
  0x540b: "CHAOS M2 PRO ",
  // CHAOS M3 PRO
  0x551c: "CHAOS M3 PRO ",
  0x550c: "CHAOS M3 PRO ",
  0x550b: "CHAOS M3 PRO ",
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

  // - 支持“增量更新”。
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

// ============================================================
// 0) 错误类型与基础工具函数
// ============================================================
class ProtocolError extends Error {
  constructor(message, code = "UNKNOWN", detail = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function assertFiniteNumber(n, name) {
  const x = Number(n);
  if (!Number.isFinite(x)) throw new ProtocolError(`${name} 不是有效数字`, "BAD_PARAM", { name, value: n });
  return x;
}

function clampInt(n, min, max) {
  const x = Math.trunc(Number(n));
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function toU8(n) {
  return clampInt(n, 0, 0xff);
}

function toI8(n) {
  const x = clampInt(n, -128, 127);
  return x < 0 ? (0x100 + x) : x;
}

// ============================================================
// 1) 传输层：UniversalHidDriver
// ============================================================
class SendQueue {
  constructor() {
    this._p = Promise.resolve();
  }
  enqueue(task) {
    this._p = this._p.then(task, task);
    return this._p;
  }
}

class UniversalHidDriver {
  constructor({ reportId = MOUSE_HID.reportId, reportSize = MOUSE_HID.reportSize } = {}) {
    this.device = null;
    this.queue = new SendQueue();
    this.reportId = reportId;
    this.reportSize = reportSize;
    this.sendTimeoutMs = 1200;
    this.defaultInterCmdDelayMs = 12;
  }

  setDevice(device) {
    this.device = device || null;
  }

  _requireDeviceOpen() {
    if (!this.device) throw new ProtocolError("设备未注入（hidApi.device 为空）", "NO_DEVICE");
    if (!this.device.opened) throw new ProtocolError("设备未打开（请先 open()）", "NOT_OPEN");
  }

  _fitToLen(u8, expectedLen) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8 || []);
    const n = Number(expectedLen);
    if (!Number.isFinite(n) || n <= 0) return u8;
    if (u8.byteLength === n) return u8;
    const out = new Uint8Array(n);
    out.set(u8.subarray(0, n));
    return out;
  }

  async _sendReportDirect(reportId, bytes) {
    this._requireDeviceOpen();
    const rid = Number(reportId);
    const dev = this.device;

    const runWithTimeout = async (p) => {
      await Promise.race([
        p,
        sleep(this.sendTimeoutMs).then(() => {
          throw new ProtocolError(`写入超时：${this.sendTimeoutMs}ms`, "IO_TIMEOUT");
        }),
      ]);
    };

    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const payload = this._fitToLen(raw, this.reportSize);
    await runWithTimeout(dev.sendReport(rid, payload));
  }

  async sendBytes(reportId, bytes) {
    return this.queue.enqueue(() => this._sendReportDirect(Number(reportId), bytes));
  }

  async runSequence(seq) {
    if (!Array.isArray(seq) || seq.length === 0) return;
    for (const cmd of seq) {
      await this.sendBytes(Number(cmd.rid ?? this.reportId), cmd.bytes || cmd.payload || cmd.u8 || []);
      const w = cmd.waitMs != null ? Number(cmd.waitMs) : this.defaultInterCmdDelayMs;
      if (w != null && w > 0) await sleep(w);
    }
  }
}

// ============================================================
// 2) 编码层：ProtocolCodec（Chaos 32 bytes）
// ============================================================
const ProtocolCodec = Object.freeze({
  pack({ cmd, dataBytes = [], reportSize = MOUSE_HID.reportSize }) {
    const out = new Uint8Array(reportSize);
    out[0] = toU8(cmd);
    const arr = dataBytes instanceof Uint8Array
      ? Array.from(dataBytes)
      : (Array.isArray(dataBytes) ? dataBytes : []);
    for (let i = 0; i < Math.min(arr.length, reportSize - 1); i++) {
      out[i + 1] = toU8(arr[i]);
    }
    return out;
  },
});

// ============================================================
// 3) Profile / 字段适配
// ============================================================
const DEFAULT_PROFILE = Object.freeze({
  id: "chaos",
  capabilities: Object.freeze({
    dpiSlotCount: 6,
    maxDpi: 26000,
    pollingRates: Object.freeze([125, 250, 500, 1000]),
  }),
  timings: Object.freeze({
    interCmdDelayMs: 8,
  }),
});

const KEY_ALIASES = Object.freeze({
  polling_rate: "pollingHz",
  polling_rate_hz: "pollingHz",
  polling_hz: "pollingHz",
  pollingHz: "pollingHz",
  pollingRateHz: "pollingHz",
  reportRateHz: "pollingHz",
  reportHz: "pollingHz",
  polling: "pollingHz",

  sleepTimeout: "sleepSeconds",
  sleep_timeout: "sleepSeconds",
  sleep_time: "sleepSeconds",
  sleepSeconds: "sleepSeconds",
  sleep_seconds: "sleepSeconds",

  debounceMs: "debounceMs",
  debounce_ms: "debounceMs",

  performanceMode: "performanceMode",
  performance_mode: "performanceMode",

  lodHeight: "lodHeight",
  lod: "lodHeight",
  lod_height: "lodHeight",

  motionSync: "motionSync",
  motion_sync: "motionSync",

  linearCorrection: "linearCorrection",
  linear_correction: "linearCorrection",

  rippleControl: "rippleControl",
  ripple_control: "rippleControl",

  glassMode: "glassMode",
  glass_mode: "glassMode",

  modeByte: "modeByte",
  mode_byte: "modeByte",

  sensorAngle: "sensorAngle",
  sensor_angle: "sensorAngle",

  sensorFeel: "sensorFeel",
  sensor_feel: "sensorFeel",

  ledEnabled: "ledEnabled",
  led_enabled: "ledEnabled",
  rgb_switch: "ledEnabled",
  ledRaw: "ledEnabled",

  currentSlotCount: "currentSlotCount",
  slotCount: "currentSlotCount",
  slot_count: "currentSlotCount",

  currentDpiIndex: "currentDpiIndex",
  dpiIndex: "currentDpiIndex",
  dpi_index: "currentDpiIndex",

  dpiSlots: "dpiSlots",
  dpi_slots: "dpiSlots",

  surfaceModePrimary: "lodHeight",
  surfaceModeSecondary: "glassMode",
  primaryLedFeature: "ledEnabled",
  surfaceFeel: "sensorFeel",
});

function normalizePayload(payload) {
  const src = isObject(payload) ? payload : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const nk = KEY_ALIASES[k] || k;
    out[nk] = v;
  }
  return out;
}

// ============================================================
// 4) 转换器：语义 -> 协议字节
// ============================================================
const TRANSFORMERS = Object.freeze({
  pollingCode(hzOrCode) {
    const n = Number(hzOrCode);
    if (Number.isFinite(n) && MOUSE_HID.pollingHzToCode[n] != null) return toU8(MOUSE_HID.pollingHzToCode[n]);
    if (Number.isFinite(n) && MOUSE_HID.pollingCodeToHz[n] != null) return toU8(n);
    return 0x01;
  },

  sleepCode(secondsOrCode) {
    const n = Number(secondsOrCode);
    if (Number.isFinite(n) && MOUSE_HID.sleepCodeToSeconds[n] != null) return toU8(n);
    let bestCode = 1;
    let bestDist = Infinity;
    for (const [codeStr, s] of Object.entries(MOUSE_HID.sleepCodeToSeconds)) {
      const dist = Math.abs(s - n);
      if (dist < bestDist) { bestDist = dist; bestCode = Number(codeStr); }
    }
    return toU8(bestCode);
  },

  debounceU8(ms) {
    return toU8(clampInt(assertFiniteNumber(ms, "debounceMs"), 0, 255));
  },

  ledBytes(enabled) {
    return [0x00, 0x01, 0x00, enabled ? 0xff : 0x00];
  },

  sensorAngleRaw(angle) {
    const a = clampInt(assertFiniteNumber(angle, "sensorAngle"), -100, 100);
    return int8ToUint8(a);
  },

  sensorFeelRaw(feel) {
    const v = Number(feel) | 0;
    const f = Math.max(-62, Math.min(65, v));
    return f < 0 ? (128 + f) & 0x7f : (f & 0x7f);
  },

  dpiPayload(slot1to6, dpi, select = false) {
    const slot = clampInt(assertFiniteNumber(slot1to6, "slot"), 1, 6);
    const safeDpi = sanitizeDpiInput(dpi);
    if (safeDpi == null) {
      throw new ProtocolError(`Invalid DPI value: ${dpi}`, "BAD_PARAM", { dpi });
    }
    const index = (safeDpi / 50) & 0xffff;
    const b1 = ((index >> 8) & 0x1f) | ((slot & 0x07) << 5);
    const b2 = index & 0xff;
    const cmd = select ? MOUSE_HID.cmds.SET_DPI_AND_SELECT : MOUSE_HID.cmds.SET_DPI_ONLY;
    return { cmd, dataBytes: [b1, b2, 0x00], dpi: safeDpi, slot };
  },

  buttonMappingBytes(btnId1to6, funckey, keycode) {
    const btn = normalizeButtonId(btnId1to6);
    return [btn & 0xff, Number(funckey) & 0xff, Number(keycode) & 0xff];
  },
});

// ============================================================
// 5) 语义规范表：SPEC
// ============================================================
const MODEBYTE_FIELDS = Object.freeze([
  "modeByte",
  "performanceMode",
  "lodHeight",
  "motionSync",
  "linearCorrection",
  "rippleControl",
  "glassMode",
]);

function planModeByteWrite(patch, nextState, ctx) {
  if (ctx._modeBytePlanned) return [];
  ctx._modeBytePlanned = true;

  // 关键点：modeByte 的合并写入
  // - 只读取本地快照 ctx.prevState（即 this._cfg）作为 base，避免覆盖其他 bit
  // - 仅当 patch 中显式出现的字段才修改相应 bit，实现“增量更新”
  // - 最终生成 SET_MODE_BYTE 指令，UI 无需关心位运算细节
  const prev = ctx.prevState || {};
  const base = Object.prototype.hasOwnProperty.call(patch, "modeByte")
    ? (Number(patch.modeByte) & 0xff)
    : (Number.isFinite(Number(prev.modeByte)) ? (Number(prev.modeByte) & 0xff) : encodeModeByteFromState(prev));

  const delta = {};
  for (const k of MODEBYTE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) delta[k] = patch[k];
  }

  const merged = encodeModeByteFromState({ modeByte: base, ...delta });
  nextState.modeByte = merged;
  const decoded = decodeModeByteToState(merged);
  nextState.performanceMode = decoded.performanceMode;
  nextState.lodHeight = decoded.lodHeight;
  nextState.motionSync = decoded.motionSync;
  nextState.linearCorrection = decoded.linearCorrection;
  nextState.rippleControl = decoded.rippleControl;
  nextState.glassMode = decoded.glassMode;
  nextState.deviceState = decoded;

  return [{
    rid: MOUSE_HID.reportId,
    bytes: ProtocolCodec.pack({ cmd: MOUSE_HID.cmds.SET_MODE_BYTE, dataBytes: [merged] }),
  }];
}

const SPEC = Object.freeze({
  pollingHz: {
    key: "pollingHz",
    kind: "direct",
    priority: 10,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_POLLING, dataBytes: [TRANSFORMERS.pollingCode(value)] };
    },
  },

  sleepSeconds: {
    key: "sleepSeconds",
    kind: "direct",
    priority: 15,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_SLEEP, dataBytes: [TRANSFORMERS.sleepCode(value)] };
    },
  },

  debounceMs: {
    key: "debounceMs",
    kind: "direct",
    priority: 20,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_DEBOUNCE, dataBytes: [TRANSFORMERS.debounceU8(value)] };
    },
  },

  ledEnabled: {
    key: "ledEnabled",
    kind: "direct",
    priority: 20,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_LED, dataBytes: TRANSFORMERS.ledBytes(!!value) };
    },
  },

  sensorAngle: {
    key: "sensorAngle",
    kind: "direct",
    priority: 30,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_SENSOR_ANGLE, dataBytes: [TRANSFORMERS.sensorAngleRaw(value)] };
    },
  },

  sensorFeel: {
    key: "sensorFeel",
    kind: "direct",
    priority: 30,
    encode(value) {
      return { cmd: MOUSE_HID.cmds.SET_SENSOR_FEEL, dataBytes: [TRANSFORMERS.sensorFeelRaw(value)] };
    },
  },

  currentSlotCount: {
    key: "currentSlotCount",
    kind: "direct",
    priority: 35,
    encode(value) {
      const c = clampInt(assertFiniteNumber(value, "currentSlotCount"), 1, 6);
      return { cmd: MOUSE_HID.cmds.SET_SLOT_COUNT, dataBytes: [c] };
    },
  },

  dpiSlot: {
    key: "dpiSlot",
    kind: "virtual",
    priority: 40,
    triggers: ["dpiSlot"],
    plan(patch) {
      const info = patch.dpiSlot;
      if (!isObject(info)) return [];
      const slot = info.slot ?? info.slotIndex ?? info.index ?? info.id ?? 1;
      const dpi = info.dpi ?? info.value ?? info.val ?? info.dpiValue;
      const select = !!info.select;
      const payload = TRANSFORMERS.dpiPayload(slot, dpi, select);
      return [{
        rid: MOUSE_HID.reportId,
        bytes: ProtocolCodec.pack({ cmd: payload.cmd, dataBytes: payload.dataBytes }),
      }];
    },
  },

  dpiSlots: {
    key: "dpiSlots",
    kind: "virtual",
    priority: 41,
    triggers: ["dpiSlots"],
    plan(patch, nextState, ctx) {
      if (!Array.isArray(patch.dpiSlots)) return [];
      const prev = ctx.prevState || {};
      const prevSlots = Array.isArray(prev.dpiSlots) ? prev.dpiSlots : [];
      const nextSlots = Array.isArray(nextState.dpiSlots) ? nextState.dpiSlots : [];
      const cmds = [];
      const maxSlots = clampInt(ctx.profile?.capabilities?.dpiSlotCount ?? 6, 1, 6);

      for (let i = 0; i < Math.min(nextSlots.length, maxSlots); i++) {
        const nv = Number(nextSlots[i]);
        const pv = Number(prevSlots[i]);
        if (Number.isFinite(nv) && nv === pv) continue;
        const payload = TRANSFORMERS.dpiPayload(i + 1, nv, false);
        cmds.push({
          rid: MOUSE_HID.reportId,
          bytes: ProtocolCodec.pack({ cmd: payload.cmd, dataBytes: payload.dataBytes }),
        });
      }
      return cmds;
    },
  },

  currentDpiIndex: {
    key: "currentDpiIndex",
    kind: "virtual",
    priority: 42,
    triggers: ["currentDpiIndex"],
    plan(patch, nextState) {
      if (!Object.prototype.hasOwnProperty.call(patch, "currentDpiIndex")) return [];
      const idx = clampInt(Number(nextState.currentDpiIndex ?? 0), 0, Math.max(0, Number(nextState.currentSlotCount ?? 1) - 1));
      const slots = Array.isArray(nextState.dpiSlots) ? nextState.dpiSlots : [];
      const dpi = slots[idx];
      if (!Number.isFinite(Number(dpi))) return [];
      const payload = TRANSFORMERS.dpiPayload(idx + 1, dpi, true);
      return [{
        rid: MOUSE_HID.reportId,
        bytes: ProtocolCodec.pack({ cmd: payload.cmd, dataBytes: payload.dataBytes }),
      }];
    },
  },

  buttonMapping: {
    key: "buttonMapping",
    kind: "virtual",
    priority: 60,
    triggers: ["buttonMapping"],
    plan(patch) {
      const bm = patch.buttonMapping;
      if (!isObject(bm)) return [];
      const btnId = bm.btnId ?? bm.btn ?? bm.button ?? bm.id ?? bm.index;
      const fk = bm.funckey ?? bm.func ?? 0;
      const kc = bm.keycode ?? bm.code ?? 0;
      return [{
        rid: MOUSE_HID.reportId,
        bytes: ProtocolCodec.pack({
          cmd: MOUSE_HID.cmds.SET_BUTTON_MAP,
          dataBytes: TRANSFORMERS.buttonMappingBytes(btnId, fk, kc),
        }),
      }];
    },
  },

  factoryReset: {
    key: "factoryReset",
    kind: "virtual",
    priority: 5,
    triggers: ["factoryReset"],
    plan() {
      return [{
        rid: MOUSE_HID.reportId,
        bytes: ProtocolCodec.pack({ cmd: MOUSE_HID.cmds.FACTORY_RESET, dataBytes: [] }),
      }];
    },
  },

  // modeByte 相关（compound）
  performanceMode: { key: "performanceMode", kind: "compound", priority: 30, triggers: ["performanceMode"], plan: planModeByteWrite },
  lodHeight: { key: "lodHeight", kind: "compound", priority: 30, triggers: ["lodHeight"], plan: planModeByteWrite },
  motionSync: { key: "motionSync", kind: "compound", priority: 30, triggers: ["motionSync"], plan: planModeByteWrite },
  linearCorrection: { key: "linearCorrection", kind: "compound", priority: 30, triggers: ["linearCorrection"], plan: planModeByteWrite },
  rippleControl: { key: "rippleControl", kind: "compound", priority: 30, triggers: ["rippleControl"], plan: planModeByteWrite },
  glassMode: { key: "glassMode", kind: "compound", priority: 30, triggers: ["glassMode"], plan: planModeByteWrite },
  modeByte: { key: "modeByte", kind: "compound", priority: 30, triggers: ["modeByte"], plan: planModeByteWrite },
});

// ============================================================
// 6) 计划器：CommandPlanner
// ============================================================
class CommandPlanner {
  constructor(profile) {
    this.profile = profile || DEFAULT_PROFILE;
  }

  _expandDependencies(patch) {
    return patch;
  }

  _buildNextState(prevState, patch) {
    const prev = prevState || {};
    const next = { ...prev, ...patch };

    const cap = this.profile?.capabilities || {};
    const maxSlots = clampInt(cap.dpiSlotCount ?? 6, 1, 6);

    const prevSlots = Array.isArray(prev.dpiSlots) ? prev.dpiSlots.slice(0, maxSlots) : [];
    let slots = Array.isArray(next.dpiSlots) ? next.dpiSlots.slice(0, maxSlots) : prevSlots.slice();
    while (slots.length < maxSlots) slots.push(prevSlots[slots.length] ?? 800);

    if (isObject(patch.dpiSlot)) {
      const info = patch.dpiSlot;
      const slot = clampInt(Number(info.slot ?? info.slotIndex ?? info.index ?? info.id ?? 1), 1, maxSlots);
      const dpi = sanitizeDpiInput(info.dpi ?? info.value ?? info.val ?? info.dpiValue);
      if (dpi != null) slots[slot - 1] = dpi;
      if (info.select) next.currentDpiIndex = slot - 1;
    }

    next.dpiSlots = slots;

    const count = clampInt(Number(next.currentSlotCount ?? prev.currentSlotCount ?? maxSlots), 1, maxSlots);
    next.currentSlotCount = count;

    const idx = clampInt(Number(next.currentDpiIndex ?? prev.currentDpiIndex ?? 0), 0, Math.max(0, count - 1));
    next.currentDpiIndex = idx;
    next.currentDpi = slots[idx] ?? next.currentDpi ?? null;

    if (isObject(patch.buttonMapping)) {
      if (!Array.isArray(next.buttonMappings)) {
        next.buttonMappings = Array.from({ length: 6 }, () => ({ funckey: 0, keycode: 0 }));
      }
      while (next.buttonMappings.length < 6) next.buttonMappings.push({ funckey: 0, keycode: 0 });
      const btnId = patch.buttonMapping.btnId ?? patch.buttonMapping.btn ?? patch.buttonMapping.button ?? patch.buttonMapping.id ?? patch.buttonMapping.index;
      const btn = normalizeButtonId(btnId);
      next.buttonMappings[btn] = {
        funckey: toU8(patch.buttonMapping.funckey ?? patch.buttonMapping.func ?? 0),
        keycode: toU8(patch.buttonMapping.keycode ?? patch.buttonMapping.code ?? 0),
      };
    }

    if (typeof next.performanceMode === "string") next.performanceMode = next.performanceMode.toLowerCase();
    if (typeof next.lodHeight === "string") next.lodHeight = next.lodHeight.toLowerCase();

    const modeTouched = MODEBYTE_FIELDS.some((k) => Object.prototype.hasOwnProperty.call(patch, k));
    if (modeTouched) {
      const base = Object.prototype.hasOwnProperty.call(patch, "modeByte")
        ? (Number(patch.modeByte) & 0xff)
        : (Number.isFinite(Number(prev.modeByte)) ? (Number(prev.modeByte) & 0xff) : encodeModeByteFromState(prev));
      const delta = {};
      for (const k of MODEBYTE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) delta[k] = patch[k];
      }
      const mb = encodeModeByteFromState({ modeByte: base, ...delta });
      next.modeByte = mb;
      const decoded = decodeModeByteToState(mb);
      next.performanceMode = decoded.performanceMode;
      next.lodHeight = decoded.lodHeight;
      next.motionSync = decoded.motionSync;
      next.linearCorrection = decoded.linearCorrection;
      next.rippleControl = decoded.rippleControl;
      next.glassMode = decoded.glassMode;
      next.deviceState = decoded;
    } else if (Number.isFinite(Number(next.modeByte))) {
      next.deviceState = decodeModeByteToState(next.modeByte);
    }

    if (Object.prototype.hasOwnProperty.call(next, "pollingHz")) {
      next.pollingCode = TRANSFORMERS.pollingCode(next.pollingHz);
    }
    if (Object.prototype.hasOwnProperty.call(next, "ledEnabled")) {
      next.ledRaw = next.ledEnabled ? 0xff : 0x00;
    }
    if (Object.prototype.hasOwnProperty.call(next, "sleepSeconds")) {
      next.sleep16 = TRANSFORMERS.sleepCode(next.sleepSeconds);
    }

    return next;
  }

  _collectSpecKeys(expandedPatch) {
    const keys = new Set();
    for (const k of Object.keys(expandedPatch)) {
      if (SPEC[k]) keys.add(k);
    }

    for (const item of Object.values(SPEC)) {
      if (item.kind === "compound") {
        const triggers = item.triggers || [];
        if (triggers.some((t) => t in expandedPatch)) keys.add(item.key);
      }
    }

    for (const item of Object.values(SPEC)) {
      if (item.kind === "virtual") {
        const triggers = item.triggers || [];
        if (triggers.some((t) => t in expandedPatch) || item.key in expandedPatch) keys.add(item.key);
      }
    }

    return Array.from(keys);
  }

  _topoSort(keys) {
    return keys
      .map((k) => SPEC[k])
      .filter(Boolean)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  _extractWriteKey(cmd) {
    try {
      const rid = Number(cmd.rid ?? MOUSE_HID.reportId);
      const bytes = cmd.bytes instanceof Uint8Array
        ? Array.from(cmd.bytes)
        : (Array.isArray(cmd.bytes) ? cmd.bytes : []);
      if (!bytes.length) return null;
      const head = bytes.slice(0, 8).map((b) => toU8(b)).join(",");
      return `${rid}:${head}`;
    } catch {
      return null;
    }
  }

  _dedupeCommands(commands) {
    const parsed = commands.map((c, idx) => ({ c, idx, key: this._extractWriteKey(c) }));
    const lastIndexByKey = new Map();
    for (const p of parsed) {
      if (p.key) lastIndexByKey.set(p.key, p.idx);
    }
    return parsed
      .filter((p) => !p.key || lastIndexByKey.get(p.key) === p.idx)
      .map((p) => p.c);
  }

  plan(prevState, externalPayload) {
    const patch0 = normalizePayload(externalPayload);
    const patch = this._expandDependencies(patch0, prevState);
    const nextState = this._buildNextState(prevState, patch);

    const specKeys = this._collectSpecKeys(patch);
    const ordered = this._topoSort(specKeys);
    const commands = [];
    const ctx = { profile: this.profile, prevState, _modeBytePlanned: false };

    for (const item of ordered) {
      if (!item) continue;

      if (typeof item.plan === "function") {
        const seq = item.plan(patch, nextState, ctx);
        if (Array.isArray(seq) && seq.length) commands.push(...seq);
        continue;
      }

      if (typeof item.encode === "function") {
        const value = patch[item.key];
        const enc = item.encode(value, nextState, ctx);
        const writes = Array.isArray(enc) ? enc : [enc];
        for (const w of writes) {
          if (!w) continue;
          const bytes = ProtocolCodec.pack({
            cmd: w.cmd,
            dataBytes: w.dataBytes || [],
          });
          commands.push({ rid: w.rid ?? MOUSE_HID.reportId, bytes, waitMs: w.waitMs });
        }
      }
    }

    const optimized = this._dedupeCommands(commands);
    return { patch, nextState, commands: optimized };
  }
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

  constructor({ profile = DEFAULT_PROFILE, device = null, txTimeoutMs = 2000, clearListenersOnClose = true, capabilities = null } = {}) {
    this._profile = profile || DEFAULT_PROFILE;
    this._planner = new CommandPlanner(this._profile);

    this._driver = new UniversalHidDriver({ reportId: MOUSE_HID.reportId, reportSize: MOUSE_HID.reportSize });
    if (Number.isFinite(Number(txTimeoutMs))) this._driver.sendTimeoutMs = Math.max(0, Number(txTimeoutMs));
    this._driver.defaultInterCmdDelayMs = this._profile.timings?.interCmdDelayMs ?? 8;

    this._opQueue = new SendQueue();

    this._device = null;
    this._cfg = this._makeDefaultCfg();

    this._onConfigCbs = [];
    this._onBatteryCbs = [];
    this._onRawReportCbs = [];

    this._boundInputHandler = null;
    this._clearListenersOnClose = !!clearListenersOnClose;

    if (device) this.device = device;
    if (capabilities) this.capabilities = normalizeCapabilities(capabilities);
  }

  get device() {
    return this._device;
  }

  set device(dev) {
    this._device = dev || null;
    this._driver.setDevice(this._device);

    const cap = normalizeCapabilities(defaultCapabilitiesForDevice(this._device));
    this._applyCapabilities(cap);

    // ???????????????????????
    this._cfg = this._makeDefaultCfg();
  }

  _applyCapabilities(cap) {
    const norm = normalizeCapabilities(cap);
    this._profile = { ...(this._profile || DEFAULT_PROFILE), capabilities: norm };
    this._planner.profile = this._profile;
    if (this._cfg) this._cfg.capabilities = { ...norm };
  }

  get capabilities() {
    return JSON.parse(JSON.stringify(this._profile?.capabilities || {}));
  }

  set capabilities(cap) {
    this._applyCapabilities(cap);
  }

  getCachedConfig() {
    const cfg = this._cfg;
    if (!cfg || typeof cfg !== "object") return null;
    try {
      return JSON.parse(JSON.stringify(cfg));
    } catch (_) {
      return { ...cfg };
    }
  }

  async requestDevice({ filters = MOUSE_HID.defaultFilters } = {}) {
    const devs = await navigator.hid.requestDevice({ filters });
    this.device = devs?.[0] ?? null;
    return this.device;
  }

  _bindInputReport() {
    if (!this.device) return;
    if (this._boundInputHandler) {
      try { this.device.removeEventListener("inputreport", this._boundInputHandler); } catch {}
    }

    this._boundInputHandler = (evt) => {
      try {
        const rid = Number(evt?.reportId ?? 0);
        const dv = evt?.data;
        const u8 = dv ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : null;

        if (this._onRawReportCbs.length) {
          for (const cb of this._onRawReportCbs.slice()) {
            try { cb(dv, evt); } catch {}
          }
        }

        if (u8 && u8.length) this._handleInputReport(rid, u8, evt);
      } catch {}
    };

    try { this.device.addEventListener("inputreport", this._boundInputHandler); } catch {}
  }

  async open() {
    if (!this.device) throw new ProtocolError("open() ?????? hidApi.device", "NO_DEVICE");

    if (this.device.opened) {
      this._bindInputReport();
      return;
    }

    try {
      await this.device.open();
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("open") || msg.includes("lock")) {
        try { await this.device.close(); } catch {}
        await new Promise((r) => setTimeout(r, 120));
        await this.device.open();
      } else {
        throw e;
      }
    }

    this._bindInputReport();
  }

  async close({ clearListeners = this._clearListenersOnClose } = {}) {
    if (!this.device) return;

    try { if (this._boundInputHandler) this.device.removeEventListener("inputreport", this._boundInputHandler); } catch {}
    this._boundInputHandler = null;

    if (clearListeners) this.removeAllListeners();

    // ????????????????
    this._opQueue = new SendQueue();
    this._driver.queue = new SendQueue();

    if (this.device.opened) await this.device.close();
  }

  removeAllListeners() {
    this._onConfigCbs.length = 0;
    this._onBatteryCbs.length = 0;
    this._onRawReportCbs.length = 0;
  }

  setTxTimeoutMs(ms) {
    const n = Number(ms);
    if (Number.isFinite(n)) this._driver.sendTimeoutMs = Math.max(0, n);
  }

  onConfig(cb, { replay = true } = {}) {
    if (typeof cb !== "function") return () => {};
    this._onConfigCbs.push(cb);

    if (replay && this._cfg) {
      queueMicrotask(() => {
        if (this._onConfigCbs.includes(cb)) cb(this._cfg);
      });
    }

    return () => {
      const idx = this._onConfigCbs.indexOf(cb);
      if (idx >= 0) this._onConfigCbs.splice(idx, 1);
    };
  }

  onBattery(cb, { replay = true } = {}) {
    if (typeof cb !== "function") return () => {};
    this._onBatteryCbs.push(cb);

    if (replay && Number.isFinite(Number(this._cfg?.batteryPercent)) && this._cfg?.batteryPercent >= 0) {
      queueMicrotask(() => {
        if (this._onBatteryCbs.includes(cb)) cb({ batteryPercent: this._cfg.batteryPercent });
      });
    }

    return () => {
      const idx = this._onBatteryCbs.indexOf(cb);
      if (idx >= 0) this._onBatteryCbs.splice(idx, 1);
    };
  }

  onRawReport(cb) {
    if (typeof cb !== "function") return () => {};
    this._onRawReportCbs.push(cb);
    return () => {
      const idx = this._onRawReportCbs.indexOf(cb);
      if (idx >= 0) this._onRawReportCbs.splice(idx, 1);
    };
  }

  waitForConfig(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const off = this.onConfig((cfg) => {
        clearTimeout(timer);
        off();
        resolve(cfg);
      }, { replay: false });

      const timer = setTimeout(() => {
        off();
        reject(new Error(`waitForConfig timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  waitForBattery(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const off = this.onBattery((bat) => {
        clearTimeout(timer);
        off();
        resolve(bat);
      }, { replay: false });

      const timer = setTimeout(() => {
        off();
        reject(new Error(`waitForBattery timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  async requestConfigAndWait({ txTimeoutMs, responseTimeoutMs = 1000 } = {}) {
    await this.requestConfig({ timeoutMs: txTimeoutMs });
    return this.waitForConfig(responseTimeoutMs);
  }

  async requestBatteryAndWait({ txTimeoutMs, responseTimeoutMs = 1000 } = {}) {
    await this.requestBattery({ timeoutMs: txTimeoutMs });
    return this.waitForBattery(responseTimeoutMs);
  }

  async requestConfig({ timeoutMs } = {}) {
    return this._opQueue.enqueue(async () => {
      if (!this.device) throw new ProtocolError("requestConfig() ?????? hidApi.device", "NO_DEVICE");
      if (!this.device.opened) await this.open();

      const bytes = ProtocolCodec.pack({
        cmd: MOUSE_HID.cmds.GET,
        dataBytes: [MOUSE_HID.getSubcmd.CONFIG],
      });

      await this._driver.runSequence([{ rid: MOUSE_HID.reportId, bytes, waitMs: 0 }]);
    });
  }

  async requestBattery({ timeoutMs } = {}) {
    return this._opQueue.enqueue(async () => {
      if (!this.device) throw new ProtocolError("requestBattery() ?????? hidApi.device", "NO_DEVICE");
      if (!this.device.opened) await this.open();

      const bytes = ProtocolCodec.pack({
        cmd: MOUSE_HID.cmds.GET,
        dataBytes: [MOUSE_HID.getSubcmd.BATTERY],
      });

      await this._driver.runSequence([{ rid: MOUSE_HID.reportId, bytes, waitMs: 0 }]);
    });
  }

  async setFeature(key, value) {
    const k = String(key || "");
    const payload = { [k]: value };
    await this.setBatchFeatures(payload);
  }

  async setBatchFeatures(obj) {
    const externalPayload = isObject(obj) ? obj : {};

    return this._opQueue.enqueue(async () => {
      if (!this.device) throw new ProtocolError("setBatchFeatures() ?????? hidApi.device", "NO_DEVICE");
      if (!this.device.opened) await this.open();

      const { patch, nextState, commands } = this._planner.plan(this._cfg, externalPayload);
      await this._driver.runSequence(commands);

      this._cfg = nextState;
      this._emitConfig();
      return { patch, commands };
    });
  }

  async setDpi(slot, value, opts = {}) {
    const s = clampInt(assertFiniteNumber(slot, "slot"), 1, 6);
    await this.setBatchFeatures({ dpiSlot: { slot: s, dpi: value, select: !!opts.select } });
  }

  async setSlotCount(n) {
    await this.setBatchFeatures({ currentSlotCount: n });
  }

  async setCurrentDpiIndex(index) {
    await this.setBatchFeatures({ currentDpiIndex: index });
  }

  async setPollingRateHz(hz) {
    await this.setBatchFeatures({ pollingHz: hz });
  }

  async setSleepSeconds(sec) {
    await this.setBatchFeatures({ sleepSeconds: sec });
  }

  async setDebounceMs(ms) {
    await this.setBatchFeatures({ debounceMs: ms });
  }

  async setModeByte(modeByte) {
    await this.setBatchFeatures({ modeByte });
  }

  async setLedEnabled(enabled) {
    await this.setBatchFeatures({ ledEnabled: !!enabled });
  }

  async setSensorAngle(angle) {
    await this.setBatchFeatures({ sensorAngle: angle });
  }

  async setSensorFeel(feel) {
    await this.setBatchFeatures({ sensorFeel: feel });
  }

  async setButtonMapping(btnId1to6, funckey, keycode) {
    await this.setBatchFeatures({ buttonMapping: { btnId: btnId1to6, funckey, keycode } });
  }

  async setButtonMappingBySelect(btnId, selectLabel, mod = {}) {
    const { funckey, keycode } = resolveKeyAction(selectLabel, mod);
    return this.setButtonMapping(btnId, funckey, keycode);
  }

  async factoryReset() {
    await this.setBatchFeatures({ factoryReset: true });
  }

  _makeDefaultCfg() {
    const cap = this._profile?.capabilities ?? DEFAULT_PROFILE.capabilities;
    const maxSlots = clampInt(cap.dpiSlotCount ?? 6, 1, 6);
    const pollingRates = Array.isArray(cap.pollingRates) && cap.pollingRates.length
      ? cap.pollingRates
      : [125, 250, 500, 1000];
    const defaultPollingHz = pollingRates.includes(1000)
      ? 1000
      : (pollingRates[0] ?? 1000);

    const dpiSlots = [800, 1200, 1600, 2400, 3200, 4800].slice(0, maxSlots);
    const currentSlotCount = Math.min(4, maxSlots);
    const currentDpiIndex = 0;

    const cfg = {
      capabilities: { ...cap },

      dpiSlots,
      currentSlotCount,
      currentDpiIndex,
      currentDpi: dpiSlots[currentDpiIndex] ?? 800,

      pollingHz: defaultPollingHz,
      pollingCode: TRANSFORMERS.pollingCode(defaultPollingHz),

      performanceMode: "low",
      lodHeight: "high",
      motionSync: false,
      linearCorrection: false,
      rippleControl: false,
      glassMode: false,

      sleepSeconds: MOUSE_HID.sleepCodeToSeconds[1] ?? 10,
      sleep16: 1,

      debounceMs: 0,
      ledEnabled: false,
      ledRaw: 0x00,

      sensorAngle: 0,
      sensorFeel: 0,

      batteryPercent: -1,

      buttonMappings: Array.from({ length: 6 }, () => ({ funckey: 0, keycode: 0 })),
    };

    cfg.modeByte = encodeModeByteFromState(cfg);
    cfg.deviceState = decodeModeByteToState(cfg.modeByte);

    return cfg;
  }

  _emitConfig() {
    const cfg = this._cfg;
    for (const cb of this._onConfigCbs.slice()) {
      try { cb(cfg); } catch {}
    }
  }

  _emitBattery(bat) {
    const b = bat || { batteryPercent: 100 };
    for (const cb of this._onBatteryCbs.slice()) {
      try { cb(b); } catch {}
    }
  }

  _handleInputReport(reportId, u8, event) {
    if (reportId !== 0 && reportId !== MOUSE_HID.reportId) return;
    try {
      const parsed = parseInputReport(u8, { reportId });
      if (parsed.type === "config") {
        const next = { ...this._cfg, ...parsed };
        if (Number.isFinite(Number(parsed.modeByte))) {
          const decoded = decodeModeByteToState(parsed.modeByte);
          next.modeByte = decoded.modeByte;
          next.performanceMode = decoded.performanceMode;
          next.lodHeight = decoded.lodHeight;
          next.motionSync = decoded.motionSync;
          next.linearCorrection = decoded.linearCorrection;
          next.rippleControl = decoded.rippleControl;
          next.glassMode = decoded.glassMode;
          next.deviceState = decoded;
        }

        if (!parsed.capabilities) next.capabilities = this.capabilities;
        else next.capabilities = { ...this.capabilities, ...normalizeCapabilities(parsed.capabilities) };

        if (Array.isArray(next.dpiSlots)) {
          const maxSlots = clampInt(next.currentSlotCount ?? next.dpiSlots.length ?? 1, 1, 6);
          const idx = clampInt(Number(next.currentDpiIndex ?? 0), 0, Math.max(0, maxSlots - 1));
          next.currentDpiIndex = idx;
          next.currentDpi = next.dpiSlots[idx] ?? next.currentDpi;
        }

        this._cfg = next;
        this._emitConfig();
      } else if (parsed.type === "battery") {
        const pct = clampInt(parsed.batteryPercent, 0, 100);
        this._cfg = { ...this._cfg, batteryPercent: pct };
        this._emitBattery({ batteryPercent: pct });
      }
    } catch (err) {
      // ??????????????????
    }
  }
}

/* ????????<script src="protocol_api_chaos.js"></script> */
if (typeof window !== "undefined") {
  const ProtocolApi = window.ProtocolApi = window.ProtocolApi || {};
  Object.assign(ProtocolApi, {
    MOUSE_HID,
    resolveMouseDisplayName,
    uint8ToVersion,
    MouseMouseHidApi,
    // ??/????
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
    // Select ??? -> (funckey,keycode)
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
    // ????????????
    normalizeButtonId,
    int8ToUint8,
    uint8ToInt8,
    decodeSensorAngleRaw,
    decodeSensorFeelRaw,
  });
}
