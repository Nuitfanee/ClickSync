/* protocol_api_atk.js
 * ============================================================
 * 目标：ATK  系列鼠标 WebHID 协议驱动
 * ============================================================
 *
 * 核心思想（请务必读完这段，后续扩展会非常顺手）：
 * 1) 业务层不应该拼报文、不应该关心寄存器地址/长度/等待/序列；
 * 2) 所有“协议知识”统一沉到 SPEC（规范表）+ Planner（计划器）+ Codec（编码器）；
 * 3) 新增功能时，通常只需要新增/修改一个 SPEC 条目（以及必要的 Transformer/Validator），
 *    业务层无需改动（或极小改动）。
 *
 * 本文件刻意避免：
 * - 旧式模板字符串
 * - 在业务逻辑里散落 if/else 特殊分支
 *
 * 现在的结构是：
 * - UniversalHidDriver：只负责“把命令送到设备”（传输层），不懂业务、不懂协议语义
 * - ProtocolCodec：统一生成 写命令 / 读命令（编码层）
 * - DEFAULT_PROFILE：机型能力、可用组合、节拍参数（配置层，未来支持多 profile）
 * - KEY_ALIASES / normalizePayload：统一前后端字段命名（适配层）
 * - TRANSFORMERS：语义值 -> 协议值/字节数组（转换层）
 * - SPEC：语义配置项规范（最关键）：validate/encode/plan/deps/priority
 * - CommandPlanner：把 patch 变成最终可执行 commands（排序/依赖补齐/去重/事务）
 * - MouseMouseHidApi：对外 API（业务入口），内部只调用 planner + driver
 */

