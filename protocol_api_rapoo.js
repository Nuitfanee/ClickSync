/* protocol_api.js
 * ============================================================
 * 目标：生产级、可系统化扩展、可维护性强的 WebHID 协议驱动实现
 * ============================================================
 *
 * 核心思想（请务必读完这段，后续扩展会非常顺手）：
 * 1) 业务层不应该拼报文、不应该关心寄存器地址/长度/等待/序列；
 * 2) 所有“协议知识”统一沉到 SPEC（规范表）+ Planner（计划器）+ Codec（编码器）；
 * 3) 新增功能时，通常只需要新增/修改一个 SPEC 条目（以及必要的 Transformer/Validator），
 *    业务层无需改动（或极小改动）。
 *
 * 本文件刻意避免：
 * - 旧式模板字符串（例如 a5a5... 硬拼的模板）
 * - 在业务逻辑里散落 if/else 特殊分支
 * - “抓包白名单序列”式的固化流程
 *
 * 现在的结构是：
 * - UniversalHidDriver：只负责“把命令送到设备”（传输层），不懂业务、不懂协议语义
 * - ProtocolCodec：统一生成 A5A5 写命令 / A5A4 读命令（编码层）
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
  // 0) 错误类型与基础工具函数
  //    - ProtocolError：统一错误格式（code + detail），便于上层展示与定位
  //    - 一些类型判断、数值裁剪、字节/HEX 转换工具
  // ============================================================
  class ProtocolError extends Error {
    constructor(message, code = "UNKNOWN", detail = null) {
      super(message);
      this.name = "ProtocolError";
      this.code = code;
      this.detail = detail;
    }
  }

  // 简单 sleep（用于命令间隔/等待固件应用）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 是否为“纯对象”
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // 断言可转成有限数
  function assertFiniteNumber(n, name) {
    const x = Number(n);
    if (!Number.isFinite(x)) throw new ProtocolError(`${name} 不是有效数字`, "BAD_PARAM", { name, value: n });
    return x;
  }

  // 裁剪整数到 [min, max]
  function clampInt(n, min, max) {
    const x = Math.trunc(Number(n));
    return Math.min(max, Math.max(min, x));
  }

  // 转成 u8（0..255）
  function toU8(n) {
    return clampInt(n, 0, 0xff);
  }

  // 转成 i8 的补码表示（-128..127 -> 0..255）
  function toI8(n) {
    const x = clampInt(n, -128, 127);
    return x < 0 ? (0x100 + x) : x;
  }

  // u16 little-endian（低字节在前）
  function u16leBytes(n) {
    const v = clampInt(n, 0, 0xffff);
    return [v & 0xff, (v >> 8) & 0xff];
  }

  // byte[] -> hex 字符串（不带空格）
  function bytesToHex(bytes) {
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : (Array.isArray(bytes) ? bytes : []);
    return arr.map((b) => toU8(b).toString(16).padStart(2, "0")).join("");
  }

  // hex 字符串 -> Uint8Array（容忍空格/分隔符，自动清理非 hex 字符）
  function hexToU8(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 !== 0) throw new ProtocolError(`HEX 长度非法: ${hex}`, "BAD_HEX");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  // ============================================================
  // 1) 传输层：UniversalHidDriver
  //    目标：只负责把命令写进 HID（sendReport / sendFeatureReport）
  //
  //    设计要点：
  //    - 不关心“命令是什么意义”，只关心“如何可靠写入”
  //    - 通过队列 SendQueue 串行化所有写入，避免并发写导致异常
  //    - 自动尝试不同 report 长度（不同浏览器/设备枚举时可能要求固定长度）
  //    - 支持命令间默认延迟（defaultInterCmdDelayMs）
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
    constructor() {
      this.device = null;
      this.queue = new SendQueue();

      // 单次发送超时（防止卡死）
      this.sendTimeoutMs = 1200;

      // 默认命令间隔（如果命令未指定 waitMs，则使用这个）
      this.defaultInterCmdDelayMs = 12;

      // 缓存：从 HID descriptor 推断某 rid 的“期望字节长度”
      this._reportLenCache = {
        output: new Map(),
        feature: new Map(),
      };
    }

    setDevice(device) {
      this.device = device || null;
      this._reportLenCache.output.clear();
      this._reportLenCache.feature.clear();
    }

    _requireDeviceOpen() {
      if (!this.device) throw new ProtocolError("设备未注入（hidApi.device 为空）", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("设备未打开（请先 open()）", "NOT_OPEN");
    }

    // 从 report items 推导该 report 的字节长度（尽量在不硬编码的情况下适配设备）
    _calcReportByteLengthFromItems(items) {
      try {
        if (!Array.isArray(items) || items.length === 0) return null;
        let maxBit = 0;
        for (const it of items) {
          const off = Number(it?.reportOffset ?? 0);
          const size = Number(it?.reportSize ?? 0);
          const cnt = Number(it?.reportCount ?? 0);
          if (!Number.isFinite(off) || !Number.isFinite(size) || !Number.isFinite(cnt)) continue;
          const end = off + size * cnt;
          if (end > maxBit) maxBit = end;
        }
        const bytes = Math.ceil(maxBit / 8);
        return bytes > 0 ? bytes : null;
      } catch {
        return null;
      }
    }

    // 获取指定 reportId 在 output/feature 下推断的长度（可能为 null）
    _getReportLen(reportType, reportId) {
      const rid = Number(reportId);
      const bucket = reportType === "feature" ? this._reportLenCache.feature : this._reportLenCache.output;
      if (bucket.has(rid)) return bucket.get(rid);

      let found = null;
      try {
        const collections = this.device?.collections || [];
        const key = reportType === "feature" ? "featureReports" : "outputReports";
        for (const col of collections) {
          const reports = col?.[key];
          if (!Array.isArray(reports)) continue;
          for (const r of reports) {
            if (Number(r?.reportId) !== rid) continue;
            const len = this._calcReportByteLengthFromItems(r?.items);
            if (len != null) {
              found = len;
              break;
            }
          }
          if (found != null) break;
        }
      } catch {
        // 忽略解析异常，继续 fallback
      }

      bucket.set(rid, found);
      return found;
    }

    // 将 payload 裁剪/填充到指定字节长度（不足补 0，超出截断）
    _fitToLen(u8, expectedLen) {
      if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8 || []);
      const n = Number(expectedLen);
      if (!Number.isFinite(n) || n <= 0) return u8;
      if (u8.byteLength === n) return u8;
      const out = new Uint8Array(n);
      out.set(u8.subarray(0, n));
      return out;
    }

    // -------------------------
    // 低层 I/O：单次写入（不入队，供队列任务内部复用）
    // -------------------------
    async _sendReportDirect(reportId, hex) {
      this._requireDeviceOpen();
      const raw = hexToU8(hex);
      const dev = this.device;

      // 带超时的 Promise 包装
      const runWithTimeout = async (p) => {
        await Promise.race([
          p,
          sleep(this.sendTimeoutMs).then(() => {
            throw new ProtocolError(`写入超时（${this.sendTimeoutMs}ms）`, "IO_TIMEOUT");
          }),
        ]);
      };

      // 构建候选 payload（不同长度尝试）
      const buildCandidates = (expectedLen) => {
        const cands = [];
        const seen = new Set();
        const pushLen = (n) => {
          const len = Number(n);
          if (!Number.isFinite(len) || len <= 0) return;
          if (seen.has(len)) return;
          seen.add(len);
          cands.push(this._fitToLen(raw, len));
        };

        // 先尝试原长度
        pushLen(raw.byteLength);

        // 再尝试根据 descriptor 推断的长度
        if (expectedLen && expectedLen !== raw.byteLength) pushLen(expectedLen);

        // 强制增加常用的 8、20 字节尝试，这通常能覆盖雷柏的所有指令
        // 优先尝试 8 和 20 字节（短指令和长指令/DPI表），然后尝试其他常见长度
        for (const n of [8, 20, 16, 32, 64, 128]) pushLen(n);

        return cands;
      };

      const rid = Number(reportId);
      const errors = [];

      // 1) 优先尝试 output report
      const expectedOutLen = this._getReportLen("output", rid);
      for (const payload of buildCandidates(expectedOutLen)) {
        try {
          await runWithTimeout(dev.sendReport(rid, payload));
          return;
        } catch (e) {
          errors.push(`sendReport(len=${payload.byteLength}): ${String(e?.message || e)}`);
        }
      }

      // 2) 再尝试 feature report
      const expectedFeatLen = this._getReportLen("feature", rid);
      for (const payload of buildCandidates(expectedFeatLen)) {
        try {
          await runWithTimeout(dev.sendFeatureReport(rid, payload));
          return;
        } catch (e) {
          errors.push(`sendFeatureReport(len=${payload.byteLength}): ${String(e?.message || e)}`);
        }
      }

      throw new ProtocolError(`写入失败: ${errors.join(" | ")}`, "IO_WRITE_FAIL");
    }

    // -------------------------
    // 低层 I/O：读取 Feature Report（不入队）
    // -------------------------
    async _receiveFeatureReportDirect(reportId) {
      this._requireDeviceOpen();
      const rid = Number(reportId);
      const dev = this.device;

      const runWithTimeout = async (p) => {
        return await Promise.race([
          p,
          sleep(this.sendTimeoutMs).then(() => {
            throw new ProtocolError(`读取超时（${this.sendTimeoutMs}ms）`, "IO_TIMEOUT");
          }),
        ]);
      };

      const dv = await runWithTimeout(dev.receiveFeatureReport(rid));
      if (!dv) return new Uint8Array(0);
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    }

    // -------------------------
    // 公共 API：写入（入队，保证串行）
    // -------------------------
    async sendHex(reportId, hex) {
      return this.queue.enqueue(() => this._sendReportDirect(Number(reportId), String(hex)));
    }

    // -------------------------
    // 公共 API：读取 Feature Report（入队，保证与写入同序列不被打断）
    // -------------------------
    async receiveFeatureReport(reportId) {
      return this.queue.enqueue(() => this._receiveFeatureReportDirect(Number(reportId)));
    }

    /**
     * 事务化读回：发送一条命令后，等待 waitMs，再读取指定 feature report。
     * - 用于 A5A4 读命令 -> FeatureReport(ID:8) 响应的稳定读回
     */
    async sendAndReceiveFeature({ rid, hex, featureRid = 8, waitMs = null }) {
      const w = waitMs != null ? Number(waitMs) : this.defaultInterCmdDelayMs;
      return this.queue.enqueue(async () => {
        await this._sendReportDirect(Number(rid), String(hex));
        if (w != null && w > 0) await sleep(w);
        return await this._receiveFeatureReportDirect(Number(featureRid));
      });
    }

    /**
     * 执行命令序列
     * seq: Array<{ rid:number, hex:string, waitMs?:number }>
     * - rid: HID report id
     * - hex: 已编码好的命令
     * - waitMs: 指定这条命令后等待多久；未指定则使用 defaultInterCmdDelayMs
     */
    async runSequence(seq) {
      if (!Array.isArray(seq) || seq.length === 0) return;
      for (const cmd of seq) {
        await this.sendHex(Number(cmd.rid), String(cmd.hex));
        const w = cmd.waitMs != null ? Number(cmd.waitMs) : this.defaultInterCmdDelayMs;
        if (w != null && w > 0) await sleep(w);
      }
    }
  }

  // ============================================================
  // 2) 编码层：ProtocolCodec
  //    目标：统一把 {bank, addr, dataBytes} 变成 A5A5... 的 hex 字符串
  //
  //    说明：
  //    - write: A5 A5 [len] [addr] [bank] 00 00 [data...]
  //    - read : A5 A4 [len] [addr] [bank]
  //
  //    重要：任何拼报文都必须经过这里（避免业务层硬编码协议格式）
  // ============================================================
  const ProtocolCodec = Object.freeze({
    /**
     * 生成写命令
     * @param {Object} args
     * @param {number} args.bank - bank 值（0..255）
     * @param {number} args.addr - addr 值（0..255）
     * @param {number[]|Uint8Array} args.dataBytes - 写入的数据字节
     * @param {number|null} args.lenOverride - 强制指定长度（可用于变长数据）
     */
    write({ bank, addr, dataBytes, lenOverride = null }) {
      const b = toU8(bank);
      const a = toU8(addr);

      const bytes = Array.isArray(dataBytes)
        ? dataBytes.map(toU8)
        : (dataBytes instanceof Uint8Array ? Array.from(dataBytes).map(toU8) : []);

      const len = lenOverride != null ? clampInt(lenOverride, 0, 255) : bytes.length;
      const head = [
        0xa5, 0xa5,
        toU8(len),
        a,
        b,
        0x00, 0x00,
      ];
      return bytesToHex(head.concat(bytes));
    },

    /**
     * 生成读命令（目前作为扩展预留）
     * @param {Object} args
     * @param {number} args.bank
     * @param {number} args.addr
     * @param {number} args.len - 读取长度（默认 1）
     */
    read({ bank, addr, len = 0x01 }) {
      const b = toU8(bank);
      const a = toU8(addr);
      const l = toU8(len);
      // 由原本的 5 字节修改为 8 字节（后三位补 0）
      return bytesToHex([0xa5, 0xa4, l, a, b, 0x00, 0x00, 0x00]);
    },
  });

  // ============================================================
  // 3) Profile：设备能力与差异
  //    目标：让“能力与限制”集中管理，支持未来多机型/多固件差异
  //
  //    为什么要 Profile？
  //    - 有的机型不支持 8000Hz
  //    - 有的机型某些 polling 下不支持某些 performance mode
  //    - 有的机型 DPI slot 数量不同、DPI 范围不同
  //
  //    未来扩展：只需要新增 profile 并覆盖 capabilities/timings
  // ============================================================
  const DEFAULT_PROFILE = Object.freeze({
    id: "default",
    capabilities: Object.freeze({
      dpiSlotMax: 6,
      dpiMin: 50,
      dpiMax: 26000,
      pollingRates: Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]),
      performanceModes: Object.freeze(["low", "hp", "sport", "oc"]),
      // 明确声明每个 polling 下允许的 performanceMode（防止无效下发）
      perfModesByPolling: Object.freeze({
        125: Object.freeze(["low"]),
        250: Object.freeze(["low"]),
        500: Object.freeze(["low", "hp"]),
        1000: Object.freeze(["low", "hp", "sport", "oc"]),
        2000: Object.freeze(["hp", "sport", "oc"]),
        4000: Object.freeze(["sport", "oc"]),
        8000: Object.freeze(["sport", "oc"]),
      }),
    }),

    timings: Object.freeze({
      // 命令间隔（对固件更友好，减少丢包/状态未应用）
      interCmdDelayMs: 12,
      // DPI 表双写之间等待（固件可能需要时间处理第一段）
      dpiTableSecondWriteWaitMs: 12,
      // 写 slotCount / index 之后等待（避免 UI 立即读/写导致竞争）
      slotCountRefreshWaitMs: 11,
    }),
  });

  // ============================================================
  // 4) 字段命名适配：normalizePayload
  //    目标：前后端/历史字段名不一致时，在这里一次性“归一化”
  //
  //    规则：
  //    - 外部 payload 可能是 snake_case，也可能是 camelCase
  //    - normalizePayload 输出内部统一 key（camelCase）
  //
  //    注意：协议层不要处理字段别名，否则会污染协议语义层
  // ============================================================
  const KEY_ALIASES = Object.freeze({
    polling_rate: "pollingHz",
    pollingHz: "pollingHz",

    keyScanningRate: "keyScanningRate",
    key_scanning_rate: "keyScanningRate",

    performanceMode: "performanceMode",
    performance_mode: "performanceMode",

    lodHeight: "lodHeight",
    lod_height: "lodHeight",

    opticalEngineHeightMm: "opticalEngineHeightMm",
    optical_engine_height_mm: "opticalEngineHeightMm",

    opticalEngineLevel: "opticalEngineLevel",
    optical_engine_level: "opticalEngineLevel",

    rippleControl: "rippleControl",
    ripple_control: "rippleControl",

    glassMode: "glassMode",
    glass_mode: "glassMode",

    sensorAngle: "sensorAngle",
    sensor_angle: "sensorAngle",

    debounce_ms: "debounceMs",
    debounceMs: "debounceMs",

    // 休眠时间（UI 传秒；设备写入单位分钟）
    sleepSeconds: "sleepSeconds",
    sleep_seconds: "sleepSeconds",
    sleepTime: "sleepSeconds",
    sleep_time: "sleepSeconds",
    // 兼容历史字段（部分旧 UI/固件工具使用 sleepTimeout 命名）
    sleepTimeout: "sleepSeconds",
    sleep_timeout: "sleepSeconds",

    motionSync: "motionSync",
    motion_sync: "motionSync",

    linearCorrection: "linearCorrection",
    linear_correction: "linearCorrection",

    currentSlotCount: "currentSlotCount",
    slot_count: "currentSlotCount",

    currentDpiIndex: "currentDpiIndex",
    dpi_index: "currentDpiIndex",

    dpiSlots: "dpiSlots",
    dpi_slots: "dpiSlots",

    // 虚拟字段：内部触发 DPI 计划（外部通常不用直接传）
    dpiProfile: "dpiProfile",

    wirelessStrategy: "wirelessStrategy",
    wireless_strategy: "wirelessStrategy",
    commProtocol: "commProtocol",
    comm_protocol: "commProtocol",
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
  // 5) 转换器 TRANSFORMERS
  //    目标：把 UI/语义值变成协议要求的数值/字节数组
  //
  //    注意：
  //    - 这里不做“发送”，只做转换
  //    - validate 放在 SPEC 内部（因为 validate 往往要结合 profile/nextState）
  // ============================================================
  const TRANSFORMERS = Object.freeze({
    // boolean -> u8
    boolU8(v) {
      return v ? 0x01 : 0x00;
    },

    // pollingHz（语义） -> 协议码（u8）
    pollingHzCode(hz) {
      const n = clampInt(assertFiniteNumber(hz, "pollingHz"), 1, 8000);
      const map = new Map([
        [125, 0x08],
        [250, 0x04],
        [500, 0x02],
        [1000, 0x01],
        [2000, 0x84],
        [4000, 0x82],
        [8000, 0x81],
      ]);
      return map.get(n) ?? 0x01;
    },

    // 按键扫描率编码：将频率值转换为协议码
    // 映射关系：1k->3, 2k->4, 4k->5, 8k->6
    keyScanningRateCode(hz) {
      const n = clampInt(assertFiniteNumber(hz, "keyScanningRate"), 1000, 8000);
      const map = new Map([
        [1000, 0x03],
        [2000, 0x04],
        [4000, 0x05],
        [8000, 0x06],
      ]);
      return map.get(n) ?? 0x03;
    },

    // 光学引擎高度编码：将毫米值转换为寄存器编码值
    // 转换公式：(mm*10) - 6
    // 示例：0.7mm -> 1, 1.7mm -> 11
    opticalHeightByte(mm) {
      const v = Number(mm);
      if (!Number.isFinite(v)) return 0x04; // 默认 1.0mm (4)
      const val = Math.round(v * 10) - 6;
      return clampInt(val, 1, 11); // 限制在 0.7~1.7 范围内
    },

    // 光学引擎挡位编码：直接透传 1-11 的挡位数值
    opticalLevelByte(level) {
      const v = Number(level);
      return clampInt(v, 1, 11);
    },

    // LOD 枚举 -> 协议码
    lodHeightCode(v) {
      const s = String(v || "").toLowerCase();
      const map = { low: 0x01, mid: 0x03, high: 0x04 };
      return map[s] ?? 0x04;
    },

    // performanceMode 枚举 -> 协议码
    performanceModeCode(v) {
      const s = String(v || "").toLowerCase();
      const map = { low: 0x01, hp: 0x02, sport: 0x04, oc: 0x05 };
      return map[s] ?? 0x02;
    },

    // sensorAngle：-30..30 -> i8 补码
    sensorAngleI8(v) {
      const n = clampInt(assertFiniteNumber(v, "sensorAngle"), -30, 30);
      return toI8(n);
    },

    // debounce：0..255 -> u8
    debounceU8(v) {
      const n = clampInt(assertFiniteNumber(v, "debounceMs"), 0, 255);
      return toU8(n);
    },

    /**
     * 休眠时间：UI 传秒 -> 设备写入分钟（u8）
     * - 设备合法范围：2..120 min
     * - 步进：1 min
     * - UI 传秒，因此必须是 60 的整数倍（否则无法表达 1min 步进）
     */
    sleepMinutesFromSeconds(v) {
      const sec = assertFiniteNumber(v, "sleepSeconds");
      const s = Math.trunc(sec);
      if (s <= 0 || s !== sec) {
        throw new ProtocolError("sleepSeconds 必须是正整数（单位：秒）", "BAD_PARAM", { sleepSeconds: v });
      }
      if (s % 60 !== 0) {
        throw new ProtocolError("sleepSeconds 必须是 60 的整数倍（设备步进 1min）", "BAD_PARAM", { sleepSeconds: v });
      }
      const min = s / 60;
      if (min < 2 || min > 120) {
        throw new ProtocolError("sleepSeconds 超出范围（设备合法 2..120 分钟）", "BAD_PARAM", { sleepSeconds: v, minutes: min });
      }
      return toU8(min);
    },

    // slotCount（UI 1..6）-> 协议码（0..5）
    slotCountCode(v) {
      const n = clampInt(assertFiniteNumber(v, "currentSlotCount"), 1, 6);
      return toU8(n - 1);
    },

    // dpiIndex：根据 count 自动裁剪，保证不会越界
    dpiIndexU8(v, state) {
      const idx = clampInt(assertFiniteNumber(v, "currentDpiIndex"), 0, 255);
      const count = clampInt(Number(state?.currentSlotCount ?? 1), 1, 6);
      return toU8(Math.min(idx, count - 1));
    },

    // 0xC3 混合寄存器逻辑：MotionSync(Bit0) + LinearCorrection(Bit1)
    // Bit 0: MotionSync (0=On, 1=Off)
    // Bit 1: LinearCorrection (0=On, 1=Off)
    // 0x03=Off(11), 0x02=MotionOn(10), 0x01=LinearOn(01), 0x00=BothOn(00)
    motionLinearCombinedU8(state) {
      const m = !!state?.motionSync;
      const l = !!state?.linearCorrection;
      
      let val = 0;
      // MotionSync: On->0, Off->1 (Bit 0)
      val |= (m ? 0 : 1);
      // LinearCorrection: On->0, Off->1 (Bit 1)
      val |= ((l ? 0 : 1) << 1);
      
      return val; // 结果只会是 0, 1, 2, 3
    },

    /**
     * 按键映射：把 {funckey, keycode} 变成 4 字节 payload
     * 说明：
     * - 这里集中处理不同类型 action 的编码规则
     * - 上层可以传 label（先解析成 funckey/keycode），也可以直接传对象
     */
    keymapActionBytes(action) {
      const fk = toU8(action?.funckey ?? action?.func ?? 0);
      const kc = clampInt(Number(action?.keycode ?? action?.code ?? 0), 0, 0xffff);

      const hi = (kc >> 8) & 0xff;
      const lo = kc & 0xff;

      // 鼠标按键/无/禁用
      if (kc === 0 && [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x07].includes(fk)) {
        return [0x03, 0x00, fk, 0x00];
      }
      // 键盘键
      if (fk === 0x00) return [0x00, 0x00, lo, 0x00];
      // DPI 功能
      if (fk === 0x08) return [0x08, 0x00, lo, 0x00];
      // 多媒体/系统（16bit consumer key）
      if (fk === 0x04) return [0x04, 0x00, hi, lo];
      // 组合键
      if (fk === 0x02) return [0x02, hi, lo, 0x00];

      // 兜底：按通用格式写入
      return [fk, 0x00, hi, lo];
    },

    // 无线策略编码：smart -> 0x00, full -> 0x01
    wirelessStrategyCode(v) {
      const map = { smart: 0x00, full: 0x01 };
      return map[String(v).toLowerCase()] ?? 0x00;
    },

    // 通信协议编码：efficient -> 0x00, initial -> 0x02
    commProtocolCode(v) {
      const map = { efficient: 0x00, initial: 0x02 };
      return map[String(v).toLowerCase()] ?? 0x02;
    },

    /**
     * DPI 表：将 dpiSlots（语义）转换成 byte[]（u16le * count）
     * - count 为"有效挡位数"
     * - profile 决定 dpi 上下限与最大挡位数
     */
    dpiTableBytes(dpiSlots, count, profile) {
      const cap = profile?.capabilities || DEFAULT_PROFILE.capabilities;
      const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, 6);
      const c = clampInt(count, 1, maxSlots);

      const min = clampInt(cap.dpiMin ?? 50, 1, 26000);
      const max = clampInt(cap.dpiMax ?? 26000, min, 65535);

      const arr = Array.isArray(dpiSlots) ? dpiSlots.slice(0, c) : [];
      while (arr.length < c) arr.push(800);

      const out = [];
      for (const v of arr) {
        const val = clampInt(Number(v), min, max);
        out.push(...u16leBytes(val));
      }
      return out;
    },
  });

  // ============================================================
  // 5.1) 解码器 DECODERS（设备值 -> 语义值）
  // ============================================================
  const DECODERS = Object.freeze({
    // u8 -> boolean
    bool(v) {
      return Number(v) !== 0;
    },

    // u8 -> i8（补码）
    i8(v) {
      const n = toU8(v);
      return n >= 0x80 ? n - 0x100 : n;
    },

    // polling 协议码 -> Hz
    pollingHzFromCode(code) {
      const map = new Map([
        [0x08, 125],
        [0x04, 250],
        [0x02, 500],
        [0x01, 1000],
        [0x84, 2000],
        [0x82, 4000],
        [0x81, 8000],
      ]);
      return map.get(toU8(code)) ?? 1000;
    },

    // performance 协议码 -> 枚举
    performanceModeFromCode(code) {
      const map = new Map([
        [0x01, "low"],
        [0x02, "hp"],
        [0x04, "sport"],
        [0x05, "oc"],
      ]);
      return map.get(toU8(code)) ?? "hp";
    },

    // 按键扫描率解码：将协议码转换为频率值
    keyScanningRateFromCode(code) {
      const c = toU8(code);
      const map = new Map([
        [0x03, 1000],
        [0x04, 2000],
        [0x05, 4000],
        [0x06, 8000],
      ]);
      return map.get(c) ?? 1000;
    },

    // 光学引擎高度解码：将寄存器编码值转换为毫米值
    opticalHeightFromByte(code) {
      const c = toU8(code);
      // 转换公式：(val + 6) / 10
      return (c + 6) / 10;
    },

    // 光学引擎挡位解码：直接返回挡位数字
    opticalLevelFromByte(code) {
      return toU8(code);
    },

    // LOD 协议码 -> 枚举
    lodHeightFromCode(code) {
      const map = new Map([
        [0x01, "low"],
        [0x03, "mid"],
        [0x04, "high"],
      ]);
      return map.get(toU8(code)) ?? "high";
    },

    // slotCount 协议码（0..5）-> count（1..6）
    slotCountFromCode(code, maxSlots = 6) {
      const c = clampInt(Number(code) + 1, 1, maxSlots);
      return c;
    },

    // minutes(u8) -> seconds
    sleepSecondsFromMinutes(code) {
      const min = clampInt(Number(code), 0, 255);
      return min * 60;
    },

    // 无线策略解码：将协议码转换为策略枚举
    wirelessStrategyFromCode(code) {
      return Number(code) === 0x01 ? "full" : "smart";
    },

    // 通信协议解码：将协议码转换为协议类型枚举
    commProtocolFromCode(code) {
      return Number(code) === 0x00 ? "efficient" : "initial";
    },

    // 按键映射解码：将协议字节序列转换为 funckey 和 keycode
    keymapAction(bytes) {
      if (!bytes || bytes.length < 4) return { funckey: 0, keycode: 0 };
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const [b0, b1, b2, b3] = Array.from(u8.slice(0, 4));

      // 1. 鼠标按键 (Type 0x03) -> Value在 b2
      // 写入格式: [03, 00, fk, 00]
      if (b0 === 0x03) return { funckey: b2, keycode: 0 };

      // 2. 普通键盘 (Type 0x00) -> KeyCode在 b2
      // 写入格式: [00, 00, lo, 00]
      if (b0 === 0x00) return { funckey: 0, keycode: b2 };

      // 3. DPI 功能 (Type 0x08) -> Value在 b2
      // 写入格式: [08, 00, lo, 00]
      if (b0 === 0x08) return { funckey: 0x08, keycode: b2 };

      // 4. 多媒体/系统 (Type 0x04) -> KeyCode在 b2(hi), b3(lo)
      // 写入格式: [04, 00, hi, lo]
      if (b0 === 0x04) return { funckey: 0x04, keycode: (b2 << 8) | b3 };

      // 5. 组合键 (Type 0x02) -> KeyCode在 b1(hi), b2(lo)
      // 写入格式: [02, hi, lo, 00]
      if (b0 === 0x02) return { funckey: 0x02, keycode: (b1 << 8) | b2 };

      // 6. 兜底/特殊功能 (如抓包中的 0x0A)
      // 写入格式: [fk, 00, hi, lo]
      return { funckey: b0, keycode: (b2 << 8) | b3 };
    },
  });

  // Feature Report (ID:8) - A5A4 读回响应解码
  // 响应示例：01 00 00 00 [VAL...] ...
  function decodeFeatureReadBytes(featureU8, expectedLen = 1) {
    const u8 = featureU8 instanceof Uint8Array ? featureU8 : new Uint8Array(featureU8 || []);
    const len = clampInt(Number(expectedLen ?? 1), 0, 255);
    if (u8.byteLength < 4 + len) {
      throw new ProtocolError("FeatureReport(ID:8) 长度不足，无法解码", "IO_READ_FAIL", {
        got: u8.byteLength,
        need: 4 + len,
        hex: bytesToHex(u8),
      });
    }
    return u8.subarray(4, 4 + len);
  }

  function decodeU16leArray(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const out = [];
    for (let i = 0; i + 1 < u8.length; i += 2) {
      out.push(u8[i] | (u8[i + 1] << 8));
    }
    return out;
  }

  // ============================================================
  // 6) 资源定位：bank 与 addr（集中管理）
  //    注意：地址仍然属于“协议知识”，所以集中定义，避免散落
  // ============================================================
  const BANKS = Object.freeze({
    // 0x00：通信协议寄存器（Communication Protocol）
    COMM: 0x00,
    SYSTEM: 0x08,
    BUTTON: 0x06,
  });

  const ADDR = Object.freeze({
    pollingHz: 0x80,
    keyScanningRate: 0x81, // 按键扫描率
    lodHeight: 0x84,
    // 0x0885：Ripple Control（独立寄存器）
    rippleControl: 0x85,
    sensorAngle: 0xc4,
    glassMode: 0xc5,
    // LED低电量提示 (0xD8)
    ledLowBattery: 0xd8,
    // 无线策略地址 (Bank 0x08, Addr 0xD8)
    wirelessStrategy: 0xd8,
    debounceMs: 0xc0,
    liftDelayMs: 0xc1,     // 抬起延迟
    // 0x08C3：MotionSync(Bit0) + LinearCorrection(Bit1) 组合寄存器
    motionAndLinear: 0xc3,
    // 兼容性别名（保留，但实际使用 motionAndLinear）
    motionSync: 0xc3,
    linearCorrection: 0xc3,

    // 0x0060：通信协议地址（Communication Protocol）
    commProtocol: 0x60,

    // 休眠时间（bank=0x08, addr=0xC2），设备单位：分钟（2..120）
    sleepTime: 0xc2,

    dpiTableA: 0x88,
    dpiTableB: 0xc8,
    currentSlotCount: 0x96,
    currentDpiIndex: 0x98,
  });

  const WAIT_POLLING_SWITCH_MS = 120;

  // 根据 pollingHz 获取性能模式寄存器地址（动态地址）
  function perfAddrByPollingHz(hz) {
    const map = new Map([
      [125, 0xdc],
      [250, 0xdd],
      [500, 0xde],
      [1000, 0xdf],
      [2000, 0xe0],
      [4000, 0xe1],
      [8000, 0xe2],
    ]);
    return map.get(Number(hz)) ?? 0xdf;
  }

  // ============================================================
  // 7) 语义规范表：SPEC（最关键）
  //    你要“系统化扩展”基本就在这里做：
  //    - 新增功能 = 新增 spec 条目（并实现 validate/encode/plan）
  //    - 复杂功能（多条命令序列）= 用 plan() 返回 Command[]
  //    - 组合寄存器（多个字段映射到一个寄存器）= kind:'compound' + triggers + encode(nextState)
  //
  //    字段说明（约定）：
  //    - key: 规范项主键（内部统一字段名）
  //    - kind: direct / direct_dynamic / compound / virtual
  //    - priority: 下发顺序（小的先执行）
  //    - deps: 依赖字段（用于理解关系/未来做更严格拓扑排序）
  //    - triggers: patch 命中哪些字段时触发该 spec
  //    - validate(patch,nextState,profile): 参数与能力校验
  //    - encode(value,nextState,profile): 返回 {bank,addr,dataBytes,...}（单寄存器写）
  //    - plan(patch,nextState,ctx): 返回 Command[]（用于 DPI 双写等复杂序列）
  // ============================================================
  const SPEC = Object.freeze({
    pollingHz: {
      key: "pollingHz",
      kind: "direct",
      priority: 10,

      validate(patch, nextState, profile) {
        const hz = Number(nextState.pollingHz);
        const allowed = profile.capabilities.pollingRates || [];
        if (!allowed.includes(hz)) {
          throw new ProtocolError(`不支持的回报率: ${hz}Hz`, "FEATURE_UNSUPPORTED", { allowed, hz });
        }
      },

      plan(patch, nextState, ctx) {
        const prevHz = Number(ctx?.prevState?.pollingHz);
        const nextHz = Number(nextState.pollingHz);

        // polling 没变：不下发、不等待（避免无意义卡顿）
        if (Number.isFinite(prevHz) && prevHz === nextHz) return [];

        const pollingWriteHex = ProtocolCodec.write({
          bank: BANKS.SYSTEM,
          addr: ADDR.pollingHz,
          dataBytes: [TRANSFORMERS.pollingHzCode(nextHz)],
        });

        // 只保留写入指令，不进行回读
        return [{ rid: 6, hex: pollingWriteHex }];
      },

      // encode 可保留（plan 存在时通常不会走到这里）
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.pollingHz,
          dataBytes: [TRANSFORMERS.pollingHzCode(value)],
        };
      },
    },

    performanceMode: {
      key: "performanceMode",
      kind: "direct_dynamic",
      priority: 20,
      deps: ["pollingHz"],
      validate(patch, nextState, profile) {
        const hz = Number(nextState.pollingHz);
        const mode = String(nextState.performanceMode || "").toLowerCase();
        const allowed = profile.capabilities.perfModesByPolling?.[hz] || [];
        if (!allowed.includes(mode)) {
          throw new ProtocolError(
            `性能模式 ${mode} 不支持当前回报率 ${hz}Hz`,
            "FEATURE_UNSUPPORTED",
            { hz, mode, allowed }
          );
        }
      },

      plan(patch, nextState) {
        const hz = Number(nextState.pollingHz);
        const addr = perfAddrByPollingHz(hz);
        const modeCode = TRANSFORMERS.performanceModeCode(nextState.performanceMode);

        const writeHex = ProtocolCodec.write({
          bank: BANKS.SYSTEM,
          addr,
          dataBytes: [modeCode],
        });

        // 只保留写入指令，不进行回读
        return [{ rid: 6, hex: writeHex }];
      },

      encode(value, nextState) {
        const hz = Number(nextState.pollingHz ?? 1000);
        return {
          bank: BANKS.SYSTEM,
          addr: perfAddrByPollingHz(hz),
          dataBytes: [TRANSFORMERS.performanceModeCode(value)],
        };
      },
    },

    // 按键扫描率配置
    keyScanningRate: {
      key: "keyScanningRate",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.keyScanningRate, // 0x81
          dataBytes: [TRANSFORMERS.keyScanningRateCode(value)],
        };
      },
    },

    // 光学引擎高度配置（建议优先使用 opticalEngineHeightMm 字段）
    opticalEngineHeightMm: {
      key: "opticalEngineHeightMm",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.lodHeight, // 0x84
          dataBytes: [TRANSFORMERS.opticalHeightByte(value)],
        };
      },
    },

    // 光学引擎挡位配置：直接透传 1-11 的挡位数值
    opticalEngineLevel: {
      key: "opticalEngineLevel",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.lodHeight, // 地址 0x84 保持不变
          dataBytes: [TRANSFORMERS.opticalLevelByte(value)],
        };
      },
    },

    lodHeight: {
      key: "lodHeight",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.lodHeight,
          dataBytes: [TRANSFORMERS.lodHeightCode(value)],
        };
      },
    },

    // 0x0885：Ripple Control（独立寄存器）
    rippleControl: {
      key: "rippleControl",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.rippleControl, // 0x85
          dataBytes: [TRANSFORMERS.boolU8(!!value)],
        };
      },
    },

    // 0x08C3：Motion Sync (Bit 0)
    motionSync: {
      key: "motionSync",
      kind: "direct",
      priority: 50,
      // 依赖 linearCorrection 共同计算
      encode(value, nextState) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.motionAndLinear, // 0xC3
          dataBytes: [TRANSFORMERS.motionLinearCombinedU8(nextState)],
        };
      },
    },

    // 0x08C3：Linear Correction (Bit 1)
    linearCorrection: {
      key: "linearCorrection",
      kind: "direct",
      priority: 50,
      // 依赖 motionSync 共同计算
      encode(value, nextState) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.motionAndLinear, // 0xC3
          dataBytes: [TRANSFORMERS.motionLinearCombinedU8(nextState)],
        };
      },
    },

    glassMode: {
      key: "glassMode",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.glassMode,
          dataBytes: [TRANSFORMERS.boolU8(!!value)],
        };
      },
    },

    // LED低电量提示配置
    // 协议格式示例：
    // Write: A5 A5 04 D8 08 00 00 [01 01 00 0F] (On)
    // Write: A5 A5 04 D8 08 00 00 [01 00 00 FF] (Off)
    ledLowBattery: {
      key: "ledLowBattery",
      kind: "direct",
      priority: 50,
      encode(value) {
        const on = !!value;
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.ledLowBattery, // 0xD8
          dataBytes: [0x01, on ? 0x01 : 0x00, 0x00, on ? 0x0f : 0xff],
        };
      },
    },

    // 无线策略配置
    wirelessStrategy: {
      key: "wirelessStrategy",
      kind: "direct",
      priority: 50,
      encode(value) {
        return {
          bank: BANKS.SYSTEM, // 0x08
          addr: ADDR.wirelessStrategy, // 0xD8
          dataBytes: [TRANSFORMERS.wirelessStrategyCode(value)],
        };
      },
    },

    // 通信协议配置
    commProtocol: {
      key: "commProtocol",
      kind: "direct",
      priority: 10, // 优先级较高，建议先下发或单独下发
      encode(value) {
        return {
          bank: BANKS.COMM, // 0x00
          addr: ADDR.commProtocol, // 0x60
          dataBytes: [TRANSFORMERS.commProtocolCode(value)],
        };
      },
    },

    sensorAngle: {
      key: "sensorAngle",
      kind: "direct",
      priority: 50,
      validate(patch, nextState) {
        const a = Number(nextState.sensorAngle);
        if (!Number.isFinite(a) || a < -30 || a > 30) {
          throw new ProtocolError("sensorAngle 超出范围（-30..30）", "BAD_PARAM", { sensorAngle: nextState.sensorAngle });
        }
      },
      encode(value) {
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.sensorAngle,
          dataBytes: [TRANSFORMERS.sensorAngleI8(value)],
        };
      },
    },

    debounceMs: {
      key: "debounceMs",
      kind: "virtual", // 关键修改：改为虚拟类型以支持多命令计划
      priority: 50,
      triggers: ["debounceMs"], // 明确触发源

      plan(patch, nextState, ctx) {
        const val = nextState.debounceMs;
        const valByte = TRANSFORMERS.debounceU8(val);
        const { timings } = ctx.profile;

        // 构造两条写指令
        const writePress = ProtocolCodec.write({
          bank: BANKS.SYSTEM,
          addr: ADDR.debounceMs,
          dataBytes: [valByte],
        });

        const writeLift = ProtocolCodec.write({
          bank: BANKS.SYSTEM,
          addr: ADDR.liftDelayMs, // 写入 0xC1
          dataBytes: [valByte],
        });

        // 返回指令序列，由 Planner 统一调度执行
        return [
          { rid: 6, hex: writePress },
          { rid: 6, hex: writeLift, waitMs: timings.interCmdDelayMs } 
        ];
      },
    },

    // 休眠时间：UI 传秒；设备写入分钟（bank=0x08 addr=0xC2）
    sleepSeconds: {
      key: "sleepSeconds",
      kind: "direct",
      priority: 55,
      validate(patch, nextState) {
        // validate 里做严格校验（不静默裁剪），以便 UI 明确提示错误
        TRANSFORMERS.sleepMinutesFromSeconds(nextState.sleepSeconds);
      },
      encode(value) {
        const minU8 = TRANSFORMERS.sleepMinutesFromSeconds(value);
        return {
          bank: BANKS.SYSTEM,
          addr: ADDR.sleepTime,
          dataBytes: [minU8],
        };
      },
    },

    // 虚拟项：DPI 配置（双写 + count/index 联动）
    dpiProfile: {
      key: "dpiProfile",
      kind: "virtual",
      priority: 30,
      deps: ["dpiSlots", "currentSlotCount", "currentDpiIndex"],
      triggers: ["dpiSlots", "currentSlotCount", "currentDpiIndex"],

      validate(patch, nextState, profile) {
        const cap = profile.capabilities;
        const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, 6);

        const count = clampInt(Number(nextState.currentSlotCount ?? 1), 1, maxSlots);
        const idx = clampInt(Number(nextState.currentDpiIndex ?? 0), 0, maxSlots - 1);

        if (idx > count - 1) {
          throw new ProtocolError("currentDpiIndex 必须 < currentSlotCount", "BAD_PARAM", { idx, count });
        }

        const slots = Array.isArray(nextState.dpiSlots) ? nextState.dpiSlots : [];
        for (const [i, v] of slots.entries()) {
          if (i >= count) break;
          const n = Number(v);
          if (!Number.isFinite(n)) throw new ProtocolError("dpiSlots 中存在非法数字", "BAD_PARAM", { index: i, value: v });
          if (n < cap.dpiMin || n > cap.dpiMax) {
            throw new ProtocolError("dpiSlots 值超出范围", "BAD_PARAM", { index: i, value: n, min: cap.dpiMin, max: cap.dpiMax });
          }
        }
      },

      /**
       * DPI 的下发计划（最典型的“复杂序列”）
       * - 写 DPI 表 A（变长）
       * - 写 DPI 表 B（变长，等待）
       * - 写 slotCount（必要时）
       * - 写 index（必要时）
       *
       * 这样业务层永远不需要知道“双写/等待/变长/联动”的细节
       */
      plan(patch, nextState, ctx) {
        const { profile } = ctx;
        const t = profile.timings;

        const count = clampInt(Number(nextState.currentSlotCount ?? 1), 1, profile.capabilities.dpiSlotMax);
        const idx = clampInt(Number(nextState.currentDpiIndex ?? 0), 0, count - 1);
        const slots = Array.isArray(nextState.dpiSlots) ? nextState.dpiSlots : [];

        const tableBytes = TRANSFORMERS.dpiTableBytes(slots, count, profile);
        const lenOverride = tableBytes.length; // 变长：count * 2

        const commands = [];

        // 1) 写 DPI 表（必须双写）
        const wA = ProtocolCodec.write({ bank: BANKS.SYSTEM, addr: ADDR.dpiTableA, dataBytes: tableBytes, lenOverride });
        const wB = ProtocolCodec.write({ bank: BANKS.SYSTEM, addr: ADDR.dpiTableB, dataBytes: tableBytes, lenOverride });
        commands.push({ rid: 6, hex: wA });
        commands.push({ rid: 6, hex: wB, waitMs: t.dpiTableSecondWriteWaitMs });

        // 2) 写挡位数：只有当 patch 改动涉及 slotCount/dpiSlots 时才写
        if ("currentSlotCount" in patch || "dpiSlots" in patch || "dpiProfile" in patch) {
          const countCode = TRANSFORMERS.slotCountCode(count);
          const wCount = ProtocolCodec.write({ bank: BANKS.SYSTEM, addr: ADDR.currentSlotCount, dataBytes: [countCode] });
          // 这里 waitMs 使用统一节拍（如果没提供就 fallback 默认）
          commands.push({ rid: 6, hex: wCount, waitMs: t.defaultInterCmdDelayMs ?? 12 });
        }

        // 3) 写选中挡位 index：当 index/count 变动时写入，保证不会越界
        if ("currentDpiIndex" in patch || "currentSlotCount" in patch || "dpiProfile" in patch) {
          const idxByte = TRANSFORMERS.dpiIndexU8(idx, { currentSlotCount: count });
          const wIdx = ProtocolCodec.write({ bank: BANKS.SYSTEM, addr: ADDR.currentDpiIndex, dataBytes: [idxByte] });
          commands.push({ rid: 6, hex: wIdx, waitMs: t.slotCountRefreshWaitMs });
        }

        return commands;
      },
    },

    // 预留：按键映射也可以未来完全纳入 SPEC.plan（当前由 API 方法直接下发）
    buttonMapping: {
      key: "buttonMapping",
      kind: "virtual",
      priority: 60,
    },
  });

  // ============================================================
  // 8) 计划器：CommandPlanner（patch -> commands）
  //    目标：生产级“可维护/可扩展”的关键组件
  //
  //    Planner 负责：
  //    - normalize（字段已在外面做，但这里也可再做扩展）
  //    - 依赖补齐（例如 performanceMode 需要 pollingHz）
  //    - 生成 nextState（合并 patch + prevState）
  //    - 触发 compound/virtual spec
  //    - 按 priority 排序
  //    - 生成 commands
  //    - 去重（last-write-wins，避免同一寄存器重复写）
  //
  //    业务层只需要：planner.plan(prevState, payload) -> {commands,nextState}
  // ============================================================
  class CommandPlanner {
    constructor(profile) {
      this.profile = profile || DEFAULT_PROFILE;
    }

    // -------------------------
    // 选择器：为“性能模式 <-> 回报率”双向联动提供统一策略
    // - 性能模式写寄存器地址与 pollingHz 绑定，因此必须先保证 pollingHz 合法
    // - 若用户目标 mode 在当前 hz 不支持：自动把 pollingHz 调整到“最接近的合法值”
    // - 若用户目标 hz 下不支持当前/目标 mode：自动把 mode 调整到“最接近的合法值”
    // - 通过有限次迭代，防止互相修正导致死循环
    // -------------------------

    _modeRank() {
      return ["low", "hp", "sport", "oc"]; // 从低到高，用于“最接近”评估
    }

    _normalizeMode(mode) {
      return String(mode || "").toLowerCase();
    }

    _isPollingHzAllowed(hz) {
      const allowed = this.profile.capabilities.pollingRates || [];
      return allowed.includes(Number(hz));
    }

    _pickNearestPollingHz(hz) {
      const allowed = (this.profile.capabilities.pollingRates || []).slice().map(Number).filter(Number.isFinite);
      if (!allowed.length) return null;
      const target = Number(hz);
      if (allowed.includes(target)) return target;

      let best = allowed[0];
      let bestD = Math.abs(best - target);
      for (const v of allowed) {
        const d = Math.abs(v - target);
        if (d < bestD) { best = v; bestD = d; }
        // tie：更偏向更高 hz（减少“自动降级”惊喜）
        if (d === bestD && v > best) best = v;
      }
      return best;
    }

    // 给定 pollingHz，选择一个“最接近 requestedMode”的合法 mode
    _pickClosestModeForPolling(hz, requestedMode) {
      const allowed = (this.profile.capabilities.perfModesByPolling?.[Number(hz)] || []).map((m) => this._normalizeMode(m));
      if (!allowed.length) return null;

      const req = this._normalizeMode(requestedMode || "low");
      if (allowed.includes(req)) return req;

      const rank = this._modeRank();
      const reqIdx = rank.indexOf(req);
      if (reqIdx < 0) {
        // 未知枚举：直接按“高->低”兜底挑一个
        for (const m of ["sport", "oc", "hp", "low"]) {
          if (allowed.includes(m)) return m;
        }
        return allowed[0];
      }

      let best = allowed[0];
      let bestD = 999;
      for (const m of allowed) {
        const idx = rank.indexOf(m);
        if (idx < 0) continue;
        const d = Math.abs(idx - reqIdx);
        if (d < bestD) { best = m; bestD = d; }
        // tie：更偏向“更接近高性能”（即 idx 更大）
        if (d === bestD && rank.indexOf(m) > rank.indexOf(best)) best = m;
      }
      return best;
    }

    // 给定 mode，选择一个“离 currentHz 最近且支持该 mode”的 pollingHz
    _pickNearestPollingForMode(currentHz, mode) {
      const cap = this.profile.capabilities;
      const targetHz = Number(currentHz);
      const m = this._normalizeMode(mode);

      const hzList = (cap.pollingRates || []).slice().map(Number).filter(Number.isFinite);
      if (!hzList.length) return null;

      const supportedHz = hzList.filter((hz) => {
        const allowedModes = cap.perfModesByPolling?.[Number(hz)] || [];
        return allowedModes.map((x) => this._normalizeMode(x)).includes(m);
      });
      if (!supportedHz.length) return null;

      let best = supportedHz[0];
      let bestD = Math.abs(best - targetHz);
      for (const hz of supportedHz) {
        const d = Math.abs(hz - targetHz);
        if (d < bestD) { best = hz; bestD = d; }
        // tie：更偏向更高 hz
        if (d === bestD && hz > best) best = hz;
      }
      return best;
    }

    // 依赖展开：把必须的字段补齐/联动，确保下发计划完整且合法
    _expandDependencies(patch, prevState) {
      const out = { ...patch };

      // 归一化枚举（尽量早做，避免后续判断遗漏）
      if ("performanceMode" in out) out.performanceMode = this._normalizeMode(out.performanceMode);

      // 允许直接透传 opticalEngineHeightMm，planner 会自动匹配到 SPEC.opticalEngineHeightMm

      // 1) 若只改 performanceMode：先带上当前 pollingHz（因为寄存器地址取决于 pollingHz）
      if ("performanceMode" in out && !("pollingHz" in out)) {
        out.pollingHz = prevState.pollingHz ?? 1000;
      }

      // 2) 只要出现 pollingHz（来自用户或上一步补齐），都先纠正为“最接近的合法值”
      if ("pollingHz" in out) {
        const pickedHz = this._pickNearestPollingHz(out.pollingHz);
        if (pickedHz != null) out.pollingHz = pickedHz;
      }

      // 3) 双向联动：有限迭代防止互相修正导致死循环
      //    规则：
      //    - 若用户显式指定 performanceMode：优先保 mode，调整 pollingHz（最接近支持该 mode 的合法 hz）
      //    - 若用户未显式指定 performanceMode：优先保 pollingHz，调整 mode（最接近的合法 mode）
      const modeExplicit = Object.prototype.hasOwnProperty.call(out, "performanceMode");

      let iter = 0;
      let changed = true;
      while (changed && iter++ < 4) {
        changed = false;

        const hz = ("pollingHz" in out) ? Number(out.pollingHz) : Number(prevState.pollingHz ?? 1000);
        const hzFixed = this._pickNearestPollingHz(hz);
        if (hzFixed != null && hzFixed !== hz) {
          out.pollingHz = hzFixed;
          changed = true;
        }

        const curHz = ("pollingHz" in out) ? Number(out.pollingHz) : Number(prevState.pollingHz ?? 1000);
        const reqMode = modeExplicit
          ? this._normalizeMode(out.performanceMode)
          : this._normalizeMode(prevState.performanceMode ?? "low");

        const allowedModes = (this.profile.capabilities.perfModesByPolling?.[Number(curHz)] || []).map((m) => this._normalizeMode(m));
        const modeOk = allowedModes.includes(reqMode);

        if (!modeOk) {
          if (modeExplicit) {
            // 用户要切 mode：把 pollingHz 调到“最接近且支持该 mode”的合法值
            const pickedHz = this._pickNearestPollingForMode(curHz, reqMode);
            if (pickedHz != null && pickedHz !== curHz) {
              out.pollingHz = pickedHz;
              changed = true;
              continue; // 先稳定 hz，再检查 mode
            }
            // mode 在任何 hz 下都不支持（或无法选择）：退回为“在当前 hz 下最接近的合法 mode”
            const pickedMode = this._pickClosestModeForPolling(curHz, reqMode);
            if (pickedMode != null && pickedMode !== reqMode) {
              out.performanceMode = pickedMode;
              changed = true;
              continue;
            }
          } else {
            // 用户要切 hz：把 mode 调整为“在该 hz 下最接近的合法 mode”
            const pickedMode = this._pickClosestModeForPolling(curHz, reqMode);
            if (pickedMode != null && pickedMode !== reqMode) {
              out.performanceMode = pickedMode;
              changed = true;
              continue;
            }
          }
        } else {
          // mode 在该 hz 下合法：若 mode 不是显式指定，但用户同时改了 pollingHz，仍确保 out.performanceMode 被补齐
          if (!modeExplicit && ("pollingHz" in out) && !("performanceMode" in out)) {
            out.performanceMode = reqMode;
            changed = true;
          }
        }
      }

      // 4) 最终兜底：确保两者都有值，且 pollingHz 合法
      if (!("pollingHz" in out)) out.pollingHz = this._pickNearestPollingHz(prevState.pollingHz ?? 1000) ?? (prevState.pollingHz ?? 1000);
      if (!("performanceMode" in out)) {
        const hz = Number(out.pollingHz);
        out.performanceMode = this._pickClosestModeForPolling(hz, prevState.performanceMode ?? "low") || (prevState.performanceMode ?? "low");
      }

      // DPI：只要相关字段变化，就触发 dpiProfile 虚拟计划
      if ("dpiSlots" in out || "currentSlotCount" in out || "currentDpiIndex" in out) {
        out.dpiProfile = true; // 内部触发标记（不一定需要写入 state）
      }

      return out;
    }

    // 构建 nextState：patch 覆盖 prevState，并做必要的归一化
    _buildNextState(prevState, patch) {
      const next = { ...prevState, ...patch };

      // 归一化枚举
      if (typeof next.performanceMode === "string") next.performanceMode = next.performanceMode.toLowerCase();
      if (typeof next.lodHeight === "string") next.lodHeight = next.lodHeight.toLowerCase();

      // 确保 dpiSlots 长度满足最大 slot 数，避免各种越界
      const maxSlots = this.profile.capabilities.dpiSlotMax ?? 6;
      if (!Array.isArray(next.dpiSlots)) next.dpiSlots = [];
      while (next.dpiSlots.length < maxSlots) next.dpiSlots.push(800);
      if (next.dpiSlots.length > maxSlots) next.dpiSlots.length = maxSlots;

      // 对 slotCount/index 做一致性裁剪，保证 index < count
      const count = clampInt(Number(next.currentSlotCount ?? 1), 1, maxSlots);
      next.currentSlotCount = count;
      next.currentDpiIndex = clampInt(Number(next.currentDpiIndex ?? 0), 0, count - 1);

      return next;
    }

    // 收集需要执行的 spec（包含 direct/compound/virtual）
    _collectSpecKeys(expandedPatch) {
      const keys = new Set();

      // 1) patch 直接命中的 spec key
      for (const k of Object.keys(expandedPatch)) {
        if (SPEC[k]) keys.add(k);
      }

      // 2) compound：只要触发字段命中，就加入该 compound spec
      for (const item of Object.values(SPEC)) {
        if (item.kind !== "compound") continue;
        const triggers = item.triggers || [];
        if (triggers.some((t) => t in expandedPatch)) keys.add(item.key);
      }

      // 3) virtual：触发字段命中或 key 本身命中时加入
      for (const item of Object.values(SPEC)) {
        if (item.kind !== "virtual") continue;
        const triggers = item.triggers || [];
        if (triggers.some((t) => t in expandedPatch) || item.key in expandedPatch) keys.add(item.key);
      }

      return Array.from(keys);
    }

    // 简化排序：按 priority（未来可进一步引入 deps 做严格拓扑排序）
    _topoSort(keys) {
      return keys
        .map((k) => SPEC[k])
        .filter(Boolean)
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
    }

    // 去重：同一个 (rid, bank, addr) 最终只保留最后一次写（减少无意义写入）
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

    // 从 hex 里提取写命令的 bank/addr，用于去重
    _extractWriteKey(cmd) {
      try {
        const hex = String(cmd.hex || "");
        if (!hex.startsWith("a5a5") || hex.length < 14) return null;
        const addr = hex.slice(6, 8);
        const bank = hex.slice(8, 10);
        const rid = String(cmd.rid ?? 0);
        return `${rid}:${bank}:${addr}`;
      } catch {
        return null;
      }
    }

    /**
     * 生成计划（最重要的对外函数）
     * @param {Object} prevState - 当前本地配置状态
     * @param {Object} externalPayload - 外部传入的 payload（可带别名字段）
     * @returns {{patch:Object, nextState:Object, commands:Array}}
     */
    plan(prevState, externalPayload) {
      // 1) 字段归一化（snake_case -> camelCase）
      const patch0 = normalizePayload(externalPayload);

      // 2) 依赖展开（自动补齐/联动）
      const patch = this._expandDependencies(patch0, prevState);

      // 3) 合并生成 nextState（并做必要裁剪）
      const nextState = this._buildNextState(prevState, patch);

      // 4) 收集影响到的 spec，并做校验
      const specKeys = this._collectSpecKeys(patch);
      for (const k of specKeys) {
        const item = SPEC[k];
        if (typeof item?.validate === "function") {
          item.validate(patch, nextState, this.profile);
        }
      }

      // 5) 按 priority 排序，生成命令序列
      const ordered = this._topoSort(specKeys);
      const commands = [];
      const ctx = { profile: this.profile, prevState };

      for (const item of ordered) {
        if (!item) continue;

        // 5.1) virtual：由 plan 直接输出命令序列（支持复杂逻辑：双写/等待/多寄存器）
        if (typeof item.plan === "function") {
          const seq = item.plan(patch, nextState, ctx);
          if (Array.isArray(seq) && seq.length) commands.push(...seq);
          continue;
        }

        // 5.2) direct/compound/dynamic：encode 输出寄存器写定义，再由 Codec 生成 hex
        if (typeof item.encode === "function") {
          const value = patch[item.key];
          const enc = item.encode(value, nextState, this.profile);
          const writes = Array.isArray(enc) ? enc : [enc];

          for (const w of writes) {
            if (!w) continue;
            const hex = ProtocolCodec.write({
              bank: w.bank,
              addr: w.addr,
              dataBytes: w.dataBytes,
              lenOverride: w.lenOverride ?? null,
            });
            commands.push({ rid: w.rid ?? 6, hex, waitMs: w.waitMs });
          }
        }
      }

      // 6) 去重优化（last-write-wins）
      const optimized = this._dedupeCommands(commands);

      return { patch, nextState, commands: optimized };
    }
  }

  // ============================================================
  // 9) 对外命名空间 ProtocolApi
  // ============================================================
  const ProtocolApi = (window.ProtocolApi = window.ProtocolApi || {});

  // ============================================================
  // 9.1) Keymap：UI 动作字典（label -> {funckey,keycode}）
  //      说明：
  //      - 这是“语义动作库”，供 UI 下拉选择用
  //      - label 可扩展：新增动作只需要 add() 一条
  //      - 真正编码规则在 TRANSFORMERS.keymapActionBytes
  // ============================================================
  const KEYMAP_ACTIONS = (() => {
    const actions = Object.create(null);

    // 注册动作：label 唯一，避免覆盖
    const add = (label, type, funckey, keycode) => {
      if (!label || actions[label]) return;
      actions[label] = {
        type: String(type || "system"),
        funckey: toU8(funckey),
        keycode: clampInt(keycode, 0, 0xffff),
      };
    };

    // 鼠标按键
    add("左键", "mouse", 0x01, 0x0000);
    add("右键", "mouse", 0x02, 0x0000);
    add("中键", "mouse", 0x04, 0x0000);
    add("后退", "mouse", 0x08, 0x0000);
    add("前进", "mouse", 0x10, 0x0000);
    add("无", "mouse", 0x00, 0x0000);
    add("禁止按键", "mouse", 0x07, 0x0000);

    // DPI 功能（示例）
    add("DPI循环", "mouse", 0x08, 0x0003);
    add("DPI循环-", "mouse", 0x08, 0x0004);
    add("DIY按键", "mouse", 0x0a, 0x0000);
    // 键盘 A-Z（示例）
    for (let i = 0; i < 26; i++) add(String.fromCharCode(65 + i), "keyboard", 0x00, 0x04 + i);

    // 数字键 1-0（示例）
    const digits = ["1","2","3","4","5","6","7","8","9","0"];
    for (let i = 0; i < digits.length; i++) add(digits[i], "keyboard", 0x00, 0x1e + i);

    // 常用按键
    add("回车", "keyboard", 0x00, 0x28);
    add("ESC", "keyboard", 0x00, 0x29);
    add("退格", "keyboard", 0x00, 0x2a);
    add("Tab", "keyboard", 0x00, 0x2b);
    add("空格", "keyboard", 0x00, 0x2c);

    // 多媒体/系统（consumer key 示例）
    add("上一曲", "system", 0x04, 0x00b6);
    add("下一曲", "system", 0x04, 0x00b5);
    add("播放/暂停", "system", 0x04, 0x00cd);
    add("停止", "system", 0x04, 0x00b7);
    add("音量+", "system", 0x04, 0x00e9);
    add("音量-", "system", 0x04, 0x00ea);
    add("静音", "system", 0x04, 0x00e2);

    // 组合键（示例：02 + packed keycode）
    add("显示桌面", "system", 0x02, 0x0708);
    add("锁定电脑", "system", 0x02, 0x0f08);

    return Object.freeze(actions);
  })();

  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  // label -> {funckey,keycode}
  const LABEL_TO_PROTOCOL_ACTION = Object.freeze(
    Object.fromEntries(Object.entries(KEYMAP_ACTIONS).map(([label, a]) => [label, { funckey: a.funckey, keycode: a.keycode }]))
  );

  // {funckey,keycode} -> label（用于反向显示）
  const FUNCKEY_KEYCODE_TO_LABEL = (() => {
    const m = new Map();
    for (const [label, a] of Object.entries(KEYMAP_ACTIONS)) {
      const k = `${Number(a.funckey)}:${Number(a.keycode)}`;
      if (!m.has(k)) m.set(k, label);
    }
    return m;
  })();

  ProtocolApi.labelFromFunckeyKeycode = function labelFromFunckeyKeycode(funckey, keycode) {
    const fk = Number(funckey);
    const kc = Number(keycode);
    return FUNCKEY_KEYCODE_TO_LABEL.get(`${fk}:${kc}`) || `未知(${fk},${kc})`;
  };

  // ============================================================
  // 9.2) 按键寄存器地址映射（语义层）
  //      - btnId(2..6) -> addr
  //      - 未来如不同机型不同 addr，可移入 profile/spec override
  // ============================================================
  const BUTTON_ADDR = Object.freeze({
    1: 0x00, // 左键（根据协议抓包分析确认）
    2: 0x08, // 右键
    3: 0x04, // 中键
    4: 0x14, // 前进
    5: 0x18, // 后退
    6: 0x34, // DPI 键
    // 7: 0x24, // [可选] 抓包中读取了但返回 FF
    // 8: 0x28, // [可选] 抓包中读取了但返回 FF
  });

  // ============================================================
  // 10) 对外 API：MouseMouseHidApi
  //     目标：业务入口，内部只做：
  //     - 选择/打开设备
  //     - 把 payload 交给 planner 生成 commands
  //     - 用 driver 执行 commands
  //     - 成功后提交 nextState 并 emit
  //
  //     说明：为保持兼容性，仍保留 requestConfig 等“空实现回放”
  // ============================================================
  ProtocolApi.MOUSE_HID = {
    defaultFilters: [
      { vendorId: 0x24ae, usagePage: 0xff00, usage: 14 },
      { vendorId: 0x24ae, usagePage: 0xff00, usage: 2 },
      { vendorId: 0x24ae, usagePage: 0xff00 } // 兜底
    ],
    usagePage: 0x0001,
    usagePage8K: 0x000c,
  };

  ProtocolApi.resolveMouseDisplayName = function resolveMouseDisplayName(vendorId, productId, productName) {
    const pn = productName ? String(productName) : "";
    return pn ? `${pn} 54L` : `Rapoo Device`;
  };

  class MouseMouseHidApi {
    constructor({ profile = DEFAULT_PROFILE } = {}) {
      // 选择 profile（未来可按机型/固件选择不同 profile）
      this._profile = profile;

      // planner：负责“生成命令序列”
      this._planner = new CommandPlanner(this._profile);

      // driver：负责“发送命令”
      this._device = null;
      this._driver = new UniversalHidDriver();
      this._driver.defaultInterCmdDelayMs = this._profile.timings.interCmdDelayMs ?? 12;

      // API 级串行队列：避免读回与其他写操作交错，导致 UI 同步错位
      this._opQueue = new SendQueue();

      // 事件回调
      this._onConfigCbs = [];
      this._onBatteryCbs = [];
      this._onRawReportCbs = [];

      // 本地配置缓存（只有在 commands 成功执行后才提交）
      this._cfg = this._makeDefaultCfg();

      // 兼容性字段
      this._pendingCfgEmit = false;
      this._boundInputHandler = null;
    }

    set device(dev) {
      this._device = dev || null;
      this._driver.setDevice(this._device);
    }
    get device() {
      return this._device;
    }

    // 对外暴露能力信息（供 UI 决定显示哪些选项）
    get capabilities() {
      const cap = this._profile?.capabilities ?? {};
      return JSON.parse(JSON.stringify(cap));
    }

    // -------------------------
    // 打开设备：open/close
    // -------------------------

    // 发送 A5 A3 00 解锁/握手指令
    async _unlockDevice() {
      // 将 "a5a300" 修改为 8 字节对齐
      const hex = "a5a3000000000000"; 
      try {
        await this._driver.sendHex(6, hex);
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        // 如果是写入失败，这是严重错误，应该抛出让上层重试
        if (String(e).includes("Failed to write")) throw e;
        
        // 其他错误（如不支持）可以警告并忽略
        console.warn("设备解锁指令警告:", e);
      }
    }



    async open() {
      if (!this.device) throw new ProtocolError("open() 前必须先注入 hidApi.device", "NO_DEVICE");

      // 绑定 inputreport（可用于未来解析读回/电量/事件）
      const ensureBound = () => {
        if (this._boundInputHandler) return;
        this._boundInputHandler = (evt) => {
          try {
            const reportId = evt?.reportId;
            const dataView = evt?.data;
            const u8 = dataView ? new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength) : null;

            // 内部解析（状态广播/电量/DPI 等）
            if (u8 && u8.length) this._handleInputReport(Number(reportId), u8);

            // 原始数据回调（供调试/抓包）
            if (this._onRawReportCbs.length) {
              for (const cb of this._onRawReportCbs) cb({ reportId, data: u8, event: evt });
            }
          } catch {}
        };
        try { this.device.addEventListener("inputreport", this._boundInputHandler); } catch {}
      };

      if (this.device.opened) {
        ensureBound();
        return;
      }

      try {
        await this.device.open();

        await new Promise(r => setTimeout(r, 100)); 
        await this._unlockDevice();
        
      } catch (e) {
        const msg = String(e?.message || e);
        // 某些浏览器会出现 already open，需要 close 再 open
        if (msg.toLowerCase().includes("already open")) {
          try { await this.device.close(); } catch {}
          await new Promise(r => setTimeout(r, 100));
          await this.device.open();
          ensureBound();
          return;
        }
        throw new ProtocolError(`设备打开失败: ${msg}`, "OPEN_FAIL");
      }
      ensureBound();
    }

    async close() {
      const dev = this.device;
      if (!dev) return;

      try {
        if (this._boundInputHandler) dev.removeEventListener("inputreport", this._boundInputHandler);
      } catch {}
      this._boundInputHandler = null;

      try { if (dev.opened) await dev.close(); } catch {}

      this.device = null;

    }

    async dispose() {
      await this.close();


      try { this._onConfigCbs.length = 0; } catch {}
      try { this._onBatteryCbs.length = 0; } catch {}
      try { this._onRawReportCbs.length = 0; } catch {}

      try { this._cfg = null; } catch {}
    }

    // -------------------------
    // 事件订阅：onConfig/onBattery/onRawReport
    // -------------------------
    onConfig(cb, { replay = true } = {}) {
      if (typeof cb !== "function") return () => {};
      this._onConfigCbs.push(cb);

      // replay：订阅后立即回放当前 cfg（更易用）
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

    onBattery(cb) {
      if (typeof cb !== "function") return () => {};
      this._onBatteryCbs.push(cb);
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

    // 等待下一次 config 回调（用于调试/测试）
    waitForNextConfig(timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const off = this.onConfig((cfg) => {
          clearTimeout(timer);
          off();
          resolve(cfg);
        }, { replay: false });

        const timer = setTimeout(() => {
          off();
          reject(new Error(`waitForNextConfig timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    }

    // 等待下一次 battery 回调（用于 requestBattery 主动拉取后的短等待）
    waitForNextBattery(timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        const off = this.onBattery((bat) => {
          clearTimeout(timer);
          off();
          resolve(bat);
        });

        const timer = setTimeout(() => {
          off();
          reject(new Error(`waitForNextBattery timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });
    }

    // -------------------------
    // 兼容性接口：requestConfig 等
    // - 发送 A5A4 读命令
    // - 读取 FeatureReport(ID:8) 响应
    // - 解码后同步到本地 cfg，并触发 config 回调
    // -------------------------
    async requestConfig() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestConfig() 前必须先注入 hidApi.device", "NO_DEVICE");
        // 确保设备已打开（否则无法 receiveFeatureReport）
        if (!this.device.opened) await this.open();

        const snapshot = await this._readDeviceConfigSnapshot();
        this._cfg = Object.assign({}, this._cfg, snapshot);
        this._emitConfig();
      });
    }

    async requestConfiguration() { return this.requestConfig(); }
    async getConfig() { return this.requestConfig(); }
    async readConfig() { return this.requestConfig(); }
    async requestDeviceConfig() { return this.requestConfig(); }

    // -------------------------
    // 电量
    // Rapoo：电量来自 InputReport「状态广播包」(0x20...)。
    // 重要说明：
    // - 状态广播包为“被动上报”，不需要、也无法通过主动指令触发。
    // - requestBattery() 在 Rapoo 下仅用于：把“最近一次被动状态包解析到的电量”同步给 UI。
    // -------------------------
    async requestBattery() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestBattery() 前必须先注入 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        // 直接发出当前缓存值（来自最近一次状态包解析）
        // 说明：Rapoo 的电量为"被动上报"。未收到状态包前，batteryPercent 可能为 -1（未知）。
        const cached = this._cfg?.batteryPercent;
        const n = Number(cached);
        const percent = Number.isFinite(n) ? n : -1;
        try { this._emitBattery({ batteryPercent: percent }); } catch {}
      });
    }

    // ======================================================
    // A5A4 读命令：读取寄存器 -> FeatureReport(ID:8)
    // 写入/读取操作间隔：默认 12ms（由 profile.timings.interCmdDelayMs 控制）
    // ======================================================
    async _readRegisterBytes(bank, addr, len = 1) {
      const l = clampInt(Number(len ?? 1), 0, 255);
      const hex = ProtocolCodec.read({ bank, addr, len: l });

      // 发送 A5A4，然后读回 FeatureReport(ID:8)
      const featureU8 = await this._driver.sendAndReceiveFeature({
        rid: 6,
        hex,
        featureRid: 8,
        waitMs: this._profile.timings.interCmdDelayMs ?? 12,
      });

      return decodeFeatureReadBytes(featureU8, l);
    }

    async _readRegisterU8(bank, addr) {
      const bytes = await this._readRegisterBytes(bank, addr, 1);
      return bytes[0] ?? 0x00;
    }

    // 读取并解码当前设备真实配置（用于 UI 同步）
    async _readDeviceConfigSnapshot() {
  const cap = this._profile?.capabilities ?? {};
  const maxSlots = clampInt(cap.dpiSlotMax ?? 6, 1, 6);

  const snapshot = {};

  // 1) pollingHz
  let pollingHz = null;
  try {
    const pollingCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.pollingHz);
    pollingHz = DECODERS.pollingHzFromCode(pollingCode);
    snapshot.pollingHz = pollingHz;
  } catch (e) {
    console.warn("[Rapoo] 读取 pollingHz 失败", e);
  }

  // 2) performanceMode（依赖 pollingHz；若不可用则回退到缓存/常用值）
  try {
    const hz = Number(pollingHz ?? this._cfg?.pollingHz ?? 1000);
    const perfAddr = perfAddrByPollingHz(hz);
    const perfCode = await this._readRegisterU8(BANKS.SYSTEM, perfAddr);
    snapshot.performanceMode = DECODERS.performanceModeFromCode(perfCode);
  } catch (e) {
    console.warn("[Rapoo] 读取 performanceMode 失败", e);
  }

  // 3) 按键扫描率 (0x81)
  try {
    const scanCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.keyScanningRate);
    snapshot.keyScanningRate = DECODERS.keyScanningRateFromCode(scanCode);
  } catch (e) {
    console.warn("[Rapoo] 读取 keyScanningRate 失败", e);
  }

  // 4) 光学引擎高度 (0x84)
  try {
    const lodCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.lodHeight);
    snapshot.opticalEngineLevel = DECODERS.opticalLevelFromByte(lodCode);
    snapshot.opticalEngineHeightMm = DECODERS.opticalHeightFromByte(lodCode);
    snapshot.lodHeight = snapshot.opticalEngineHeightMm <= 1.0
      ? "low"
      : (snapshot.opticalEngineHeightMm <= 1.4 ? "mid" : "high");
  } catch (e) {
    console.warn("[Rapoo] 读取 lodHeight 失败", e);
  }

  // 5) Ripple Control (0x85)
  try {
    const rippleCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.rippleControl);
    snapshot.rippleControl = (toU8(rippleCode) === 0x01);
  } catch (e) {
    console.warn("[Rapoo] 读取 rippleControl 失败", e);
  }

  // 6) MotionSync & LinearCorrection (0xC3)
  try {
    const mixedCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.motionAndLinear);
    const mixedVal = toU8(mixedCode);
    snapshot.motionSync = (mixedVal & 0x01) === 0x00;
    snapshot.linearCorrection = (mixedVal & 0x02) === 0x00;
  } catch (e) {
    console.warn("[Rapoo] 读取 motion/linear 失败", e);
  }

  // 7) 玻璃模式 / 角度 / 去抖 / 抬起延迟
  try { snapshot.glassMode = DECODERS.bool(await this._readRegisterU8(BANKS.SYSTEM, ADDR.glassMode)); } catch (e) { console.warn("[Rapoo] 读取 glassMode 失败", e); }
  try { snapshot.sensorAngle = DECODERS.i8(await this._readRegisterU8(BANKS.SYSTEM, ADDR.sensorAngle)); } catch (e) { console.warn("[Rapoo] 读取 sensorAngle 失败", e); }
  try { snapshot.debounceMs = toU8(await this._readRegisterU8(BANKS.SYSTEM, ADDR.debounceMs)); } catch (e) { console.warn("[Rapoo] 读取 debounceMs 失败", e); }
  try { snapshot.liftDelayMs = toU8(await this._readRegisterU8(BANKS.SYSTEM, ADDR.liftDelayMs)); } catch (e) { console.warn("[Rapoo] 读取 liftDelayMs 失败", e); }

  // 8) 休眠时间
  try {
    const sleepMin = toU8(await this._readRegisterU8(BANKS.SYSTEM, ADDR.sleepTime));
    snapshot.sleepSeconds = DECODERS.sleepSecondsFromMinutes(sleepMin);
  } catch (e) {
    console.warn("[Rapoo] 读取 sleepTime 失败", e);
  }

  // 9) 无线策略
  try {
    const wsCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.wirelessStrategy);
    snapshot.wirelessStrategy = DECODERS.wirelessStrategyFromCode(wsCode);
  } catch (e) {
    console.warn("[Rapoo] 读取 wirelessStrategy 失败", e);
  }

  // 10) 通信协议
  try {
    const cpCode = await this._readRegisterU8(BANKS.COMM, ADDR.commProtocol);
    snapshot.commProtocol = DECODERS.commProtocolFromCode(cpCode);
  } catch (e) {
    console.warn("[Rapoo] 读取 commProtocol 失败", e);
  }

  // 11) DPI 相关
  try {
    const countCode = await this._readRegisterU8(BANKS.SYSTEM, ADDR.currentSlotCount);
    const currentSlotCount = DECODERS.slotCountFromCode(countCode, maxSlots);

    const idxRaw = await this._readRegisterU8(BANKS.SYSTEM, ADDR.currentDpiIndex);
    const currentDpiIndex = clampInt(Number(idxRaw), 0, currentSlotCount - 1);

    const dpiBytes = await this._readRegisterBytes(BANKS.SYSTEM, ADDR.dpiTableA, currentSlotCount * 2);
    const dpiVals = decodeU16leArray(dpiBytes).slice(0, currentSlotCount);

    // 补齐到 maxSlots：未读部分保持本地缓存值
    const prevSlots = Array.isArray(this._cfg?.dpiSlots) ? this._cfg.dpiSlots.slice(0, maxSlots) : [];
    const dpiSlots = [];
    for (let i = 0; i < maxSlots; i++) {
      if (i < dpiVals.length) dpiSlots.push(dpiVals[i]);
      else dpiSlots.push(prevSlots[i] ?? 800);
    }

    snapshot.dpiSlots = dpiSlots;
    snapshot.currentSlotCount = currentSlotCount;
    snapshot.currentDpiIndex = currentDpiIndex;
    snapshot.currentDpi = dpiSlots[currentDpiIndex] ?? (dpiVals[currentDpiIndex] ?? null);
  } catch (e) {
    console.warn("[Rapoo] 读取 DPI 相关寄存器失败", e);
  }

  // 12) 按键映射
  try {
    const buttonMappings = [];
    const buttonCount = 6;

    for (let i = 1; i <= buttonCount; i++) {
      const addr = BUTTON_ADDR[i];
      if (typeof addr !== "number") {
        buttonMappings.push({ funckey: 0, keycode: 0 });
        continue;
      }

      let mapped = { funckey: 0, keycode: 0 };

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const bytes = await this._readRegisterBytes(BANKS.BUTTON, addr, 4);
          if (bytes && bytes.length >= 4 && bytes[0] !== 0xff) {
            mapped = DECODERS.keymapAction(bytes);
            break;
          }
        } catch (_) {
          // ignore and retry
        }
        await sleep(25);
      }

      buttonMappings.push(mapped);
    }

    snapshot.buttonMappings = buttonMappings;
  } catch (e) {
    console.warn("[Rapoo] 读取按键映射失败", e);
  }

  // 13) LED 低电量提示（读取 4 字节以匹配写入结构）
  try {
    const ledBytes = await this._readRegisterBytes(BANKS.SYSTEM, ADDR.ledLowBattery, 4);
    if (ledBytes && ledBytes.length >= 2) {
      snapshot.ledLowBattery = (ledBytes[1] === 0x01);
    }
  } catch (e) {
    console.warn("[Rapoo] 读取 ledLowBattery 失败", e);
  }

  return snapshot;
}

    // ======================================================
    // InputReport 解码：ID:7 状态广播（仅读取电量）
    // 数据结构：20 00 [DPI_L] [DPI_H] ... [Index] [Bat] ...
    // ======================================================
    _handleInputReport(reportId, u8) {
      const rid = Number(reportId);
      // 兼容：部分环境/设备会以 ReportID=0 上报同一份状态包
      if (rid !== 7 && rid !== 0) return;
      if (!(u8 instanceof Uint8Array) || u8.length < 8) return;

      // 0: 0x20 包头；1: 0x00 填充
      if (u8[0] !== 0x20) return; // 状态包标识

      // 1. 仅提取电量 (第8字节)
      const bat = clampInt(u8[7], 0, 100);

      let prev = this._cfg || {};
      let changed = false;

      // 2. 仅在电量变化时更新
      if (Number(prev.batteryPercent ?? -1) !== bat) {
        prev.batteryPercent = bat;
        changed = true;
        try { this._emitBattery({ batteryPercent: bat }); } catch {}
      }

      // 3. 广播包不再干涉 currentDpi 和 currentDpiIndex
      if (changed) {
        try { this._emitConfig(); } catch {}
      }
    }

    // ======================================================
    // 对外写接口（最重要）
    // 设计要点：
    // - 全部走 planner 生成命令序列
    // - 执行成功后才提交 nextState（类似事务）
    // ======================================================
    async setFeature(key, value) {
      const k = String(key || "");
      const payload = { [k]: value };
      await this.setBatchFeatures(payload);
    }

    async setBatchFeatures(obj) {
      const externalPayload = isObject(obj) ? obj : {};

      return this._opQueue.enqueue(async () => {
        // 1. 计划生成：Planner 会自动处理 DPI 数组补齐、依赖关系
        const { patch, nextState, commands } = this._planner.plan(this._cfg, externalPayload);

        // 2. 下发写入指令
        await this._driver.runSequence(commands);

        // 移除回读逻辑，完全信任 Planner 生成的 nextState
        // 无论是否修改了 SlotCount，都直接应用 nextState
        this._cfg = nextState;

        // 4. 立即更新 UI 缓存
        this._emitConfig();
        return { patch, commands };
      });
    }

    // DPI 便捷接口：内部仍走 setBatchFeatures（保持统一入口）
    async setDpi(slot, value, opts = {}) {
      const s = clampInt(assertFiniteNumber(slot, "slot"), 1, this._profile.capabilities.dpiSlotMax);
      const dpi = clampInt(assertFiniteNumber(value, "dpi"), this._profile.capabilities.dpiMin, this._profile.capabilities.dpiMax);

      const nextSlots = Array.isArray(this._cfg.dpiSlots) ? [...this._cfg.dpiSlots] : [];
      while (nextSlots.length < this._profile.capabilities.dpiSlotMax) nextSlots.push(800);
      nextSlots[s - 1] = dpi;

      const patch = { dpiSlots: nextSlots };
      if (opts && opts.select) patch.currentDpiIndex = s - 1;

      await this.setBatchFeatures(patch);
    }

    async setSlotCount(n) {
      const count = clampInt(assertFiniteNumber(n, "slotCount"), 1, this._profile.capabilities.dpiSlotMax);
      await this.setBatchFeatures({ currentSlotCount: count });
    }

    async setCurrentDpiIndex(index) {
      const idx = clampInt(assertFiniteNumber(index, "index"), 0, (this._cfg.currentSlotCount || 1) - 1);
      await this.setBatchFeatures({ currentDpiIndex: idx });
    }

    /**
     * 设置按键映射（当前实现为：直接写 BUTTON bank 的某个 addr）
     * 未来演进建议：
     * - 也可把按键映射完全移入 SPEC.virtual 的 plan，由 planner 统一处理去重/节拍/事务等
     */
    async setButtonMappingBySelect(btnId, labelOrObj) {
      const b = clampInt(assertFiniteNumber(btnId, "btnId"), 1, 6);
      const addr = BUTTON_ADDR[b];
      if (!addr) throw new ProtocolError(`不支持配置按键 Btn${b}`, "FEATURE_UNSUPPORTED");

      let action;
      if (typeof labelOrObj === "string") {
        action = LABEL_TO_PROTOCOL_ACTION[labelOrObj];
        if (!action) throw new ProtocolError(`未知的按键动作: ${labelOrObj}`, "BAD_PARAM");
      } else if (isObject(labelOrObj)) {
        action = {
          funckey: Number(labelOrObj.funckey ?? labelOrObj.func ?? 0),
          keycode: Number(labelOrObj.keycode ?? labelOrObj.code ?? 0),
        };
      } else {
        throw new ProtocolError("按键映射参数必须是 label 或对象", "BAD_PARAM");
      }

      // 1) 编码 payload（4 bytes）
      const bytes = TRANSFORMERS.keymapActionBytes(action);

      // 2) 生成写命令：bank=BUTTON，addr=该按键寄存器地址，len=4
      const hex = ProtocolCodec.write({ bank: BANKS.BUTTON, addr, dataBytes: bytes, lenOverride: 0x04 });

      // 3) 下发执行
      await this._driver.runSequence([{ rid: 6, hex }]);

      // 4) 成功后更新本地缓存（方便 UI 立即展示）
      if (!Array.isArray(this._cfg.buttonMappings)) {
        this._cfg.buttonMappings = Array.from({ length: 6 }, () => ({ funckey: 0, keycode: 0 }));
      }
      while (this._cfg.buttonMappings.length < 6) this._cfg.buttonMappings.push({ funckey: 0, keycode: 0 });
      this._cfg.buttonMappings[b - 1] = { funckey: toU8(action.funckey), keycode: clampInt(action.keycode, 0, 0xffff) };

      this._emitConfig();
    }

    // ======================================================
    // 本地默认配置：用于初始化 UI（不依赖设备读回）
    // 未来可以逐步引入“读回 decode”来同步真实设备状态
    // ======================================================
    _makeDefaultCfg() {
      const cap = this._profile.capabilities;
      const pollingRates = cap.pollingRates?.length ? cap.pollingRates : [125, 250, 500, 1000];

      return {
        capabilities: {
          dpiSlotCount: cap.dpiSlotMax,
          maxDpi: cap.dpiMax,
          pollingRates: [...pollingRates],
        },

        dpiSlots: [800, 1200, 1600, 2400, 3200, 4800].slice(0, cap.dpiSlotMax),
        currentSlotCount: Math.min(4, cap.dpiSlotMax),
        currentDpiIndex: 0,
        // 实时 DPI：优先由 InputReport(ID:7) 状态广播更新
        currentDpi: 800,

        pollingHz: 1000,
        performanceMode: "hp",

        lodHeight: "high",

        opticalEngineHeightMm: 1.0,
        glassMode: false,

        motionSync: false,
        linearCorrection: false,
        rippleControl: false,

        sensorAngle: 0,
        debounceMs: 0,

        // 休眠时间（UI 秒）；设备写入分钟（2..120min）
        sleepSeconds: 300,

        wirelessStrategy: "smart",
        commProtocol: "initial",

        batteryPercent: -1,

        buttonMappings: Array.from({ length: 6 }, () => ({ funckey: 0, keycode: 0 })),
      };
    }

    // 通知所有 config 订阅者
    _emitConfig() {
      const cfg = this._cfg;
      for (const cb of this._onConfigCbs.slice()) {
        try { cb(cfg); } catch {}
      }
    }

    // 通知所有 battery 订阅者
    _emitBattery(bat) {
      const b = bat || { batteryPercent: 100, batteryIsCharging: false };
      for (const cb of this._onBatteryCbs.slice()) {
        try { cb(b); } catch {}
      }
    }
  }

  // 导出类
  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
})();