(() => {
  "use strict";

  // ============================================================
  // 0) 基础工具与错误定义
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
  const clampInt = (n, min, max) => Math.min(max, Math.max(min, Math.trunc(Number(n))));
  const toU8 = (n) => clampInt(n, 0, 0xff);
  
  // byte[] -> hex
  function bytesToHex(bytes) {
    return Array.from(bytes || []).map((b) => toU8(b).toString(16).padStart(2, "0")).join("");
  }
  
  // hex -> Uint8Array
  function hexToU8(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 !== 0) throw new ProtocolError(`HEX 长度非法`, "BAD_HEX");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // ATK 专用：计算帧校验和 (Sum + Checksum == 0x4D)
  function calcFrameChecksum(u8) {
    let sum = 0;
    // 计算前 15 字节的和
    for (let i = 0; i < 15; i++) sum += (u8[i] || 0);
    // CHK = (0x4D - (sum & 0xFF)) & 0xFF
    return (0x4D - (sum & 0xFF)) & 0xFF;
  }

  // ATK 专用：生成 ValPair [val, ck] -> val + ck = 0x55
  function makeValPair(val) {
    const v = toU8(val);
    const ck = (0x55 - v) & 0xff;
    return [v, ck];
  }

  // ATK 专用：生成 Sum55Word [b0, b1, b2, b3] -> sum = 0x55
  function makeSum55Word(b0, b1, b2) {
    const s = (toU8(b0) + toU8(b1) + toU8(b2)) & 0xff;
    const b3 = (0x55 - s) & 0xff;
    return [toU8(b0), toU8(b1), toU8(b2), b3];
  }

  // ============================================================
  // 1) 传输层：UniversalHidDriver (适配 ATK InputReport 机制)
  // ============================================================
  class SendQueue {
    constructor() { this._p = Promise.resolve(); }
    enqueue(task) {
      this._p = this._p.then(task, task);
      return this._p;
    }
  }

  class UniversalHidDriver {
    constructor() {
      this.device = null;
      this.queue = new SendQueue();
      this.sendTimeoutMs = 1000;
      this.defaultInterCmdDelayMs = 5; 
      
      // 临时 InputReport 监听器映射 (用于 sendAndWaitForInput)
      this._pendingReads = new Set();
      
      this._globalInputHandler = this._handleInputReport.bind(this);
    }

    setDevice(device) {
      if (this.device) {
        try { this.device.removeEventListener("inputreport", this._globalInputHandler); } catch(e){}
      }
      this.device = device || null;
      if (this.device) {
        this.device.addEventListener("inputreport", this._globalInputHandler);
      }
    }

    _handleInputReport(e) {
      // 分发给所有正在等待的 Promise
      for (const item of this._pendingReads) {
        if (item.match(e)) {
          item.resolve(e);
          this._pendingReads.delete(item);
        }
      }
    }

    _requireDeviceOpen() {
      if (!this.device || !this.device.opened) throw new ProtocolError("设备未连接或未打开", "NOT_OPEN");
    }

    /**
     * ATK 核心写操作：发送 ReportID 0x08
     */
    async _sendReportDirect(hex) {
      this._requireDeviceOpen();
      const raw = hexToU8(hex);
      // ATK 固定 16 字节 Payload (+1 byte ReportID 由 API 处理)
      if (raw.length !== 16) {
        throw new ProtocolError(`ATK 协议帧长度必须为 16 (当前 ${raw.length})`, "BAD_FRAME");
      }
      await this.device.sendReport(0x08, raw);
    }

    /**
     * 发送并等待匹配的 Input Report
     * 场景：ATK 读取寄存器时，先发 OUT(OP=0x08)，设备回 IN(OP=0x08)
     */
    async sendAndWaitForInput({ hex, matchFn, timeoutMs = 500 }) {
      return this.queue.enqueue(async () => {
        this._requireDeviceOpen();
        
        // 1. 注册一次性监听
        let resolveFunc, rejectFunc;
        const p = new Promise((resolve, reject) => {
          resolveFunc = resolve;
          rejectFunc = reject;
        });

        const pendingItem = {
          match: matchFn, // (event) => boolean
          resolve: resolveFunc
        };
        this._pendingReads.add(pendingItem);

        // 2. 设定超时
        const timer = setTimeout(() => {
          this._pendingReads.delete(pendingItem);
          rejectFunc(new ProtocolError("等待设备响应超时", "IO_TIMEOUT"));
        }, timeoutMs);

        try {
          // 3. 发送指令
          await this._sendReportDirect(hex);
          // 4. 等待响应
          const evt = await p;
          clearTimeout(timer);
          
          const dv = evt.data;
          return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        } catch (e) {
          clearTimeout(timer);
          this._pendingReads.delete(pendingItem);
          throw e;
        }
      });
    }

    async sendHex(hex) {
      return this.queue.enqueue(() => this._sendReportDirect(String(hex)));
    }
    
    // 执行序列
    async runSequence(seq) {
      if (!Array.isArray(seq)) return;
      for (const cmd of seq) {
        // 区分是纯写还是需要等待响应
        // 这里的 cmd.hex 是已经编码好的 16字节帧
        await this.sendHex(cmd.hex);
        const w = cmd.waitMs ?? this.defaultInterCmdDelayMs;
        if (w > 0) await sleep(w);
      }
    }
  }

  // ============================================================
  // 2) 编码层：ProtocolCodec (ATK 16字节帧)
  // ============================================================
  const ProtocolCodec = Object.freeze({
    // OP 定义
    OP_WRITE: 0x07,
    OP_READ: 0x08,

    /**
     * 构建通用帧
     * Frame: [OP, CTX, ADDR_H, ADDR_L, LEN, ...DATA..., CHK]
     */
    buildFrame(op, addr, dataBytes = []) {
      const u8 = new Uint8Array(16).fill(0);
      u8[0] = toU8(op);
      u8[1] = 0x00; // CTX
      u8[2] = (addr >> 8) & 0xff;
      u8[3] = addr & 0xff;
      
      const bytes = Array.from(dataBytes || []).map(toU8);
      u8[4] = bytes.length; // LEN
      
      for (let i = 0; i < bytes.length && i < 10; i++) {
        u8[5 + i] = bytes[i];
      }
      
      u8[15] = calcFrameChecksum(u8);
      return bytesToHex(u8);
    },

    write(addr, dataBytes) {
      return this.buildFrame(this.OP_WRITE, addr, dataBytes);
    },

    // 读取请求：通常发送 ADDR, LEN=0(或期望长度?), DATA=0
    // 规范 1.2 B: OUT 填写 ADDR 与 Length (虽然 DATA 一般为 0)
    // 实际抓包显示 Read 请求 LEN 字段填期望读到的长度
    read(addr, expectLen) {
      const u8 = new Uint8Array(16).fill(0);
      u8[0] = toU8(this.OP_READ);
      u8[1] = 0x00;
      u8[2] = (addr >> 8) & 0xff;
      u8[3] = addr & 0xff;
      u8[4] = toU8(expectLen); // 告诉设备我想读多长
      u8[15] = calcFrameChecksum(u8);
      return bytesToHex(u8);
    },
    
    // 控制指令 (无 ADDR/LEN 或自定义)
    control(op, dataBytes = []) {
       return this.buildFrame(op, 0, dataBytes);
    },

    // 解析响应帧：校验 CHK，返回 { op, addr, len, data }
    parse(u8) {
      if (!u8 || u8.length !== 16) throw new ProtocolError("无效帧长", "BAD_FRAME");
      const chk = calcFrameChecksum(u8);
      if (u8[15] !== chk) throw new ProtocolError("帧校验失败", "BAD_CHECKSUM");
      
      return {
        op: u8[0],
        addr: (u8[2] << 8) | u8[3],
        len: u8[4],
        data: u8.slice(5, 5 + u8[4])
      };
    }
  });

  // ============================================================
  // 3) Profile：设备参数
  // ============================================================
  const DEFAULT_PROFILE = Object.freeze({
    id: "atk_default",
    capabilities: Object.freeze({
      dpiSlotMax: 6, // 规范提及 DPI1..DPI4..DPI8 但通常 UI 用 4-6 档
      dpiMin: 50,
      dpiMax: 26000, // PAW3395/3950
      pollingRates: [125, 250, 500, 1000, 2000, 4000, 8000], 
    }),
    timings: Object.freeze({
      interCmdDelayMs: 5,
      // DPI 表写入需要时间处理
      dpiWriteWaitMs: 15, 
    }),
  });


// ============================================================
// 3.5) DPI 预设（仿 Rapoo：主动预设 + 极速快照回读）
// 说明：当增加 DPI 挡位时，优先用预设值填充，避免 UI 先闪到协议最小值（如 100）
// ============================================================
const DPI_PRESETS = Object.freeze([400, 800, 1200, 1600, 2400, 3200, 6400]);

function _isFiniteNumber(n) { return Number.isFinite(Number(n)); }

/**
 * 生成“已补全”的 DPI 数组（长度固定为 maxSlots），用于：
 * - 增加挡位时给新挡位一个合理默认值（主动预设）
 * - 避免 requestConfig/回读把数组长度缩短导致 UI 空值
 */
function buildDpiSlotsWithPresets({ slots, targetCount, maxSlots, dpiMin, dpiMax }) {
  const prev = Array.isArray(slots) ? slots : [];
  const out = [];
  for (let i = 0; i < maxSlots; i++) {
    const raw = _isFiniteNumber(prev[i]) ? Number(prev[i]) : (DPI_PRESETS[i] ?? 800);
    out.push(clampInt(raw, dpiMin, dpiMax));
  }
  // targetCount 只用于确保前 N 个必有值；其余也保持补全，便于后续再次扩档时“无闪烁”
  return out;
}

  // ============================================================
  // 4) 字段适配
  // ============================================================
  const KEY_ALIASES = Object.freeze({
    pollingHz: "pollingHz",
    polling_rate: "pollingHz",
    currentDpiIndex: "currentDpiIndex",
    dpi_index: "currentDpiIndex",
    dpiSlots: "dpiSlots",
    lodHeight: "lodHeight",
    debounceMs: "debounceMs",
    motionSync: "motionSync",
    rippleControl: "rippleControl",
    linearCorrection: "linearCorrection",
    sleepSeconds: "sleepSeconds",
    sensorAngle: "sensorAngle",
    // 虚拟字段
    dpiProfile: "dpiProfile",
  
    debounce_ms: "debounceMs",
    sleep_timeout: "sleepSeconds",
    lod_high: "lodHeight",
    
    // 字段别名映射：确保这些字段能够正确透传
    opticalEngineHeightMm: "opticalEngineHeightMm",
    performanceMode: "performanceMode",
    performance_mode: "performanceMode",
    
    // 光学引擎挡位别名
    opticalEngineLevel: "opticalEngineLevel",
    optical_engine_level: "opticalEngineLevel",
    
    // 超远距离模式、灯效相关字段别名
    longRangeMode: "longRangeMode",       // 超远距离模式
    dpiLightEffect: "dpiLightEffect",     // DPI灯效
    receiverLightEffect: "receiverLightEffect", // 接收器灯效
    
    // DPI 颜色别名
    dpiColors: "dpiColors",
    dpi_colors: "dpiColors",
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
  // 5) 转换器：TRANSFORMERS (实现 ATK 复杂的编码逻辑)
  // ============================================================
  const TRANSFORMERS = Object.freeze({
    // 回报率编码：根据协议规范，使用特定标志值而非索引
    // 映射关系：125->0x08, 250->0x04, 500->0x02, 1000->0x01, 2000->0x10, 4000->0x20, 8000->0x40
    pollingHzValPair(hz) {
      const map = { 
        125: 0x08, 250: 0x04, 500: 0x02, 1000: 0x01, 
        2000: 0x10, 4000: 0x20, 8000: 0x40 
      };
      // 默认 1000Hz (01)
      const v = map[Number(hz)] ?? 0x01; 
      return makeValPair(v);
    },


    lodValPair(str) {
      const s = String(str).toLowerCase();
      const v = (s === "high" || s === "true" || s === "1" || s === "2.0" || s === "2") ? 2 : 1;
      return makeValPair(v);
    },

    // 光学高度编码：将毫米值转换为寄存器编码值
    // 转换公式：(mm * 10) - 6 => code
    // 示例：0.7mm -> 1, 1.3mm -> 7, 1.7mm -> 11
    opticalHeightValPair(val) {
      let mm = parseFloat(val);
      if (!Number.isFinite(mm)) {
         // 兼容文本输入，默认为 1.0mm
         mm = 1.0; 
      }
      // 计算 code
      let code = Math.round(mm * 10) - 6;
      // 限制范围，防止溢出
      if (code < 1) code = 1; 
      if (code > 20) code = 20;
      return makeValPair(code);
    },

    // 光学引擎挡位编码：直接透传 1-11 的挡位数值
    opticalLevelValPair(level) {
      const v = clampInt(level, 1, 11);
      return makeValPair(v); // ATK 协议需要 [val, 0x55-val] 校验对
    },

    // 性能模式编码：将模式枚举转换为协议值
    // 映射关系：Low->0, HP->1, OC->2
    perfModeValPair(mode) {
      const s = String(mode).toLowerCase();
      let v = 0; // default Low
      if (s === "oc" || s === "sport") v = 2;       // OC
      else if (s === "hp" || s === "standard") v = 1; // HP
      else v = 0; // Low
      return makeValPair(v);
    },

    // DPI Word 编码 (规范 Section 5)
    dpiWord(dpi) {
      const d = clampInt(dpi, 50, 30000);
      let b0, b1, b2;

      if (d <= 10000) {
        // 5.1 旧模式
        const code = Math.floor((Math.floor(d / 10) * 10) / 10) - 1; // Simplify: floor(d/10) - 1
        b0 = code & 0xff;
        b1 = b0;
        // b2 = ((code >> 8) * 0x44) & 0xFF
        b2 = ((code >> 8) * 0x44) & 0xff;
      } else {
        // 5.2 新模式 (>10000)
        const dpiAdj = Math.max(d, 10050);
        // Step = floor((DPI_q - 10050)/50)
        const step = Math.floor((dpiAdj - 10050) / 50);
        
        if (step <= 255) {
          b2 = 0x22;
          b0 = step & 0xff;
          b1 = step & 0xff;
        } else if (step <= 400) {
          b2 = 0x66;
          b0 = (step - 256) & 0xff;
          b1 = b0;
        } else {
          b2 = 0x33;
          b0 = (step - 401) & 0xff;
          b1 = b0;
        }
      }
      
      // 生成 Sum55 Word: [b0, b1, b2, b3]
      return makeSum55Word(b0, b1, b2);
    },

    // DPI Word 解码 (严格对齐规范 Section 5)
    decodeDpiWord(buf) {
      if (!buf || buf.length < 4) return 800;
      const b0 = buf[0];
      const b1 = buf[1];
      const b2 = buf[2];
      const b3 = buf[3];

      // 校验 Sum55 约束：(b0+b1+b2+b3) & 0xFF 必须等于 0x55
      if (((b0 + b1 + b2 + b3) & 0xFF) !== 0x55) {
        console.warn("[Protocol] DPI Word Checksum 校验失败");
      }

      // 1. 判断是否为新模式 (根据规范 5.2 章节定义的 b2 特征值)
      if (b2 === 0x22 || b2 === 0x66 || b2 === 0x33) {
        let step = 0;
        if (b2 === 0x22) step = b0;
        else if (b2 === 0x66) step = b0 + 256;
        else if (b2 === 0x33) step = b0 + 401;
        
        // 公式：DPI_q = 10050 + 50 * Step
        return 10050 + step * 50;
      } 
      
      // 2. 否则为旧模式 (根据规范 5.1 章节)
      // b2 的生成规则是 ((code >> 8) * 0x44)，反推高位字节
      const codeHigh = Math.round(b2 / 0x44);
      const code = (codeHigh << 8) | b0;
      
      // 公式：code = DPI_q / 10 - 1  =>  DPI_q = (code + 1) * 10
      return (code + 1) * 10;
    },

    // Action4 按键映射
    action4Bytes(action) {
       // action: { type, code }
       const type = action?.type ?? 0;
       const code = action?.code ?? 0;
       // Action4 结构: [type, code, 00, ck] (Sum55)
       // 注意 规范 8.1 提及 "code"
       // 如果 code > 255 (如键盘宏), 需要特殊处理吗？规范里 Action4 LEN=4
       // 假设 code 是单字节，或者对于多媒体键有特殊 type
       return makeSum55Word(type, code, 0x00);
    },
    
    // 基础类型转 ValPair
    boolValPair(b) {
      return makeValPair(b ? 1 : 0);
    },
    
    intValPair(n) {
      return makeValPair(n);
    },

    // 修正高级参数的解析：从 10 字节 Buffer 中还原状态
    // 数据流：[Debounce(2), Ripple(2), Sleep(2), Motion(2), Linear(2)]
    decodeAdvParams(buf) {
      if (!buf || buf.length < 10) return {};
      
      return {
        debounceMs: buf[0], // Offset 0
        // 根据实测校准的顺序映射：
        rippleControl: buf[2] === 0x01,    // Offset 2 是纹波
        sleepSeconds: buf[4] * 10,         // Offset 4 是休眠 (单位10s)
        motionSync: buf[6] === 0x01,       // Offset 6 是移动同步
        linearCorrection: buf[8] === 0x01  // Offset 8 是直线修正
      };
    },

    // 修正传感器角度的解析
    // 协议通常是：[Angle_Low, Angle_High, Enable_Low, Enable_High]
    decodeSensorAngle(buf) {
      if (!buf || buf.length < 4) return { sensorAngle: 0 };
      let angle = buf[0]; 
      // 处理补码（如果是负数）
      if (angle > 128) angle = angle - 256; 
      
      const enabled = buf[2] === 0x01;
      return { sensorAngle: enabled ? angle : 0 };
    },

    // 生成 10 字节通用 Payload（用于 0x14、0x16 指令）
    // 协议规范：Payload 长度为 0x0A (10 字节)
    simpleModeBytes(mode) {
      const u8 = new Uint8Array(10).fill(0);
      u8[0] = toU8(mode);
      return Array.from(u8);
    },

    // DPI 灯效字节生成：根据模式值生成对应的协议字节序列
    dpiLightBytes(mode) {
      const m = clampInt(mode, 0, 2);
      if (m === 0) {
       
        return [0x00, 0x00, 0x80, 0xD5, 0x05, 0x50, 0x00, 0x55];
      } else if (m === 1) {
        
        return [0x01, 0x54, 0x80, 0xD5, 0x05, 0x50, 0x01, 0x54];
      } else {
        
        return [0x02, 0x53, 0x80, 0xD5, 0x03, 0x52, 0x01, 0x54];
      }
    },

    // RGB 颜色转换：将颜色值转换为协议格式
    // 输入: "#RRGGBB" 或 [r,g,b]
    // 输出: [r, g, b, ck] (Sum55 校验格式)
    rgbSum55(color) {
      let r = 255, g = 0, b = 0;
      if (Array.isArray(color) && color.length >= 3) {
        [r, g, b] = color;
      } else if (typeof color === "string") {
        const hex = color.replace(/^#/, "");
        if (hex.length === 6) {
          const num = parseInt(hex, 16);
          r = (num >> 16) & 0xff;
          g = (num >> 8) & 0xff;
          b = num & 0xff;
        }
      }
      return makeSum55Word(r, g, b);
    },

    // RGB 解码：将协议字节序列转换为十六进制颜色字符串
    // 输入: Uint8Array(4) [r, g, b, ck]
    // 输出: "#RRGGBB"
    decodeRgb(buf) {
      if (!buf || buf.length < 3) return "#FF0000";
      const toHex = (n) => toU8(n).toString(16).padStart(2, "0");
      return `#${toHex(buf[0])}${toHex(buf[1])}${toHex(buf[2])}`;
    }
  });

  // ============================================================
  // 6) 寄存器定义
  // ============================================================
  const REGS = Object.freeze({
    // 系统配置 (0x0000, LEN=6)
    // Offset 0: Polling (ValPair)
    // Offset 2: SlotCount (ValPair)
    // Offset 4: CurrentIndex (ValPair)
    SYS_CONFIG: 0x0000, 
    
    // LOD (0x000A, LEN=2)
    LOD: 0x000A,

    // DPI Table Base (0x000C)
    // 每个 DPI 槽位 8 字节 (4B DpiWord + 4B AuxWord)
    DPI_BASE: 0x000C,

    // Advanced Params (0x00A9, LEN=10)
    // Offset 0: Debounce (ValPair)
    // Offset 2: MotionSync (ValPair)
    // Offset 4: SleepTime (ValPair, unit 10s)
    // Offset 6: LinearCorrection (ValPair)
    // Offset 8: RippleControl (ValPair)
    ADV_PARAMS: 0x00A9,

    // Sensor Angle (0x00BD, LEN=4)
    // Offset 0: Angle (ValPair, signed)
    // Offset 2: Enable (ValPair)
    ANGLE: 0x00BD,

    // 按键映射相关地址
    KEYMAP_BASE: 0x0060,  // Action4 基地址
    KEYSEQ_BASE: 0x0100,  // KeySeq 基地址（步进 32 字节）

    // DPI 灯效地址（基于协议抓包确认）
    DPI_LED: 0x004C,

    // DPI 颜色表基地址
    // 结构：每次读写 8 字节（包含 2 个 RGBWord）
    // 0x002C: Slot1_RGB, Slot2_RGB
    // 0x0034: Slot3_RGB, Slot4_RGB
    DPI_COLOR_BASE: 0x002C,
  });

  // ============================================================
  // 7) 业务逻辑规范：SPEC
  // ============================================================
  const SPEC = Object.freeze({
    // 轮询率：位于 0x0000 (Offset 0)
    pollingHz: {
      key: "pollingHz",
      encode(val) {
        return {
          addr: REGS.SYS_CONFIG + 0, // 0x0000
          data: TRANSFORMERS.pollingHzValPair(val) // 2 bytes
        };
      }
    },

    // LOD：位于 0x000A - 保留兼容旧接口
    lodHeight: {
      key: "lodHeight",
      encode(val) {
        return {
          addr: REGS.LOD,
          data: TRANSFORMERS.lodValPair(val)
        };
      }
    },

    // 光学高度配置：地址 0x000A
    // 字段名 opticalEngineHeightMm 用于匹配 UI 层下发的字段
    opticalEngineHeightMm: {
      key: "opticalEngineHeightMm",
      encode(val) {
        return {
          addr: REGS.LOD, // 0x000A
          data: TRANSFORMERS.opticalHeightValPair(val)
        };
      }
    },

    // 光学引擎挡位配置：直接透传 1-11 的挡位数值
    opticalEngineLevel: {
      key: "opticalEngineLevel",
      encode(val) {
        return {
          addr: REGS.LOD, // 地址 0x000A 保持不变
          data: TRANSFORMERS.opticalLevelValPair(val)
        };
      }
    },

    // 性能模式配置
    // 协议规范：写入 0x00B5 长度 6，有效值位于第 4 字节，对应地址 0x00B9
    performanceMode: {
      key: "performanceMode",
      encode(val) {
        return {
          addr: 0x00B9, // 0x00B5 + 4
          data: TRANSFORMERS.perfModeValPair(val)
        };
      }
    },

    // 高级参数组：合并写入 0x00A9 寄存器
    // 以下字段仅作为状态占位，实际编码由 advParams 统一处理
    debounceMs: { key: "debounceMs" },
    motionSync: { key: "motionSync" },
    sleepSeconds: { key: "sleepSeconds" },
    linearCorrection: { key: "linearCorrection" },
    rippleControl: { key: "rippleControl" },

    // 虚拟聚合参数：高级参数组统一处理
    advParams: {
      key: "advParams",
      kind: "virtual",
      plan(patch, nextState) {
        // 1. 获取最新状态
        const debounce = nextState.debounceMs ?? 2;
        const motion = nextState.motionSync ?? false;
        const sleep = nextState.sleepSeconds ?? 60;
        const linear = nextState.linearCorrection ?? false;
        const ripple = nextState.rippleControl ?? false;

        // 2. 转换为字节对
        const bDebounce = TRANSFORMERS.intValPair(debounce);
        const bMotion = TRANSFORMERS.boolValPair(motion);
        
        // Sleep 转换 (30min = 180, 单位 10s)
        const sleepUnits = Math.max(1, Math.round(sleep / 10));
        const bSleep = TRANSFORMERS.intValPair(sleepUnits);
        
        const bLinear = TRANSFORMERS.boolValPair(linear);
        const bRipple = TRANSFORMERS.boolValPair(ripple);

        // 拼接 10 字节数据
        // 字节顺序（基于协议规范）：
        //  [Debounce, Ripple, Sleep, Motion, Linear]
        const data = [
          ...bDebounce, 
          ...bRipple,  // 位置 1: 实际上是纹波修正
          ...bSleep,   // 位置 2: 休眠时间
          ...bMotion,  // 位置 3: 实际上是移动同步
          ...bLinear   // 位置 4: 实际上是直线修正
        ];

        // 生成写指令
        return [{
          hex: ProtocolCodec.write(REGS.ADV_PARAMS, data),
          waitMs: 10
        }];
      }
    },

    // 角度捕捉：0x00BD 
    sensorAngle: { 
      key: "sensorAngle", 
      encode(val) { 
        // 1. 数据清洗与限制范围 -30 ~ 30 
        const angle = Math.max(-30, Math.min(30, Math.trunc(Number(val) || 0))); 
        
        // 2. 补码处理 (负数转为 unsigned byte) 
        const rawAngle = angle < 0 ? 256 + angle : angle; 
        
        // 生成 Angle ValPair [Value, Checksum]
        // 使用 intValPair 生成符合 Sum=0x55 规则的字节对
        const [vAng, cAng] = TRANSFORMERS.intValPair(rawAngle); 
 
        // 生成 Enable ValPair [Value, Checksum]
        // 协议规范：即使角度为 0，Enable 位也应为 1（基于抓包分析：00 55 01 54） 
        const [vEn, cEn] = TRANSFORMERS.intValPair(1); 
 
        return { 
          addr: REGS.ANGLE, 
          data: [vAng, cAng, vEn, cEn] 
        }; 
      } 
    },

    // 虚拟 DPI 配置：处理 DPI 数组、SlotCount、CurrentIndex
    dpiProfile: {
      key: "dpiProfile",
      kind: "virtual",
      triggers: ["dpiSlots", "currentDpiIndex", "currentSlotCount"],
      
      plan(patch, nextState, ctx) {
        const cmds = [];
        const cap = ctx.profile.capabilities;
        
        const slots = nextState.dpiSlots || [];
        const count = clampInt(nextState.currentSlotCount || 1, 1, cap.dpiSlotMax);
        
        // ATK 协议中每个 DPI 档位连续排列，各占 4 字节
        for (let i = 0; i < count; i++) {
          const val = slots[i] || 800;
          const addr = REGS.DPI_BASE + (i * 4); // 偏移量：每个档位 4 字节
          
          const word = TRANSFORMERS.dpiWord(val); // 4 字节的 DPI 编码数据
          
          // 仅写入 4 字节 DPI 数据，不附带 aux 数据，避免覆盖后续档位
          cmds.push({
            hex: ProtocolCodec.write(addr, word),
            waitMs: 5
          });
        }
        
        // 3. Slot Count (0x0002) - 保持不变
        if ("currentSlotCount" in patch) {
          cmds.push({
            hex: ProtocolCodec.write(REGS.SYS_CONFIG + 2, TRANSFORMERS.intValPair(count))
          });
        }
        
        // 4. Current Index (0x0004) - 保持不变
        if ("currentDpiIndex" in patch || "currentSlotCount" in patch) {
          const idx = clampInt(nextState.currentDpiIndex || 0, 0, count - 1);
          cmds.push({
            hex: ProtocolCodec.write(REGS.SYS_CONFIG + 4, TRANSFORMERS.intValPair(idx))
          });
        }
        
        return cmds;
      }
    },

    // 超远距离模式配置
    // 协议：使用 Control OP 0x16
    longRangeMode: {
      key: "longRangeMode",
      plan(patch, nextState) {
        const val = (patch.longRangeMode === true || patch.longRangeMode === 1) ? 1 : 0;
        return [{
          hex: ProtocolCodec.control(0x16, TRANSFORMERS.simpleModeBytes(val)),
          waitMs: 20
        }];
      }
    },

    // 接收器灯效配置
    // 协议：使用 Control OP 0x14
    receiverLightEffect: {
      key: "receiverLightEffect",
      plan(patch, nextState) {
        const val = clampInt(patch.receiverLightEffect, 0, 3);
        return [{
          hex: ProtocolCodec.control(0x14, TRANSFORMERS.simpleModeBytes(val)),
          waitMs: 20
        }];
      }
    },

    // DPI 灯效配置
    // 协议：使用 Write OP 0x07 写入地址 0x004C
    dpiLightEffect: {
      key: "dpiLightEffect",
      encode(val) {
        return {
          addr: REGS.DPI_LED, // 0x004C
          data: TRANSFORMERS.dpiLightBytes(val)
        };
      }
    },

    // DPI 颜色配置
    dpiColors: {
      key: "dpiColors",
      kind: "virtual",
      plan(patch, nextState, ctx) {
        const cmds = [];
        const colors = nextState.dpiColors || [];
        const cap = ctx.profile.capabilities;
        // 即使当前只用 4 档，通常也建议写满 6/8 档以防切换 SlotCount 时颜色丢失
        // 这里根据 capabilities.dpiSlotMax (通常 6) 来遍历
        const maxSlots = cap.dpiSlotMax || 6;

        // 步长为 2 (每次处理两个颜色)
        for (let i = 0; i < maxSlots; i += 2) {
          // 颜色 1
          const c1 = colors[i] || "#FF0000";
          const bytes1 = TRANSFORMERS.rgbSum55(c1);
          
          // 颜色 2 (如果越界则给默认值)
          const c2 = colors[i + 1] || "#00FF00";
          const bytes2 = TRANSFORMERS.rgbSum55(c2);

          // 计算地址: Base + (blockIndex * 8)
          // i=0 -> 0x002C, i=2 -> 0x0034
          const offset = (i / 2) * 8;
          const addr = REGS.DPI_COLOR_BASE + offset;

          cmds.push({
            hex: ProtocolCodec.write(addr, [...bytes1, ...bytes2]), // 拼接 8 字节
            waitMs: 10 // 颜色写入稍微给点延迟
          });
        }
        return cmds;
      }
    },
  });

  // ============================================================
  // 7.5) 按键映射定义 (新增)
  // ============================================================
  const KEYMAP_ACTIONS = (() => {
    const actions = Object.create(null);
    const add = (label, type, funckey, keycode) => {
      if (!label || actions[label]) return;
      actions[label] = {
        type: String(type || "system"),
        funckey: toU8(funckey),
        keycode: clampInt(keycode, 0, 0xffff),
      };
    };

    // 1. 鼠标 (Type: mouse)
    add("左键", "mouse", 0x01, 0x00);
    add("右键", "mouse", 0x02, 0x00);
    add("中键", "mouse", 0x04, 0x00);
    add("后退", "mouse", 0x08, 0x00);
    add("前进", "mouse", 0x10, 0x00);
    add("DPI循环", "mouse", 0x00, 0x03);

    // 2. 主键盘 A-Z
    for (let i = 0; i < 26; i++) add(String.fromCharCode(65 + i), "keyboard", 0x00, 0x04 + i);
    
    // 3. 主键盘数字区 (1-0) -> 标签 !1 ... )0
    const mainNums = [["!1",0x1E], ["@2",0x1F], ["#3",0x20], ["$4",0x21], ["%5",0x22], ["^6",0x23], ["&7",0x24], ["*8",0x25], ["(9",0x26], [")0",0x27]];
    mainNums.forEach(([l, c]) => add(l, "keyboard", 0x00, c));
    
    // 4. 功能键 & 控制键
    const ctrls = [
      ["Enter",0x28], ["Escape",0x29], ["Backspace",0x2A], ["Tab",0x2B], ["Space",0x2C],
      ["- _",0x2D], ["= +",0x2E], ["[ {",0x2F], ["] }",0x30], ["\\ |",0x31],
      ["; :",0x33], ["' \"",0x34], ["` ~",0x35], [", <",0x36], [". >",0x37], ["/ ?",0x38],
      ["Caps Lock",0x39], ["Print Screen",0x46], ["Scroll Lock",0x47], ["Pause",0x48],
      ["Insert",0x49], ["Home",0x4A], ["Page Up",0x4B], ["Delete",0x4C], ["End",0x4D], ["Page Down",0x4E],
      ["Right Arrow",0x4F], ["Left Arrow",0x50], ["Down Arrow",0x51], ["Up Arrow",0x52],
      ["F1",0x3A], ["F2",0x3B], ["F3",0x3C], ["F4",0x3D], ["F5",0x3E], ["F6",0x3F],
      ["F7",0x40], ["F8",0x41], ["F9",0x42], ["F10",0x43], ["F11",0x44], ["F12",0x45]
    ];
    ctrls.forEach(([l, c]) => add(l, "keyboard", 0x00, c));

    // 5. 小键盘数字区 -> 标签使用纯数字 "0" 等，与主键盘 ")0" 区分
    const keypad = [
      ["Num Lock",0x53], ["Num /",0x54], ["Num *",0x55], ["Num -",0x56], ["Num +",0x57], ["Num Enter",0x58],
      ["1",0x59], ["2",0x5A], ["3",0x5B], ["4",0x5C], ["5",0x5D],
      ["6",0x5E], ["7",0x5F], ["8",0x60], ["9",0x61], ["0",0x62], ["Num .",0x63]
    ];
    keypad.forEach(([l, c]) => add(l, "keyboard", 0x00, c));

    // 6. 修饰键 (Type: modifier)
    add("Left Ctrl", "modifier", 0x00, 0x01);
    add("Left Shift", "modifier", 0x00, 0x02);
    add("Left Alt", "modifier", 0x00, 0x04);
    add("Left Win", "modifier", 0x00, 0x08);
    add("Right Ctrl", "modifier", 0x00, 0x10);
    add("Right Shift", "modifier", 0x00, 0x20);
    add("Right Alt", "modifier", 0x00, 0x40);
    add("Right Win", "modifier", 0x00, 0x80);

    // 7. 多媒体 (Type: system)
    add("音量+", "system", 0x00, 0xE9);
    add("音量-", "system", 0x00, 0xEA);
    add("静音", "system", 0x00, 0xE2);
    add("播放/暂停", "system", 0x00, 0xCD);
    add("上一曲", "system", 0x00, 0xB6);
    add("下一曲", "system", 0x00, 0xB5);
    add("停止", "system", 0x00, 0xB7);
    add("计算器", "system", 0x00, 0x192);
    add("我的电脑", "system", 0x00, 0x194);
    add("浏览器", "system", 0x00, 0x196);
    add("邮件", "system", 0x00, 0x18A);

    return Object.freeze(actions);
  })();

  // ============================================================
  // 8) CommandPlanner
  // ============================================================
  class CommandPlanner {
    constructor(profile) { this.profile = profile || DEFAULT_PROFILE; }

    plan(prevState, payload) {
      const patch = normalizePayload(payload);
      const nextState = { ...prevState, ...patch }; // 简化合并

      // [保持原有的 DPI 触发逻辑]
      if ("dpiSlots" in patch || "currentSlotCount" in patch || "currentDpiIndex" in patch) {
        patch.dpiProfile = true;
      }

      // 高级参数聚合触发逻辑
      // 当 patch 中包含任意高级参数时，触发 advParams 的全量写入
      const ADV_KEYS = ["debounceMs", "motionSync", "sleepSeconds", "linearCorrection", "rippleControl"];
      if (ADV_KEYS.some(k => k in patch)) {
        patch.advParams = true;
      }

      const commands = [];
      
      // 遍历 Patch
      for (const key of Object.keys(patch)) {
        const item = SPEC[key];
        if (!item) continue;

        if (item.plan) {
           const seq = item.plan(patch, nextState, { profile: this.profile });
           commands.push(...seq);
        } else if (item.encode) {
           const res = item.encode(patch[key], nextState);
           if (res) {
             const hex = ProtocolCodec.write(res.addr, res.data);
             commands.push({ hex });
           }
        }
      }

      return { patch, nextState, commands };
    }
  }

  // ============================================================
  // 9) 对外 API
  // ============================================================
  const ProtocolApi = (window.ProtocolApi = window.ProtocolApi || {});

ProtocolApi.resolveMouseDisplayName = ProtocolApi.resolveMouseDisplayName || function (vendorId, productId, fallbackName) {
  const vid = Number(vendorId) >>> 0;
  if (vid === 0x373b) return "ATK Mouse";
  return fallbackName || `HID ${vid.toString(16)}:${(Number(productId)>>>0).toString(16)}`;
};


  ProtocolApi.ATK_HID = {
    filters: [
      { vendorId: 0x373b, usagePage: 0xff02, usage: 0x0002 },
    ],
  };

  class MouseMouseHidApi {
    constructor({ profile = DEFAULT_PROFILE } = {}) {
      this._profile = profile;
      this._planner = new CommandPlanner(profile);
      this._driver = new UniversalHidDriver();
      this._cfg = this._makeDefaultCfg();
      
      this._onConfigCbs = [];
      this._onBatteryCbs = [];
      this._onRawReportCbs = [];
      this._rawAttachedDevice = null;
      this._rawInputHandler = (e) => {
        try {
          const u8 = new Uint8Array(e.data.buffer.slice(0));
          const raw = { reportId: e.reportId, data: u8, hex: bytesToHex(u8) };
          for (const cb of this._onRawReportCbs) {
            try { cb(raw); } catch (_) {}
          }
        } catch (_) {}
      };

    }

    set device(d) {
      // 绑定底层驱动
      // 同时挂载 raw report 监听，供前端调试/日志使用
      try {
        if (this._rawAttachedDevice) {
          this._rawAttachedDevice.removeEventListener("inputreport", this._rawInputHandler);
        }
      } catch (_) {}
      this._driver.setDevice(d);
      try {
        if (this._driver.device) {
          this._driver.device.addEventListener("inputreport", this._rawInputHandler);
          this._rawAttachedDevice = this._driver.device;
        } else {
          this._rawAttachedDevice = null;
        }
      } catch (_) {
        this._rawAttachedDevice = null;
      }
    }
    get device() { return this._driver.device; }

    async requestDevice() {
      const filters = [
        { vendorId: 0x373b, usagePage: 0xff02, usage: 0x0002 },

      ];
      const devs = await navigator.hid.requestDevice({ filters });
      return devs[0] || null;
    }

    async open() {
      if (!this.device) throw new Error("No device");
      if (!this.device.opened) await this.device.open();
      // ATK 可能不需要 A5解锁指令，直接可用
    }

    async close() {
      try {
        if (this._rawAttachedDevice) {
          this._rawAttachedDevice.removeEventListener("inputreport", this._rawInputHandler);
        }
      } catch (_) {}
      this._rawAttachedDevice = null;
      if (this.device?.opened) await this.device.close();
    }

    onConfig(cb) { this._onConfigCbs.push(cb); }
    _emitConfig() { this._onConfigCbs.forEach(cb => cb(this._cfg)); }

    

    // 电量事件：供 app.js 订阅
    onBattery(cb) { this._onBatteryCbs.push(cb); }
    _emitBattery(bat) { this._onBatteryCbs.forEach(cb => cb(bat)); }

    // 原始包事件：供 app.js 订阅（调试用途）
    onRawReport(cb) { this._onRawReportCbs.push(cb); }

_makeDefaultCfg() {
  // ⚠️ ATK 后端暂未完善"读取配置"能力，为避免握手阶段因读配置失败导致无法进入主页，
  // 这里提供一份"稳定默认配置"作为兜底（后续补全读取能力后可再收敛）。
  return {
    // DPI
    dpiSlots: [400, 800, 1600, 3200, 6400, 12800],
    // 默认颜色（对应 6 档）
    dpiColors: ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#00FFFF", "#FF00FF"],
    currentSlotCount: 4,
    currentDpiIndex: 1, // 0-based

    // Performance / Power
    pollingHz: 1000,
    lodHeight: "low",
    opticalEngineHeightMm: 1.0, // 默认 1.0mm
    debounceMs: 2,
    motionSync: false,
    sleepSeconds: 60,
    linearCorrection: false,
    rippleControl: false,
    sensorAngle: 0,

    // 预留
    performanceMode: "low", // 默认 low 模式

    // 默认按键映射（对应 UI 的 1-6 号键）
    buttonMappings: [
      { funckey: 0x01, keycode: 0 }, // 左键
      { funckey: 0x02, keycode: 0 }, // 右键
      { funckey: 0x04, keycode: 0 }, // 中键
      { funckey: 0x10, keycode: 0 }, // 前进 (UI位4 -> 对应功能 0x10)
      { funckey: 0x08, keycode: 0 }, // 后退 (UI位5 -> 对应功能 0x08)
      { funckey: 0x00, keycode: 0x03 } // DPI循环
    ],

    // 默认值
    longRangeMode: false,      // 默认关闭
    dpiLightEffect: 1,         // 默认常亮
    receiverLightEffect: 1,    // 默认回报率模式
  };
}

    /**
     * 读取设备配置 (Snapshot)
     * 发送 Read 指令 -> 等待 Input Report
     */
        async requestConfig() {
      if (!this.device?.opened) await this.open();
      if (!this._cfg || typeof this._cfg !== "object") this._cfg = {};

      // ATK：电量通常依赖状态广播，这里先上报未知，避免 UI 卡住
      try { this._emitBattery({ batteryPercent: -1 }); } catch {}

      // 读取寄存器：连续读取间增加 20ms 微延迟，降低固件/链路抖动导致的单点失败概率
      const readReg = (() => {
        let first = true;
        return async (addr, len) => {
          if (!first) await sleep(20);
          first = false;

          const hex = ProtocolCodec.read(addr, len);
          const resp = await this._driver.sendAndWaitForInput({
            hex,
            matchFn: (e) => {
              try {
                if (e?.reportId != null && e.reportId !== 0x08) return false;
                const dv = e.data; // DataView
                const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
                // 允许 07 或 08：部分固件读取某些地址会回 07
                return (u8[0] === 0x08 || u8[0] === 0x07) &&
                  u8[2] === ((addr >> 8) & 0xff) &&
                  u8[3] === (addr & 0xff);
              } catch (_) {
                return false;
              }
            }
          });
          const parsed = ProtocolCodec.parse(resp);
          return parsed.data;
        };
      })();

      const snapshot = {};
      let slotCount = null;
      let curIdx = null;

      // 1) System Config (0x0000)
      try {
        const sysData = await readReg(REGS.SYS_CONFIG, 6);

        const pollingVal = sysData[0]; // Byte 0
        slotCount = sysData[2];
        curIdx = sysData[4];

        const pollingMap = {
          0x08: 125, 0x04: 250, 0x02: 500, 0x01: 1000,
          0x10: 2000, 0x20: 4000, 0x40: 8000
        };
        const pollingHz = pollingMap[pollingVal] || 1000;

        snapshot.pollingHz = pollingHz;
        snapshot.currentSlotCount = clampInt(slotCount, 1, this._profile?.capabilities?.dpiSlotMax ?? 6);
        snapshot.currentDpiIndex = clampInt(curIdx, 0, Math.max(0, (snapshot.currentSlotCount ?? 1) - 1));
      } catch (e) {
        console.warn("[ATK] 读取 SYS_CONFIG 失败", e);
      }

      // 2) LOD / Optical Height (0x000A)
      try {
        const lodData = await readReg(REGS.LOD, 2);
        const lodCode = lodData[0];

        const opticalEngineLevel = lodCode;
        const mm = (lodCode + 6) / 10;

        snapshot.opticalEngineLevel = opticalEngineLevel;
        snapshot.opticalEngineHeightMm = mm;
        snapshot.lodHeight = mm < 1.0 ? "low" : "high";
      } catch (e) {
        console.warn("[ATK] 读取 LOD 失败", e);
      }

      // 3) 性能模式 (0x00B9)
      try {
        const perfData = await readReg(0x00B9, 2);
        const perfVal = perfData[0];
        snapshot.performanceMode = (perfVal === 2) ? "oc" : (perfVal === 1 ? "hp" : "low");
      } catch (e) {
        console.warn("[ATK] 读取 performanceMode 失败", e);
      }

      // 4) Advanced Params (0x00A9)
      try {
        const advBuf = await readReg(REGS.ADV_PARAMS, 10);
        Object.assign(snapshot, TRANSFORMERS.decodeAdvParams(advBuf));
      } catch (e) {
        console.warn("[ATK] 读取 ADV_PARAMS 失败", e);
      }

      // 5) Sensor Angle (0x00BD)
      try {
        const angleBuf = await readReg(REGS.ANGLE, 4);
        Object.assign(snapshot, TRANSFORMERS.decodeSensorAngle(angleBuf));
      } catch (e) {
        console.warn("[ATK] 读取 ANGLE 失败", e);
      }

      
// 6) DPI Slots
try {
  const cap = this._profile?.capabilities ?? {};
  const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, cap.dpiSlotMax ?? 6);
  const count = clampInt(
    slotCount ?? snapshot.currentSlotCount ?? this._cfg?.currentSlotCount ?? 4,
    1,
    maxSlots
  );

  // 仅读取“当前启用”的挡位数量，追求极速；其余槽位用本地缓存/预设补齐
  const readVals = [];
  for (let i = 0; i < count; i++) {
    try {
      const addr = REGS.DPI_BASE + (i * 4);
      const dpiBuf = await readReg(addr, 4);
      readVals.push(TRANSFORMERS.decodeDpiWord(dpiBuf));
    } catch (e) {
      console.warn(`[ATK] 读取第 ${i + 1} 档 DPI 失败`, e);
      readVals.push(this._cfg?.dpiSlots?.[i] ?? DPI_PRESETS[i] ?? 800);
    }
  }

  const prevSlots = Array.isArray(this._cfg?.dpiSlots) ? this._cfg.dpiSlots.slice(0, maxSlots) : [];
  const dpiSlots = [];
  for (let i = 0; i < maxSlots; i++) {
    if (i < readVals.length) dpiSlots.push(readVals[i]);
    else dpiSlots.push(prevSlots[i] ?? DPI_PRESETS[i] ?? 800);
  }

  snapshot.dpiSlots = dpiSlots;

  const safeIdx = clampInt(
    snapshot.currentDpiIndex ?? this._cfg?.currentDpiIndex ?? 0,
    0,
    Math.max(0, count - 1)
  );
  snapshot.currentDpiIndex = safeIdx;
  snapshot.currentDpi = dpiSlots[safeIdx] ?? null;
} catch (e) {
  console.warn("[ATK] 读取 DPI Slots 失败", e);
}

      // 6.5) DPI 颜色 (0x002C 开始, 双槽位打包)
      try {
        const dpiColors = [];
        const maxSlots = this._profile?.capabilities?.dpiSlotMax ?? 6;

        for (let i = 0; i < maxSlots; i += 2) {
          try {
            const offset = (i / 2) * 8;
            const addr = REGS.DPI_COLOR_BASE + offset;
            const buf = await readReg(addr, 8);

            if (buf.length >= 4) dpiColors[i] = TRANSFORMERS.decodeRgb(buf.slice(0, 4));
            if (buf.length >= 8) dpiColors[i + 1] = TRANSFORMERS.decodeRgb(buf.slice(4, 8));
          } catch (e) {
            console.warn(`[ATK] 读取 DPI Color block ${i / 2} 失败`, e);
            dpiColors[i] = this._cfg?.dpiColors?.[i] || "#FF0000";
            dpiColors[i + 1] = this._cfg?.dpiColors?.[i + 1] || "#00FF00";
          }
        }
        snapshot.dpiColors = dpiColors;
      } catch (e) {
        console.warn("[ATK] 读取 DPI Colors 失败", e);
      }

      // 7) 按键映射
      try {
        const buttonMappings = [];
        // UI 3(前进) -> Dev 4, UI 4(后退) -> Dev 3
        const devIndexMap = [0, 1, 2, 4, 3, 5];

        for (let i = 0; i < 6; i++) {
          try {
            const devIdx = devIndexMap[i];

            const addrAction4 = REGS.KEYMAP_BASE + (devIdx * 4);
            const actData = await readReg(addrAction4, 4);

            const type = actData[0];
            const val = actData[1];

            let funckey = 0;
            let keycode = 0;

            if (type === 0x01) {
              funckey = val;
            } else if (type === 0x05) {
              const addrKeySeq = REGS.KEYSEQ_BASE + (devIdx * 32);
              const ksData = await readReg(addrKeySeq, 10);
              keycode = ksData[2];
              funckey = 0xff;
            }

            buttonMappings.push({ funckey, keycode });
          } catch (e) {
            console.warn(`[ATK] 读取按键 ${i + 1} 失败`, e);
            buttonMappings.push(this._cfg?.buttonMappings?.[i] || { funckey: 0, keycode: 0 });
          }
        }

        snapshot.buttonMappings = buttonMappings;
      } catch (e) {
        console.warn("[ATK] 读取按键映射失败", e);
      }

      // 8) DPI 灯效 (0x004C, LEN=8)
      try {
        const ledBuf = await readReg(REGS.DPI_LED, 8);
        let dpiLightEffect = 1;

        if (ledBuf && ledBuf.length >= 7) {
          dpiLightEffect = (ledBuf[6] === 0x00) ? 0 : ledBuf[0];
        }

        snapshot.dpiLightEffect = dpiLightEffect;
      } catch (e) {
        console.warn("[ATK] 读取 DPI LED 失败", e);
      }

      // 9) 超远距离状态：Control OP 0x17
      try {
        const hex = ProtocolCodec.control(0x17, new Uint8Array(0));
        const resp = await this._driver.sendAndWaitForInput({
          hex,
          matchFn: (e) => {
            try {
              if (e?.reportId != null && e.reportId !== 0x08) return false;
              const dv = e.data;
              const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
              return u8[0] === 0x17;
            } catch (_) { return false; }
          }
        });
        const parsed = ProtocolCodec.parse(resp);
        if (parsed?.data?.length) snapshot.longRangeMode = (parsed.data[0] === 1);
      } catch (e) {
        console.warn("[ATK] 读取 LongRange 失败 (OP 0x17)", e);
      }

      // 10) 接收器灯效模式：Control OP 0x15
      try {
        const hex = ProtocolCodec.control(0x15, new Uint8Array(0));
        const resp = await this._driver.sendAndWaitForInput({
          hex,
          matchFn: (e) => {
            try {
              if (e?.reportId != null && e.reportId !== 0x08) return false;
              const dv = e.data;
              const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
              return u8[0] === 0x15;
            } catch (_) { return false; }
          }
        });
        const parsed = ProtocolCodec.parse(resp);
        if (parsed?.data?.length) snapshot.receiverLightEffect = parsed.data[0];
      } catch (e) {
        console.warn("[ATK] 读取 Receiver LED 失败", e);
      }

      // 合并并一次性回包：不再使用默认 cfg 兜底，避免“假配置”影响 UI
      this._cfg = { ...this._cfg, ...snapshot };

      try { this._emitConfig(); } catch (e) { console.warn("[ATK] _emitConfig failed", e); }
      return this._cfg;
    }

    /**
     * 设置按键映射（修正索引偏移 + 自动处理 KeySeq）
     * @param {number} btnIndex UI 索引 (1=Left, 4=Forward, 5=Back...)
     * @param {string} label 动作名称
     */
    async setButtonMappingBySelect(btnIndex, label) {
      if (!this.device?.opened) await this.open();
      
      const action = KEYMAP_ACTIONS[label];
      if (!action) return;

      // UI 索引与设备寄存器索引的映射关系
      // UI: 4(Forward) -> Dev: 4(Forward Register)
      // UI: 5(Back)    -> Dev: 3(Back Register)
      // 数组下标 3(UI Forward) -> 值 4
      // 数组下标 4(UI Back)    -> 值 3
      const devIndexMap = [0, 1, 2, 4, 3, 5]; 
      const rawIdx = btnIndex - 1;
      const devIdx = devIndexMap[rawIdx] !== undefined ? devIndexMap[rawIdx] : rawIdx;

      // Action4 地址
      const addrAction4 = REGS.KEYMAP_BASE + devIdx * 4;
      // KeySeq 地址
      const addrKeySeq = REGS.KEYSEQ_BASE + devIdx * 32;

      const cmds = [];

      if (action.type === "mouse") {
        // 纯鼠标映射：只写 Action4
        // 构造 Action4: [01, funckey, 00, ck]
        const w = TRANSFORMERS.action4Bytes({ type: 0x01, code: action.funckey });
        cmds.push({ hex: ProtocolCodec.write(addrAction4, w) });
      } else {
        // 键盘/多媒体：写 KeySeq + 绑定 Action4
        let tag = 0x81; // Keyboard
        if (action.type === "system") tag = 0x82; // Consumer
        if (action.type === "modifier") tag = 0x80; // Modifier
        const usage = action.keycode;

        // KeySeq Block (10B)
        const u8 = new Uint8Array(10).fill(0);
        u8[0] = 0x02;
        u8[1] = tag;
        u8[2] = usage;
        u8[4] = tag - 0x40; // Tag2
        u8[5] = usage;      // Usage2
        
        // Tail Algo
        const sum = (tag & 0x0F) + usage;
        u8[7] = (0x93 - 2 * sum) & 0xFF;

        // 1. 写 KeySeq
        cmds.push({ hex: ProtocolCodec.write(addrKeySeq, u8) });

        // 2. 写 Action4 绑定 (Type 0x05)
        const w = TRANSFORMERS.action4Bytes({ type: 0x05, code: 0x00 });
        cmds.push({ hex: ProtocolCodec.write(addrAction4, w) });
      }

      await this._driver.runSequence(cmds);
    }

async setBatchFeatures(payload) {
  if (!this.device?.opened) await this.open();

  const cap = this._profile?.capabilities ?? {};
  const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, cap.dpiSlotMax ?? 6);
  const dpiMin = clampInt(cap.dpiMin ?? 50, 1, 500);
  const dpiMax = clampInt(cap.dpiMax ?? 26000, 1000, 60000);

  // 0) 统一字段别名 + 防御性复制
  const externalPayload = normalizePayload(payload);

  // 1) 主动预设：挡位数变化时，自动补全 dpiSlots（避免 UI 闪烁到最小值）
  if (Object.prototype.hasOwnProperty.call(externalPayload, "currentSlotCount")) {
    const targetCount = clampInt(externalPayload.currentSlotCount, 1, maxSlots);
    externalPayload.currentSlotCount = targetCount;

    const baseSlots = Array.isArray(externalPayload.dpiSlots)
      ? externalPayload.dpiSlots
      : (Array.isArray(this._cfg?.dpiSlots) ? this._cfg.dpiSlots : []);

    externalPayload.dpiSlots = buildDpiSlotsWithPresets({
      slots: baseSlots,
      targetCount,
      maxSlots,
      dpiMin,
      dpiMax
    });

    // 同步 index：防止缩档后 index 越界
    const baseIdx = Object.prototype.hasOwnProperty.call(externalPayload, "currentDpiIndex")
      ? externalPayload.currentDpiIndex
      : (this._cfg?.currentDpiIndex ?? 0);

    externalPayload.currentDpiIndex = clampInt(baseIdx, 0, Math.max(0, targetCount - 1));
  } else if (Object.prototype.hasOwnProperty.call(externalPayload, "dpiSlots")) {
    // 仅改 DPI 数值时：也补齐到 maxSlots，避免数组长度抖动
    const baseSlots = Array.isArray(externalPayload.dpiSlots)
      ? externalPayload.dpiSlots
      : (Array.isArray(this._cfg?.dpiSlots) ? this._cfg.dpiSlots : []);

    const targetCount = clampInt(this._cfg?.currentSlotCount ?? 4, 1, maxSlots);
    externalPayload.dpiSlots = buildDpiSlotsWithPresets({
      slots: baseSlots,
      targetCount,
      maxSlots,
      dpiMin,
      dpiMax
    });
  }

  // 计算下一状态
  const { patch, nextState, commands } = this._planner.plan(this._cfg, externalPayload);

  // 2) 原子化写入：发送指令
  await this._driver.runSequence(commands);

  // 信任写入：直接使用 nextState 更新本地缓存，不再回读
  this._cfg = nextState;
  
  // 4) 立即触发 UI 更新
  this._emitConfig();
}

// 兼容 app.js：能力注入（仅 UI 渲染依据）
get capabilities() {
  const cap = this._profile?.capabilities || {};
  return {
    dpiSlotCount: cap.dpiSlotMax ?? 6,
    maxDpi: cap.dpiMax ?? 26000,
    pollingRates: Array.isArray(cap.pollingRates) ? cap.pollingRates : null,
  };
}

// 兼容 app.js：单项写入（支持别名 key）
async setFeature(key, value) {
  return this.setBatchFeatures({ [key]: value });
}

// 兼容 app.js：档位数
async setDpiSlotCount(n) {
  const cap = this._profile?.capabilities || {};
  const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, cap.dpiSlotMax ?? 6);
  const count = clampInt(Number(n), 1, maxSlots);
  return this.setBatchFeatures({ currentSlotCount: count });
}

async setSlotCount(n) {
  // 兼容旧接口命名
  return this.setDpiSlotCount(n);
}

async setPollingHz(hz) {
  return this.setBatchFeatures({ pollingHz: hz });
}

/**
 * 读取电量 (OpCode 0x04)
 * 发送: 04 00 ...
 * 接收: 04 02 [Level] 00 ...
 */
async requestBattery() {
  // 1. 状态检查：符合该类中 _requireDeviceOpen 的防御编程习惯
  if (!this.device?.opened) {
    try { await this.open(); } catch (e) { return null; }
  }

  try {
    // 2. 编码：利用 ProtocolCodec 自动生成带校验和的 16 字节帧
    const hex = ProtocolCodec.control(0x04);

    // 3. 传输：复用驱动层的"发-等"机制
    const resp = await this._driver.sendAndWaitForInput({
      hex,
      timeoutMs: 500, // 500ms 超时是该文件的标准做法
      matchFn: (e) => {
        try {
          if (e.reportId !== 0x08) return false;
          const dv = e.data;
          // 快速检查 OpCode 是否为 0x04
          const op = dv.getUint8(0);
          return op === 0x04;
        } catch (_) {
          return false;
        }
      }
    });

    // 4. 解码：利用 ProtocolCodec 校验回包完整性
    const parsed = ProtocolCodec.parse(resp);

    // 5. 业务提取：抓包结论表明 Data[0] 即为电量
    if (parsed.data && parsed.data.length > 0) {
      const battery = parsed.data[0];

      // 限制范围，防止硬件乱报导致 UI 异常 (Defensive Programming)
      const safeBat = Math.min(100, Math.max(0, battery));

      // 通知上层
      this._emitBattery({ batteryPercent: safeBat });

      // 兼容性 DOM 操作 (保留原有逻辑)
      try {
        const el = document.getElementById("hdrBatteryVal");
        if (el) el.textContent = safeBat + "%";
      } catch (_) {}

      return safeBat;
    }

  } catch (err) {
    // 符合现有的错误吞没策略，避免电量读取失败炸崩整个页面
    console.warn("[ATK] requestBattery failed:", err);
  }
  return null;
}

// 兼容旧接口命名
async getConfig() { return this.requestConfig(); }
    // 快捷 API
    async setDpi(slot, value, options = {}) {
      // 1. 更新本地缓存的 DPI 数组
      const slots = [...(this._cfg.dpiSlots || [])];
      slots[slot - 1] = value;
      const patch = { dpiSlots: slots };

      // 支持同时设置颜色
      if (options.color) {
        const colors = [...(this._cfg.dpiColors || [])];
        colors[slot - 1] = options.color;
        patch.dpiColors = colors;
      }

      // 只有当显式要求选中（如点击了档位行/选择按钮），
      // 或者当前修改的就是正在使用的档位时，才下发 index 切换指令
      if (options.select === true) {
        patch.currentDpiIndex = slot - 1;
      }

      // 3. 调用批量设置方法
      await this.setBatchFeatures(patch);
    }
  }

  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;

  // 注入辅助方法供 UI 使用
  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  ProtocolApi.listKeyActionsByType = () => {
    const groups = { mouse: [], keyboard: [], system: [] };
    for (const [k, v] of Object.entries(KEYMAP_ACTIONS)) {
      if (v.type === "mouse") groups.mouse.push(k);
      else if (v.type === "modifier") groups.keyboard.push(k);
      else if (v.type === "keyboard") groups.keyboard.push(k);
      else groups.system.push(k);
    }
    return [
      { type: "mouse", items: groups.mouse },
      { type: "keyboard", items: groups.keyboard },
      { type: "system", items: groups.system }
    ];
  };

  ProtocolApi.labelFromFunckeyKeycode = (funckey, keycode) => {
    for (const [k, v] of Object.entries(KEYMAP_ACTIONS)) {
      if (v.type === "mouse") {
        if (v.funckey === funckey) return k;
      } else {
        if (v.keycode === keycode) return k;
      }
    }
    return null;
  };
})();
