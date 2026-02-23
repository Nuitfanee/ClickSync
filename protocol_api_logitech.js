/**
 * protocol_api_logitech.js 架构说明
 * * 核心思想：
 * 1) 业务解耦：MouseMouseHidApi 仅处理“意图”（如 setDpi），不关心 HID++ 报文的具体字节偏移或 Feature Index。
 * 2) 声明式驱动：所有逻辑由 SPEC (规范表) 驱动。新增功能只需在 SPEC 中定义其 kind (direct/virtual)、priority 和 plan。
 * 3) 状态机驱动：Planner 负责计算“当前状态 + 修改补丁 = 目标状态”，并根据状态差异自动推导出一组有序的指令序列。
 * 4) 严格流控：针对罗技板载内存写入易受干扰的特性，Transport 层实现了基于 Ack 匹配的阻塞式发送机制。
 *
 * 本文件实现优势：
 * - 拒绝硬编码：不使用静态模板，而是通过 ProtocolCodec 动态构建符合 HID++ 2.0 规范的报文。
 * - 聚合更新 (Virtual Features)：当修改 DPI 或按键时，Planner 会自动将其聚合为一次“Profile Stream”写入，而不是零散地发送冲突指令。
 * - 拓扑排序：通过 priority 确保指令顺序（例如：必须先 Start Profile，再写 Chunk，最后 Commit）。
 *
 * 架构分层：
 * - UniversalHidDriver (传输层)：
 * - 职责：管理 WebHID 设备实例，维护发送队列 (SendQueue)。
 * - 核心：`sendAndWait`。发送指令后，会通过 `criteria.match` 匹配设备返回的 Input Report，确保指令被执行后才继续下一步。
 *
 * - ProtocolCodec (编码层)：
 * - 职责：HID++ 协议的二进制封包。
 * - 核心：`buildProfileStream`。它将复杂的 JavaScript 状态对象转换为一个 256 字节的板载内存镜像，并计算 CRC16-CCITT 校验和。
 *
 * - TRANSFORMERS (转换层)：
 * - 职责：语义值与协议值的互转（如 "optical" <=> 0x00, 800DPI <=> 0x0320）。
 *
 * - SPEC (规范层 - 最核心)：
 * - Direct 模式：直接映射到简单的 HID++ 指令（如灯光、表面模式）。
 * - Virtual 模式：如 `dpiProfile`，它并不对应单一指令，而是监听多个字段的变更，一旦触发则重新规划整个 Profile Stream。
 *
 * - CommandPlanner (计划层)：
 * - 职责：执行 `plan(prevState, patch)`。
 * - 流程：标准化 Key -> 状态补全 -> 收集受影响的 SPEC 条目 -> 按优先级排序 -> 调用 SPEC.plan 生成指令集。
 *
 * - MouseMouseHidApi (业务层)：
 * - 职责：对外公开的干净接口。
 * - 特点：内部维护 `_cfg` 快照，通过 `setBatchFeatures` 触发 Planner，实现“改一处、动全局”的自动化配置同步。
 */

(() => {
  "use strict";

  // ============================================================
  // 0) Errors & basic helpers
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
    if (!Number.isFinite(x)) throw new ProtocolError(`${name} is not a valid number`, "BAD_PARAM", { name, value: n });
    return x;
  }

  function clampInt(n, min, max) {
    const x = Math.trunc(Number(n));
    return Math.min(max, Math.max(min, x));
  }

  function toU8(n) {
    return clampInt(n, 0, 0xff);
  }

  function bytesToHex(bytes) {
    const arr = bytes instanceof Uint8Array ? Array.from(bytes) : (Array.isArray(bytes) ? bytes : []);
    return arr.map((b) => toU8(b).toString(16).padStart(2, "0")).join("");
  }

  function hexToU8(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 !== 0) throw new ProtocolError(`HEX length invalid: ${hex}`, "BAD_HEX");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function fitToLen(u8, expectedLen) {
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8 || []);
    const n = Number(expectedLen);
    if (!Number.isFinite(n) || n <= 0) return u8;
    if (u8.byteLength === n) return u8;
    const out = new Uint8Array(n);
    out.set(u8.subarray(0, n));
    return out;
  }

  // ============================================================
  // 1) Transport: UniversalHidDriver
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
      this.sendTimeoutMs = 1200;
      this.ackTimeoutMs = 350; // Wait time for device Ack
      this.ackRetryCount = 1;
      this.defaultInterCmdDelayMs = 12;
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
      if (!this.device) throw new ProtocolError("No device assigned (hidApi.device is null)", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("Device not opened (call open())", "NOT_OPEN");
    }

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
        // Ignore descriptor parsing failures.
      }

      bucket.set(rid, found);
      return found;
    }

    async _sendReportDirect(reportId, hex) {
      this._requireDeviceOpen();
      const raw = hexToU8(hex);
      const dev = this.device;

      const runWithTimeout = async (p) => {
        await Promise.race([
          p,
          sleep(this.sendTimeoutMs).then(() => {
            throw new ProtocolError(`Write timeout (${this.sendTimeoutMs}ms)`, "IO_TIMEOUT");
          }),
        ]);
      };

      const buildCandidates = (expectedLen) => {
        const cands = [];
        const seen = new Set();
        const pushLen = (n) => {
          const len = Number(n);
          if (!Number.isFinite(len) || len <= 0) return;
          if (seen.has(len)) return;
          seen.add(len);
          cands.push(fitToLen(raw, len));
        };
        pushLen(raw.byteLength);
        if (expectedLen && expectedLen !== raw.byteLength) pushLen(expectedLen);
        for (const n of [6, 19, 8, 20, 16, 32, 64, 128]) pushLen(n);
        return cands;
      };

      const rid = Number(reportId);
      const errors = [];

      const expectedOutLen = this._getReportLen("output", rid);
      for (const payload of buildCandidates(expectedOutLen)) {
        try {
          await runWithTimeout(dev.sendReport(rid, payload));
          return;
        } catch (e) {
          errors.push(`sendReport(len=${payload.byteLength}): ${String(e?.message || e)}`);
        }
      }

      const expectedFeatLen = this._getReportLen("feature", rid);
      for (const payload of buildCandidates(expectedFeatLen)) {
        try {
          await runWithTimeout(dev.sendFeatureReport(rid, payload));
          return;
        } catch (e) {
          errors.push(`sendFeatureReport(len=${payload.byteLength}): ${String(e?.message || e)}`);
        }
      }

      throw new ProtocolError(`Write failed: ${errors.join(" | ")}`, "IO_WRITE_FAIL");
    }

    async _receiveFeatureReportDirect(reportId) {
      this._requireDeviceOpen();
      const rid = Number(reportId);
      const dev = this.device;

      const runWithTimeout = async (p) => {
        return await Promise.race([
          p,
          sleep(this.sendTimeoutMs).then(() => {
            throw new ProtocolError(`Read timeout (${this.sendTimeoutMs}ms)`, "IO_TIMEOUT");
          }),
        ]);
      };

      const expectedLen = this._getReportLen("feature", rid);
      const raw = await runWithTimeout(dev.receiveFeatureReport(rid));
      const u8 = raw instanceof DataView
        ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        : new Uint8Array(raw || []);
      return fitToLen(u8, expectedLen);
    }

    // Wait for Input Report (generic match)
    async _waitForInputReport(criteria) {
      this._requireDeviceOpen();
      if (!criteria) return null;

      return new Promise((resolve, reject) => {
        let timer = null;
        
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          this.device.removeEventListener("inputreport", onInput);
        };

        const onInput = (e) => {
          try {
            const rid = e.reportId;
            // Only check reports matching the expected ID
            if (rid !== criteria.rid) return;

            const u8 = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
            
            // Ignore Ignore-List (0x11 0x01 0x0D 0x2F ...)
            if (u8.length >= 3 && u8[0] === 0x01 && u8[1] === 0x0D && u8[2] === 0x2F) {
              return;
            }

            // Check match
            if (criteria.match && !criteria.match(u8)) return;
            
            cleanup();
            resolve(u8); // Return the data packet
          } catch (err) {
            // ignore parse errors in event loop
          }
        };

        this.device.addEventListener("inputreport", onInput);

        timer = setTimeout(() => {
          cleanup();
          // We strictly require the ack to ensure data integrity
          reject(new ProtocolError(`Ack timeout (${this.ackTimeoutMs}ms)`, "IO_ACK_TIMEOUT"));
        }, this.ackTimeoutMs);
      });
    }

    waitForInputReport(criteria) {
      return this._waitForInputReport(criteria);
    }

    async sendHex(reportId, hex) {
      return this.queue.enqueue(() => this._sendReportDirect(Number(reportId), String(hex)));
    }

    async receiveFeatureReport(reportId) {
      return this.queue.enqueue(() => this._receiveFeatureReportDirect(Number(reportId)));
    }

    async sendAndReceiveFeature({ rid, hex, featureRid, waitMs = null }) {
      return this.queue.enqueue(async () => {
        await this._sendReportDirect(Number(rid), String(hex));
        const w = waitMs != null ? Number(waitMs) : this.defaultInterCmdDelayMs;
        if (w != null && w > 0) await sleep(w);
        return await this._receiveFeatureReportDirect(Number(featureRid));
      });
    }

    async sendAndWait({ rid, hex, ack, waitMs = null }) {
      return this.queue.enqueue(async () => {
        const ackPromise = ack ? this._waitForInputReport(ack) : null;
        await this._sendReportDirect(Number(rid), String(hex));
        const w = waitMs != null ? Number(waitMs) : this.defaultInterCmdDelayMs;
        if (w != null && w > 0) await sleep(w);
        return ackPromise ? await ackPromise : null;
      });
    }

    // Updated runSequence to support Ack
    async runSequence(seq) {
      if (!Array.isArray(seq) || seq.length === 0) return;

      const runOnce = async (cmd) => {
        const rid = Number(cmd.rid);
        const hex = String(cmd.hex);
        if (cmd.ack) {
          await this.sendAndWait({ rid, hex, ack: cmd.ack, waitMs: 0 });
        } else {
          await this.sendHex(rid, hex);
        }
        const w = cmd.waitMs != null ? Number(cmd.waitMs) : this.defaultInterCmdDelayMs;
        if (w != null && w > 0) await sleep(w);
      };

      let index = 0;
      while (index < seq.length) {
        const cmd = seq[index];

        // Profile stream commands must be retried as a whole stream to avoid chunk misalignment.
        if (cmd && cmd.profileStream === true) {
          let end = index;
          while (end < seq.length && seq[end] && seq[end].profileStream === true) end++;
          const streamSeq = seq.slice(index, end);

          const maxStreamAttempts = 1 + Math.max(0, Number(this.ackRetryCount) || 0);
          let streamDone = false;
          let lastErr = null;

          for (let streamAttempt = 1; streamAttempt <= maxStreamAttempts; streamAttempt++) {
            try {
              for (const streamCmd of streamSeq) {
                await runOnce(streamCmd);
              }
              streamDone = true;
              break;
            } catch (err) {
              lastErr = err;
              const canRetry =
                streamAttempt < maxStreamAttempts &&
                String(err?.code || "") === "IO_ACK_TIMEOUT";
              if (canRetry) {
                console.warn(
                  `[Logitech][ProfileStream] Ack timeout, retrying whole stream (${streamAttempt}/${maxStreamAttempts})`
                );
              }
              if (!canRetry) throw err;
              await sleep(Math.max(0, Number(this.defaultInterCmdDelayMs) || 0));
            }
          }

          if (!streamDone && lastErr) {
            console.warn(
              `[Logitech][ProfileStream] Stream failed after ${maxStreamAttempts} attempts`
            );
            throw lastErr;
          }
          index = end;
          continue;
        }

        // Non-profile commands default to single try.
        const allowAckRetry = !!cmd?.retryOnAckTimeout;
        const maxAttempts =
          (cmd?.ack && allowAckRetry)
            ? (1 + Math.max(0, Number(this.ackRetryCount) || 0))
            : 1;

        let sent = false;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await runOnce(cmd);
            sent = true;
            break;
          } catch (err) {
            lastErr = err;
            const canRetry =
              !!cmd?.ack &&
              allowAckRetry &&
              attempt < maxAttempts &&
              String(err?.code || "") === "IO_ACK_TIMEOUT";
            if (!canRetry) throw err;
            await sleep(Math.max(0, Number(this.defaultInterCmdDelayMs) || 0));
          }
        }
        if (!sent && lastErr) throw lastErr;
        index += 1;
      }
    }
  }

  // ============================================================
  // 1.5) Feature Index 常量 (硬编码，针对 Logitech PRO X 2)
  // ============================================================
  const FEAT = Object.freeze({
    ROOT: 0x00,
    DEVICE_INFO: 0x03,
    BATTERY: 0x06,
    DPI: 0x09,
    SETTINGS: 0x0a,
    REPORT_RATE: 0x0c,
    PROFILE: 0x0d,
  });

  // ============================================================
  // 2) Codec: build Logitech payloads (without report ID)
  // ============================================================
  const REPORTS = Object.freeze({
    CMD: 0x10, // Short Commands
    PRE: 0x11, // Long Commands / Profile Data
  });

  const REPORT_PAYLOAD_LEN = Object.freeze({
    [REPORTS.CMD]: 7,
    [REPORTS.PRE]: 19,
  });

  const CMDS = Object.freeze({
    SET_SETTING: 0x1a,
    APPLY: 0x0a,
    PROFILE_START: 0x0f,
    PROFILE_HEADER: 0x6f,
    PROFILE_CHUNK: 0x7f,
    PROFILE_COMMIT: 0x8f,
    // Profile Slot 切换指令 (GHUB抓包: 10 01 0D 3B 00 [slot] 00)
    PROFILE_SET_ACTIVE_SLOT: 0x3b,
    // Profile Slot 查询指令 (GHUB抓包: 10 01 0D 4B 00 00 00 -> 11 01 0D 4B 00 [slot] 00)
    GET_ACTIVE_PROFILE_SLOT: 0x4b,
    // DPI Slot 切换指令 (OMM抓包: 10 01 0D CF [index] 00 00)
    DPI_SET_ACTIVE_SLOT: 0xcf,
    GET_PERF_CONFIG: 0x0b,
    // 板载内存模式指令 (抓包: 10 01 0D 1C [mode] 00 00, mode: 0x01=板载, 0x02=软件)
    SET_ONBOARD_MODE: 0x1c,
    // 查询板载内存模式 (抓包: 10 01 0D 2C 00 00 00 -> 11 01 0D 2C [mode] 00 00)
    GET_ONBOARD_MODE: 0x2c,
  });

  const PROFILE_STREAM_HEADER = Object.freeze([
    0x00, 0x01, 0x00, 0x00,
    0x00, 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);

  // Updated Template from Valid Capture (Cleaned)
  const PROFILE_STREAM_TEMPLATE = Object.freeze([
    Object.freeze([0x06, 0x03, 0x00, 0x00, 0xFC, 0x08, 0xFC, 0x08, 0x03, 0x20, 0x03, 0x20, 0x03, 0x02, 0x00, 0x00]),
    Object.freeze([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Object.freeze([0x00, 0xFF, 0x00, 0xFF, 0xFF, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x3C, 0x00, 0x2C, 0x01]),
    Object.freeze([0x80, 0x01, 0x00, 0x01, 0x80, 0x01, 0x00, 0x02, 0x80, 0x01, 0x00, 0x04, 0x80, 0x01, 0x00, 0x08]),
    Object.freeze([0x80, 0x01, 0x00, 0x10, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Object.freeze([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Object.freeze([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Object.freeze([0x80, 0x01, 0x00, 0x01, 0x80, 0x01, 0x00, 0x02, 0x80, 0x01, 0x00, 0x04, 0x80, 0x01, 0x00, 0x08]),
    Object.freeze([0x80, 0x01, 0x00, 0x10, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Object.freeze([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
    Object.freeze([0x50, 0x00, 0x52, 0x00, 0x4F, 0x00, 0x46, 0x00, 0x49, 0x00, 0x4C, 0x00, 0x45, 0x00, 0x5F, 0x00]),
    Object.freeze([0x4E, 0x00, 0x41, 0x00, 0x4D, 0x00, 0x45, 0x00, 0x5F, 0x00, 0x44, 0x00, 0x45, 0x00, 0x46, 0x00]),
    Object.freeze([0x41, 0x00, 0x55, 0x00, 0x4C, 0x00, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Object.freeze([0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x40, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]),
    Object.freeze([0x00, 0x1F, 0x40, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x40, 0x32, 0x00]),
    Object.freeze([0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0x40, 0x32, 0x00, 0x00, 0x03, 0x1F, 0xF7, 0xFF]),
  ]);

  const DEFAULT_STREAM_LAYOUT = Object.freeze({
    pollingWireless: { chunk: 0, offset: 0 },
    pollingWired: { chunk: 0, offset: 1 },
    // 默认DPI档位索引 (Chunk 0, Byte 2) - 设备重启后恢复到此档位
    defaultDpiSlotIndex: { chunk: 0, offset: 2 },
    dpi: { chunk: 0, spanChunks: 2, offset: 4, slots: 5, stride: 5, endian: "le", enableValue: 0x02 },
    // BHOP: 读取从 0x25 (Chunk 2, Offset 5), 单字节 * 10 = ms
    bhop: { chunk: 2, offset: 0x05 },
    buttons: Object.freeze([
      { chunk: 3, offset: 0 },
      { chunk: 3, offset: 4 },
      { chunk: 3, offset: 8 },
      { chunk: 3, offset: 12 },
      { chunk: 4, offset: 0 },
    ]),
    buttonsMirror: Object.freeze([
      { chunk: 7, offset: 0 },
      { chunk: 7, offset: 4 },
      { chunk: 7, offset: 8 },
      { chunk: 7, offset: 12 },
      { chunk: 8, offset: 0 },
    ]),
  });

  function cloneChunks(template) {
    return template.map((c) => (c instanceof Uint8Array ? new Uint8Array(c) : Uint8Array.from(c)));
  }

  function writeU16(bytes, offset, value, endian = "le") {
    const v = clampInt(value, 0, 0xffff);
    if (endian === "be") {
      bytes[offset] = (v >> 8) & 0xff;
      bytes[offset + 1] = v & 0xff;
    } else {
      bytes[offset] = v & 0xff;
      bytes[offset + 1] = (v >> 8) & 0xff;
    }
  }

  // CRC-16/CCITT-FALSE (verified against device 0xDE57)
  function crc16CcittFalse(bytes, init = 0xffff) {
    let crc = init & 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= (toU8(bytes[i]) << 8);
      for (let b = 0; b < 8; b++) {
        if (crc & 0x8000) {
          crc = ((crc << 1) ^ 0x1021) & 0xffff;
        } else {
          crc = (crc << 1) & 0xffff;
        }
      }
    }
    return crc & 0xffff;
  }

  const ProtocolCodec = Object.freeze({
    encode({ reportId, iface, feat, cmd, dataBytes = [], lenOverride = null, payloadBytes = null }) {
      const rid = Number(
        reportId != null ? reportId
          : (iface === "cmd" ? REPORTS.CMD : (iface === "pre" ? REPORTS.PRE : NaN))
      );
      if (!Number.isFinite(rid)) throw new ProtocolError("encode(): reportId/iface required", "BAD_PARAM");

      // Feature Index (直接使用 FEAT 常量)
      const groupIndex = feat != null ? toU8(feat) : 0x00;

      if (!payloadBytes && !Number.isFinite(Number(cmd))) {
        throw new ProtocolError("encode(): cmd required when payloadBytes is not provided", "BAD_PARAM");
      }

      const g = groupIndex;
      const c = toU8(cmd);

      // HID++ 消息格式: [DeviceIndex] [FeatureIndex] [FunctionID] [Params...]
      // Report ID (0x10/0x11) 通过 sendReport 单独传递，不包含在 payload 中
      const bytes = payloadBytes
        ? (payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes))
        : new Uint8Array([0x01, g, c, ...dataBytes.map(toU8)]);

      const expectedLen = lenOverride != null ? clampInt(lenOverride, 0, 255) : (REPORT_PAYLOAD_LEN[rid] ?? bytes.length);
      const payload = fitToLen(bytes, expectedLen);
      return { rid, hex: bytesToHex(payload) };
    },

    buildChunk(payload16Bytes) {
      const bytes = payload16Bytes instanceof Uint8Array ? payload16Bytes : new Uint8Array(payload16Bytes || []);
      return ProtocolCodec.encode({
        iface: "pre",
        feat: FEAT.PROFILE,
        cmd: CMDS.PROFILE_CHUNK,
        dataBytes: bytes,
      });
    },

    // 抓包格式分析 (Header 0x6F):
    // OUT: 11 01 0D 6F 00 [ProfileId] 00 00 00 FF 00 00 00 00 00 00 00 00 00 00
    // ProfileId: 0x01=配置1, 0x02=配置2, ...
    buildProfileStream(state, profile, targetProfileSlotIndex = null) {
      const prof = profile || DEFAULT_PROFILE;
      const template = (prof.streamTemplate && Array.isArray(prof.streamTemplate.chunks))
        ? prof.streamTemplate.chunks
        : PROFILE_STREAM_TEMPLATE;
      const baseHeaderBytes = (prof.streamTemplate && Array.isArray(prof.streamTemplate.header))
        ? prof.streamTemplate.header
        : PROFILE_STREAM_HEADER;
      const layout = Object.assign({}, DEFAULT_STREAM_LAYOUT, prof.streamLayout || {});

      // 根据目标 Profile Slot 修改 Header 中的 Profile ID
      // Header 格式: [0x00, ProfileId, 0x00, 0x00, 0x00, 0xFF, ...]
      // 如果未指定 targetProfileSlotIndex，使用 state.activeProfileSlotIndex 或默认 0
      const profileSlotIndex = targetProfileSlotIndex != null
        ? clampInt(targetProfileSlotIndex, 0, 4)
        : clampInt(state.activeProfileSlotIndex ?? 0, 0, 4);
      const profileId = profileSlotIndex + 1; // 设备使用 1-based (0x01 ~ 0x05)

      // 复制 header 并设置正确的 Profile ID
      const headerBytes = [...baseHeaderBytes];
      if (headerBytes.length >= 2) {
        headerBytes[1] = profileId;
      }

      const chunks = cloneChunks(template);

      const setByte = (loc, value) => {
        if (!loc) return;
        const c = chunks[loc.chunk];
        if (!c) return;
        c[loc.offset] = toU8(value);
      };

      if (state.pollingWirelessHz != null || state.pollingHz != null) {
        if (state.pollingWirelessHz != null) {
          setByte(layout.pollingWireless, TRANSFORMERS.pollingHzCode(state.pollingWirelessHz));
        }
        if (state.pollingHz != null) {
          setByte(layout.pollingWired, TRANSFORMERS.pollingHzCode(state.pollingHz));
        }
      }

      // 默认DPI档位索引写入 (Chunk 0, Byte 2)
      if (state.defaultDpiSlotIndex != null) {
        const maxDpiSlots = clampInt(prof.capabilities?.dpiSlotMax ?? 5, 1, 10);
        const defaultIdx = clampInt(Number(state.defaultDpiSlotIndex), 0, maxDpiSlots - 1);
        setByte(layout.defaultDpiSlotIndex, defaultIdx);
      }

      // DPI Slots 处理
      {
        const dpiCfg = layout.dpi || {};
        const maxDpiSlots = clampInt(prof.capabilities?.dpiSlotMax ?? dpiCfg.slots ?? 5, 1, 10);
        const dpiSlotsX = Array.isArray(state.dpiSlotsX)
          ? state.dpiSlotsX.slice(0)
          : (Array.isArray(state.dpiSlots) ? state.dpiSlots.slice(0) : null);
        const dpiSlotsY = Array.isArray(state.dpiSlotsY)
          ? state.dpiSlotsY.slice(0)
          : (dpiSlotsX ? dpiSlotsX.slice(0) : null);
        const desiredCount = state.dpiSlotCount != null
          ? clampInt(state.dpiSlotCount, 1, maxDpiSlots)
          : (Array.isArray(dpiSlotsX) ? clampInt(dpiSlotsX.length, 1, maxDpiSlots) : null);

        if (dpiSlotsX || dpiSlotsY || desiredCount != null) {
          const span = clampInt(dpiCfg.spanChunks ?? 2, 1, 4);
          const baseChunk = clampInt(dpiCfg.chunk ?? 0, 0, chunks.length - 1);
          const totalBytes = span * 16;
          const buf = new Uint8Array(totalBytes);
          for (let i = 0; i < span; i++) {
            const c = chunks[baseChunk + i];
            if (c) buf.set(c, i * 16);
          }

          const base = clampInt(dpiCfg.offset ?? 4, 0, totalBytes - 1);
          const stride = clampInt(dpiCfg.stride ?? 5, 1, 8);
          const endian = dpiCfg.endian || "le";

          const readU16 = (offset) => {
            if (offset + 1 >= buf.length) return 0;
            return endian === "be"
              ? ((buf[offset] << 8) | buf[offset + 1])
              : (buf[offset] | (buf[offset + 1] << 8));
          };

          const existingX = [];
          const existingY = [];
          for (let i = 0; i < maxDpiSlots; i++) {
            const off = base + i * stride;
            if (off + 3 >= buf.length) break;
            existingX.push(readU16(off));
            existingY.push(readU16(off + 2));
          }
          const lastNonZeroX = existingX.slice().reverse().find((v) => v > 0) || 0;
          const lastNonZeroY = existingY.slice().reverse().find((v) => v > 0) || lastNonZeroX;

          for (let i = 0; i < maxDpiSlots; i++) {
            const off = base + i * stride;
            if (off + 4 >= buf.length) break;

            const enable = desiredCount != null ? (i < desiredCount) : null;
            let dpiValueX = null;
            let dpiValueY = null;

            if (enable === false) {
              dpiValueX = 0;
              dpiValueY = 0;
            } else {
              if (dpiSlotsX && dpiSlotsX.length) {
                const rawX = dpiSlotsX[i] != null ? dpiSlotsX[i] : dpiSlotsX[dpiSlotsX.length - 1];
                if (rawX != null) dpiValueX = TRANSFORMERS.dpiU16(rawX);
              }
              if (dpiSlotsY && dpiSlotsY.length) {
                const rawY = dpiSlotsY[i] != null ? dpiSlotsY[i] : dpiSlotsY[dpiSlotsY.length - 1];
                if (rawY != null) dpiValueY = TRANSFORMERS.dpiU16(rawY);
              }
              if (enable === true) {
                if (dpiValueX == null) dpiValueX = lastNonZeroX;
                if (dpiValueY == null) dpiValueY = lastNonZeroY;
              }
            }

            if (dpiValueX == null) dpiValueX = readU16(off);
            if (dpiValueY == null) dpiValueY = readU16(off + 2) || dpiValueX;

            writeU16(buf, off, dpiValueX, endian);
            writeU16(buf, off + 2, dpiValueY, endian);
            if (enable != null) {
              let flags = 0x00;
              if (enable) {
                const lod = Array.isArray(state.dpiLods) ? (state.dpiLods[i] || "mid") : "mid";
                flags = TRANSFORMERS.lodCode(lod);
              }
              buf[off + 4] = flags;
            }
          }

          for (let i = 0; i < span; i++) {
            const c = chunks[baseChunk + i];
            if (!c) continue;
            c.set(buf.subarray(i * 16, i * 16 + 16));
          }
        }
      }

      if (state.bhopMs != null) {
        const loc = layout.bhop;
        if (loc && chunks[loc.chunk]) {
          // BHOP: 单字节存储，值 = ms / 10
          const v = clampInt(Math.round(state.bhopMs / 10), 0, 255);
          chunks[loc.chunk][loc.offset] = toU8(v);
        }
      }

      if (Array.isArray(state.buttonMappings)) {
        const entries = state.buttonMappings.slice(0);
        while (entries.length < 5) entries.push(null);
        const applyButtons = (targets) => {
          if (!Array.isArray(targets)) return;
          for (let i = 0; i < targets.length; i++) {
            const loc = targets[i];
            const c = chunks[loc.chunk];
            if (!c) continue;
            const code = TRANSFORMERS.buttonCode(entries[i]);
            c[loc.offset + 0] = 0x80;
            c[loc.offset + 1] = 0x01;
            c[loc.offset + 2] = 0x00;
            c[loc.offset + 3] = toU8(code);
          }
        };
        applyButtons(layout.buttons);
        applyButtons(layout.buttonsMirror);
      }

      if (chunks.length >= 16) {
        const flat = new Uint8Array(chunks.length * 16);
        for (let i = 0; i < chunks.length; i++) {
          flat.set(chunks[i], i * 16);
        }
        // Validated: CRC covers 0..252 (253 bytes)
        const crc = crc16CcittFalse(flat.subarray(0, 253));
        const last = chunks[15];
        if (last && last.length >= 15) {
          last[13] = (crc >> 8) & 0xff;
          last[14] = crc & 0xff;
        }
      }

      const commands = [];

      // 1. Start (Cmd 0x0F)
      const start = ProtocolCodec.encode({
        iface: "cmd",
        feat: FEAT.PROFILE,
        cmd: CMDS.PROFILE_START,
        dataBytes: [0x00, 0x00, 0x00],
      });
      commands.push({
        rid: start.rid,
        hex: start.hex,
        profileStream: true,
        ack: {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.PROFILE_START,
        },
      });

      // 2. Header (Pre 0x6F)
      const header = ProtocolCodec.encode({
        iface: "pre",
        feat: FEAT.PROFILE,
        cmd: CMDS.PROFILE_HEADER,
        dataBytes: headerBytes,
      });
      commands.push({
        rid: header.rid,
        hex: header.hex,
        profileStream: true,
        ack: {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.PROFILE_HEADER,
        },
      });

      // 3. Chunks (Pre 0x7F) - Require strict Flow Control
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const pkt = ProtocolCodec.buildChunk(chunk);

        commands.push({
          rid: pkt.rid,
          hex: pkt.hex,
          profileStream: true,
          // Ack Expectation: 11 01 0D 7F 00 [Index] ...
          ack: {
            rid: REPORTS.PRE,
            match: (u8) => {
               if (u8.length < 5) return false;
               return u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === 0x7F && u8[4] === (i + 1);
            }
          }
        });
      }

      // 4. Commit (Cmd 0x8F)
      const commit = ProtocolCodec.encode({
        iface: "cmd",
        feat: FEAT.PROFILE,
        cmd: CMDS.PROFILE_COMMIT,
        dataBytes: [0x00, 0x00, 0x00],
      });
      commands.push({
        rid: commit.rid,
        hex: commit.hex,
        profileStream: true,
        ack: {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.PROFILE_COMMIT,
        },
      });

      return commands;
    },
  });

  // ============================================================
  // 3) Profile / capabilities
  // ============================================================
  const DEFAULT_PROFILE = Object.freeze({
    id: "logitech-lightforce",
    capabilities: Object.freeze({
      lightforceSwitchModes: Object.freeze(["optical", "hybrid"]),
      dpiSlotMax: 5,
      dpiMin: 50,
      dpiMax: 26000,
      pollingRatesWired: Object.freeze([125, 250, 500, 1000]),
      pollingRatesWireless: Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]),
    }),
    timings: Object.freeze({
      interCmdDelayMs: 12,
    }),
    streamTemplate: Object.freeze({
      chunks: PROFILE_STREAM_TEMPLATE,
      header: PROFILE_STREAM_HEADER,
    }),
    streamLayout: Object.freeze(DEFAULT_STREAM_LAYOUT),
  });

  // ============================================================
  // 4) Field normalization
  // ============================================================
  // ============================================================
  // 概念说明:
  // - Profile Slot: 板载配置槽位 (设备存储的完整配置, 通常2个: 0/1)
  // - DPI Slot: DPI档位 (每个Profile内的DPI设置, 通常5个: 0-4)
  // ============================================================
  const KEY_ALIASES = Object.freeze({
    lightforceSwitch: "lightforceSwitch",
    lightforce_switch: "lightforceSwitch",
    lightforceMode: "lightforceSwitch",
    lightforce_mode: "lightforceSwitch",
    surfaceMode: "surfaceMode",
    surface_mode: "surfaceMode",

    pollingHz: "pollingHz",
    polling_hz: "pollingHz",
    pollingWirelessHz: "pollingWirelessHz",
    polling_wireless_hz: "pollingWirelessHz",

    // DPI Slot 相关 (档位)
    dpiSlots: "dpiSlots",
    dpi_slots: "dpiSlots",
    dpiSlotsX: "dpiSlotsX",
    dpi_slots_x: "dpiSlotsX",
    dpiSlotsY: "dpiSlotsY",
    dpi_slots_y: "dpiSlotsY",
    dpiSlotCount: "dpiSlotCount",
    dpi_slot_count: "dpiSlotCount",
    currentSlotCount: "dpiSlotCount",
    current_slot_count: "dpiSlotCount",

    // 当前激活DPI档位 (实时状态，通过Feature 0x09读取)
    activeDpiSlotIndex: "activeDpiSlotIndex",
    active_dpi_slot_index: "activeDpiSlotIndex",
    currentDpiIndex: "activeDpiSlotIndex",
    current_dpi_index: "activeDpiSlotIndex",

    // 默认DPI档位 (存储在Profile内存中，设备重启后恢复到此档位)
    defaultDpiSlotIndex: "defaultDpiSlotIndex",
    default_dpi_slot_index: "defaultDpiSlotIndex",
    defaultDpiIndex: "defaultDpiSlotIndex",
    default_dpi_index: "defaultDpiSlotIndex",

    // Profile Slot 相关 (板载配置)
    activeProfileSlotIndex: "activeProfileSlotIndex",
    active_profile_slot_index: "activeProfileSlotIndex",

    // DPI LOD 设置
    dpiLods: "dpiLods",
    dpi_lods: "dpiLods",
    lods: "dpiLods",

    bhopMs: "bhopMs",
    bhop_ms: "bhopMs",

    buttonMappings: "buttonMappings",
    buttonMapping: "buttonMappings",
    button_mappings: "buttonMappings",
    button_mapping: "buttonMappings",

    dpiProfile: "dpiProfile",
    dpi_profile: "dpiProfile",
  });

  function normalizePayload(payload) {
    if (!isObject(payload)) return {};
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      const nk = KEY_ALIASES[k] || k;
      out[nk] = v;
    }
    if (isObject(payload.dpiProfile)) {
      for (const [k, v] of Object.entries(payload.dpiProfile)) {
        const nk = KEY_ALIASES[k] || k;
        out[nk] = v;
      }
    }
    return out;
  }

  // ============================================================
  // 5) Transformers
  // ============================================================
  const TRANSFORMERS = Object.freeze({
    // Lightforce 微动开关 (抓包验证)
    // 混动(hybrid): 0x01, 仅光学(optical): 0x00
    lightforceSwitchCode(value) {
      if (typeof value === "number") return clampInt(value, 0, 1);
      const v = String(value || "").trim().toLowerCase();
      if (!v) throw new ProtocolError("lightforceSwitch: empty value", "BAD_PARAM");
      if (["optical", "optical-only", "only-optical", "lf-optical", "lightforce"].includes(v)) return 0x00;
      if (["hybrid", "mixed", "hybrid-power", "save-power", "power-saving"].includes(v)) return 0x01;
      throw new ProtocolError(`lightforceSwitch: unsupported mode "${value}"`, "BAD_PARAM");
    },
    lightforceSwitchFromCode(code) {
      const v = toU8(code);
      if (v === 0x00) return "optical";
      if (v === 0x01) return "hybrid";
      return null;
    },
    // 游戏表面模式 (抓包验证)
    // 自动(auto): 0x00, 开启(on): 0x02, 关闭(off): 0x04
    surfaceModeCode(value) {
      if (typeof value === "number") return clampInt(value, 0, 4);
      const v = String(value || "").trim().toLowerCase();
      if (!v) return 0x00;
      if (["auto", "adaptive"].includes(v)) return 0x00;
      if (["on", "enable", "enabled"].includes(v)) return 0x02;
      if (["off", "disable", "disabled"].includes(v)) return 0x04;
      return 0x00;
    },
    surfaceModeFromCode(code) {
      const v = toU8(code);
      if (v === 0x00) return "auto";
      if (v === 0x02) return "on";
      if (v === 0x04) return "off";
      return "auto";
    },
    pollingHzCode(hz) {
      const map = { 125: 0x00, 250: 0x01, 500: 0x02, 1000: 0x03, 2000: 0x04, 4000: 0x05, 8000: 0x06 };
      return map[Number(hz)] ?? 0x03;
    },
    pollingHzFromCode(code) {
      const map = { 0x00: 125, 0x01: 250, 0x02: 500, 0x03: 1000, 0x04: 2000, 0x05: 4000, 0x06: 8000 };
      return map[toU8(code)] || 1000;
    },
    bhopCode(ms) {
      if (ms == null) return 0x0000;
      return clampInt(assertFiniteNumber(ms, "bhopMs"), 0, 0xffff);
    },
    lodCode(val) {
      if (typeof val === "number") return clampInt(val, 0, 0xff);
      const v = String(val || "").trim().toLowerCase();
      if (v === "high") return 0x03;
      if (v === "low") return 0x01;
      return 0x02;
    },
    dpiU16(dpi) {
      return clampInt(assertFiniteNumber(dpi, "dpi"), 1, 0xffff);
    },
    activeDpiSlotCode(value, maxSlots = 5) {
      // Treat numeric input as 0-based index (0..maxSlots-1).
      const maxIndex = Math.max(0, clampInt(maxSlots, 1, 255) - 1);
      if (isObject(value)) {
        if (value.index != null) {
          return clampInt(assertFiniteNumber(value.index, "activeDpiSlot.index"), 0, maxIndex);
        }
        if (value.slot != null) {
          return clampInt(assertFiniteNumber(value.slot, "activeDpiSlot.slot") - 1, 0, maxIndex);
        }
      }
      return clampInt(assertFiniteNumber(value, "activeDpiSlot"), 0, maxIndex);
    },
    // DPI Slot Index (0-based, 用于切换当前激活的DPI档位)
    dpiSlotIndexCode(value, maxSlots = 5) {
      const maxIndex = Math.max(0, clampInt(maxSlots, 1, 255) - 1);
      if (isObject(value)) {
        if (value.index != null) {
          return clampInt(assertFiniteNumber(value.index, "dpiSlotIndex.index"), 0, maxIndex);
        }
      }
      return clampInt(assertFiniteNumber(value, "dpiSlotIndex"), 0, maxIndex);
    },
    buttonCode(value) {
      if (value == null) return 0x00;
      if (typeof value === "number") return clampInt(value, 0, 0xff);
      if (isObject(value)) {
        if (value.label != null) return TRANSFORMERS.buttonCode(value.label);
        if (value.funckey != null || value.func != null) {
          const fk = toU8(value.funckey ?? value.func ?? 0x00);
          const fkMap = {
            0x01: 0x01, // left
            0x02: 0x02, // right
            0x04: 0x04, // middle
            0x08: 0x08, // back
            0x10: 0x10, // forward
            0x07: 0x07, // disable
            0x00: 0x00, // none
          };
          if (fk in fkMap) return fkMap[fk];
        }
        if (value.code != null) return clampInt(value.code, 0, 0xff);
        if (value.btn != null) return clampInt(value.btn, 0, 0xff);
        if (value.button != null) return clampInt(value.button, 0, 0xff);
      }
      const raw = String(value || "").trim();
      if (!raw) return 0x00;
      const v = raw.toLowerCase();
      const map = {
        left: 0x01,
        "left click": 0x01,
        "左键": 0x01,
        right: 0x02,
        "right click": 0x02,
        "右键": 0x02,
        middle: 0x04,
        "middle click": 0x04,
        "中键": 0x04,
        back: 0x10,
        "后退": 0x10,
        forward: 0x08,
        "前进": 0x08,
        none: 0x00,
        "无": 0x00,
        disable: 0x07,
        disabled: 0x07,
        "禁用": 0x07,
        "禁止按键": 0x07,
      };
      return map[v] ?? 0x00;
    },
  });

  function normalizeButtonMappings(input, count = 6) {
    const src = Array.isArray(input) ? input : [];
    const out = [];
    const n = clampInt(Number(count ?? 6), 1, 12);
    for (let i = 0; i < n; i++) {
      const it = src[i];
      if (isObject(it)) {
        if (it.funckey != null || it.keycode != null || it.func != null) {
          out.push({
            funckey: toU8(it.funckey ?? it.func ?? 0),
            keycode: clampInt(it.keycode ?? it.code ?? 0, 0, 0xffff),
          });
          continue;
        }
        if (it.code != null || it.btn != null || it.button != null || it.label != null) {
          out.push({ funckey: TRANSFORMERS.buttonCode(it), keycode: 0 });
          continue;
        }
      }
      if (it != null) {
        out.push({ funckey: TRANSFORMERS.buttonCode(it), keycode: 0 });
        continue;
      }
      out.push({ funckey: 0, keycode: 0 });
    }
    return out;
  }

  // ============================================================
  // 6) SPEC: semantic feature descriptions
  // ============================================================
    const SPEC = Object.freeze({
    // Lightforce 微动开关设置 (抓包验证)
    // OUT: 11 01 0A 1A 00 [mode] 00 07 ...
    // IN:  11 01 0A 1A 00 00 00 ...
    // OUT: 10 01 0A 0A 00 00 00
    // IN:  11 01 0A 0A 00 [mode] 00 ...
    lightforceSwitch: {
      key: "lightforceSwitch",
      kind: "direct",
      priority: 10,
      pendingAck: true,
      validate(patch, nextState, profile) {
        const code = TRANSFORMERS.lightforceSwitchCode(nextState.lightforceSwitch);
        const mode = TRANSFORMERS.lightforceSwitchFromCode(code);
        const allowed = profile.capabilities.lightforceSwitchModes || [];
        if (mode && !allowed.includes(mode)) {
          throw new ProtocolError(`lightforceSwitch "${mode}" not supported`, "FEATURE_UNSUPPORTED", { allowed });
        }
      },
      plan(patch, nextState, profile) {
        const modeCode = TRANSFORMERS.lightforceSwitchCode(nextState.lightforceSwitch);

        const pre = ProtocolCodec.encode({
          iface: "pre",
          feat: FEAT.SETTINGS,
          cmd: 0x1A,
          dataBytes: [0x00, modeCode, 0x00, 0x07],
        });

        const apply = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.SETTINGS,
          cmd: 0x0A,
          dataBytes: [0x00, 0x00, 0x00],
        });

        return [
          {
            rid: pre.rid,
            hex: pre.hex,
            ack: { rid: 0x11, match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.SETTINGS && u8[2] === 0x1A }
          },
          {
            rid: apply.rid,
            hex: apply.hex,
            ack: { rid: 0x11, match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.SETTINGS && u8[2] === 0x0A }
          },
        ];
      },
    },

    // 游戏表面模式设置 (抓包验证)
    // OUT: 11 01 0A 1A 00 [mode] 00 07 ...
    // IN:  11 01 0A 1A 00 00 00 ...
    // OUT: 10 01 0A 0A 00 00 00
    // IN:  11 01 0A 0A 00 [mode] 00 ...
    surfaceMode: {
      key: "surfaceMode",
      kind: "direct",
      priority: 12,
      pendingAck: true,
      plan(patch, nextState, profile) {
        const modeCode = TRANSFORMERS.surfaceModeCode(nextState.surfaceMode);

        const pre = ProtocolCodec.encode({
          iface: "pre",
          feat: FEAT.SETTINGS,
          cmd: 0x1A,
          dataBytes: [0x00, modeCode, 0x00, 0x07],
        });

        const apply = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.SETTINGS,
          cmd: 0x0A,
          dataBytes: [0x00, 0x00, 0x00],
        });

        return [
          {
            rid: pre.rid,
            hex: pre.hex,
            ack: { rid: 0x11, match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.SETTINGS && u8[2] === 0x1A }
          },
          {
            rid: apply.rid,
            hex: apply.hex,
            ack: { rid: 0x11, match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.SETTINGS && u8[2] === 0x0A }
          },
        ];
      },
    },

    // 切换当前激活的 DPI 档位 (0-based index)
    // OMM抓包: OUT 10 01 0D CF [index] 00 00
    activeDpiSlotIndex: {
      key: "activeDpiSlotIndex",
      kind: "direct",
      priority: 30,
      validate(patch, nextState, profile) {
        const maxSlots = profile.capabilities?.dpiSlotMax ?? 5;
        TRANSFORMERS.dpiSlotIndexCode(nextState.activeDpiSlotIndex, maxSlots);
      },
      plan(patch, nextState, profile) {
        const maxSlots = profile.capabilities?.dpiSlotMax ?? 5;
        const slotCode = TRANSFORMERS.dpiSlotIndexCode(nextState.activeDpiSlotIndex, maxSlots);

        const pkt = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.PROFILE,
          cmd: CMDS.DPI_SET_ACTIVE_SLOT,
          dataBytes: [slotCode, 0x00, 0x00],
        });
        return [{ rid: pkt.rid, hex: pkt.hex }];
      },
    },

    // Profile stream aggregator
    dpiProfile: {
      key: "dpiProfile",
      kind: "virtual",
      priority: 20,
      triggers: [
        "pollingHz",
        "pollingWirelessHz",
        "dpiSlots",
        "dpiSlotsX",
        "dpiSlotsY",
        "dpiSlotCount",
        "dpiLods",
        "defaultDpiSlotIndex",
        "bhopMs",
        "buttonMappings",
        "dpiProfile",
      ],
      plan(patch, nextState, profile) {
        const targetSlot = nextState.activeProfileSlotIndex ?? 0;
        return ProtocolCodec.buildProfileStream(nextState, profile, targetSlot);
      },
    },
  });


  // ============================================================
  // 7) Planner: patch -> commands
  // ============================================================
  class CommandPlanner {
    constructor(profile) {
      this.profile = profile || DEFAULT_PROFILE;
    }

    _validatePollingHz(field, hz, allowedRates) {
      const allowed = Array.isArray(allowedRates)
        ? allowedRates.map(Number).filter(Number.isFinite)
        : [];
      const target = Number(hz);

      if (!Number.isFinite(target)) {
        throw new ProtocolError(`${field} must be a valid number`, "BAD_PARAM", { field, value: hz });
      }
      if (!allowed.length) {
        throw new ProtocolError(`${field} allowed list is empty`, "BAD_PARAM", { field, value: target });
      }
      if (!allowed.includes(target)) {
        throw new ProtocolError(`${field} ${target}Hz is not supported`, "BAD_PARAM", {
          field,
          value: target,
          allowed,
        });
      }
      return target;
    }

    _buildNextState(prevState, patch) {
      const next = Object.assign({}, prevState, patch);
      const cap = this.profile?.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const pollingRatesWired = Array.isArray(cap.pollingRatesWired)
        ? cap.pollingRatesWired
        : [125, 250, 500, 1000];
      const pollingRatesWireless = Array.isArray(cap.pollingRatesWireless)
        ? cap.pollingRatesWireless
        : [125, 250, 500, 1000, 2000, 4000, 8000];

      if (patch && Object.prototype.hasOwnProperty.call(patch, "pollingHz")) {
        next.pollingHz = this._validatePollingHz("pollingHz", patch.pollingHz, pollingRatesWired);
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, "pollingWirelessHz")) {
        next.pollingWirelessHz = this._validatePollingHz("pollingWirelessHz", patch.pollingWirelessHz, pollingRatesWireless);
      }

      // DPI Slots (档位值数组)
      const dpiMin = cap.dpiMin ?? 50;
      const dpiMax = cap.dpiMax ?? 26000;
      const normalizeDpiSlots = (raw, fallbackRaw) => {
        const fallback = Array.isArray(fallbackRaw) ? fallbackRaw.slice(0) : [];
        const slots = Array.isArray(raw) ? raw.slice(0) : fallback;
        while (slots.length < maxDpiSlots) slots.push(800);
        if (slots.length > maxDpiSlots) slots.length = maxDpiSlots;
        return slots.map((v, idx) => {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            const fb = Number(fallback[idx] ?? 800);
            return clampInt(Number.isFinite(fb) ? fb : 800, dpiMin, dpiMax);
          }
          return clampInt(n, dpiMin, dpiMax);
        });
      };

      const prevSlotsX = Array.isArray(prevState?.dpiSlotsX)
        ? prevState.dpiSlotsX
        : (Array.isArray(prevState?.dpiSlots) ? prevState.dpiSlots : []);
      const prevSlotsY = Array.isArray(prevState?.dpiSlotsY) ? prevState.dpiSlotsY : prevSlotsX;

      const rawSlotsX = Array.isArray(next.dpiSlotsX)
        ? next.dpiSlotsX
        : (Array.isArray(next.dpiSlots) ? next.dpiSlots : prevSlotsX);
      const rawSlotsY = Array.isArray(next.dpiSlotsY)
        ? next.dpiSlotsY
        : (Array.isArray(next.dpiSlots) ? next.dpiSlots : prevSlotsY);

      next.dpiSlotsX = normalizeDpiSlots(rawSlotsX, prevSlotsX);
      next.dpiSlotsY = normalizeDpiSlots(rawSlotsY, prevSlotsY);
      next.dpiSlots = next.dpiSlotsX.slice(0);

      // DPI LODs (每个DPI档位的LOD设置)
      if (!Array.isArray(next.dpiLods)) {
        next.dpiLods = Array.isArray(prevState?.dpiLods) ? prevState.dpiLods.slice(0) : [];
      }
      while (next.dpiLods.length < maxDpiSlots) next.dpiLods.push("mid");
      if (next.dpiLods.length > maxDpiSlots) next.dpiLods.length = maxDpiSlots;

      // DPI Slot Count (启用的DPI档位数量)
      const dpiSlotCount = clampInt(Number(next.dpiSlotCount ?? maxDpiSlots), 1, maxDpiSlots);
      next.dpiSlotCount = dpiSlotCount;

      // Default DPI Slot Index (默认DPI档位索引, 存储在Profile中, 设备重启后恢复到此档位)
      if ("defaultDpiSlotIndex" in next) {
        next.defaultDpiSlotIndex = clampInt(Number(next.defaultDpiSlotIndex ?? 0), 0, dpiSlotCount - 1);
      } else if (prevState?.defaultDpiSlotIndex != null) {
        next.defaultDpiSlotIndex = clampInt(Number(prevState.defaultDpiSlotIndex), 0, dpiSlotCount - 1);
      } else {
        next.defaultDpiSlotIndex = 0;
      }

      // Active DPI Slot Index (当前激活的DPI档位索引, 实时状态, 通过Feature 0x09读取)
      next.activeDpiSlotIndex = clampInt(Number(next.activeDpiSlotIndex ?? 0), 0, dpiSlotCount - 1);
      next.currentDpi = Array.isArray(next.dpiSlotsX) ? next.dpiSlotsX[next.activeDpiSlotIndex] : next.currentDpi;

      if ("bhopMs" in next) {
        if (next.bhopMs == null) next.bhopMs = 0;
        else next.bhopMs = clampInt(assertFiniteNumber(next.bhopMs, "bhopMs"), 0, 0xffff);
      }

      const rawMappings = ("buttonMappings" in patch) ? patch.buttonMappings : (prevState?.buttonMappings ?? next.buttonMappings);
      next.buttonMappings = normalizeButtonMappings(rawMappings, 6);

      return next;
    }

    _collectSpecKeys(expandedPatch) {
      const keys = new Set();
      for (const k of Object.keys(expandedPatch)) {
        if (SPEC[k]) keys.add(k);
      }
      for (const item of Object.values(SPEC)) {
        if (item.kind !== "virtual") continue;
        const triggers = item.triggers || [];
        if (triggers.some((t) => t in expandedPatch) || (item.key in expandedPatch)) {
          keys.add(item.key);
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

    _dedupeCommands(commands) {
      if (!Array.isArray(commands) || commands.length === 0) return [];
      return commands.slice();
    }

    plan(prevState, externalPayload) {
      if (!isObject(externalPayload)) throw new ProtocolError("plan(): payload must be an object", "BAD_PARAM");

      const patch = normalizePayload(externalPayload);
      const keys = Object.keys(patch);
      if (!keys.length) return { patch: {}, nextState: Object.assign({}, prevState), commands: [], pendingSettingsKeys: [] };

      const nextState = this._buildNextState(prevState, patch);
      const specKeys = this._collectSpecKeys(patch);
      const items = this._topoSort(specKeys);

      for (const item of items) {
        if (typeof item.validate === "function") {
          item.validate(patch, nextState, this.profile);
        }
      }

      const commands = [];
      for (const item of items) {
        if (typeof item.plan === "function") {
          const seq = item.plan(patch, nextState, this.profile);
          if (Array.isArray(seq)) commands.push(...seq);
        }
      }

      const pendingSettingsKeys = items
        .filter((item) => item.pendingAck && (item.key in patch))
        .map((item) => item.key);

      return { patch, nextState, commands: this._dedupeCommands(commands), pendingSettingsKeys };
    }
  }


  // ============================================================
  // 8) Public namespace
  // ============================================================
  const root = (typeof window !== "undefined") ? window : (typeof globalThis !== "undefined" ? globalThis : global);
  const ProtocolApi = (root.ProtocolApi = root.ProtocolApi || {});

  ProtocolApi.LOGITECH_HID = {
    defaultFilters: [
      { vendorId: 0x046d, productId: 0xc54d, usagePage: 0xff00, usage: 0x01 },
      { vendorId: 0x046d, productId: 0xc54d, usagePage: 0xff00, usage: 0x02 },
      { vendorId: 0x046d, productId: 0xc54d, usagePage: 0xff00 },
    ],
    usagePage: 0xff00,
    usageCmd: 0x01,
    usagePre: 0x02,
  };
  ProtocolApi.MOUSE_HID = ProtocolApi.LOGITECH_HID;

  ProtocolApi.resolveMouseDisplayName = function resolveMouseDisplayName(vendorId, productId, productName) {
    const pn = productName ? String(productName) : "";
    if (pn) return pn;
    return vendorId === 0x046d ? "Logitech Device" : "HID Device";
  };

  ProtocolApi.uint8ToVersion = function uint8ToVersion(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? "");
    const major = (n >> 4) & 0x0f;
    const minor = n & 0x0f;
    return `${major}.${minor}`;
  };

  // ============================================================
  // 8.5) Keymap helpers (subset for Logitech button mapping)
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

    // Basic mouse buttons
    add("左键", "mouse", 0x01, 0x0000);
    add("右键", "mouse", 0x02, 0x0000);
    add("中键", "mouse", 0x04, 0x0000);
    add("后退", "mouse", 0x10, 0x0000);
    add("前进", "mouse", 0x08, 0x0000);
    add("无", "mouse", 0x00, 0x0000);
    add("禁止按键", "mouse", 0x07, 0x0000);

    return Object.freeze(actions);
  })();

  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  const KEYMAP_LABEL_ALIASES = Object.freeze({
    left: "左键",
    "left click": "左键",
    right: "右键",
    "right click": "右键",
    middle: "中键",
    "middle click": "中键",
    back: "后退",
    forward: "前进",
    none: "无",
    disable: "禁止按键",
    disabled: "禁止按键",
  });

  const LABEL_TO_PROTOCOL_ACTION = Object.freeze(
    Object.fromEntries(Object.entries(KEYMAP_ACTIONS).map(([label, a]) => [label, { funckey: a.funckey, keycode: a.keycode }]))
  );

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

  ProtocolApi.listKeyActionsByType = function listKeyActionsByType() {
    const buckets = Object.create(null);
    for (const [label, a] of Object.entries(KEYMAP_ACTIONS)) {
      const t = String(a.type || "system");
      if (!buckets[t]) buckets[t] = [];
      buckets[t].push(label);
    }
    return Object.entries(buckets).map(([type, items]) => ({ type, items }));
  };

  function formatOnboardProfileDump(rawData) {
    const u8 = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData || []);
    const get = (i) => (i >= 0 && i < u8.length ? u8[i] : 0);
    const readU16LE = (off) => get(off) | (get(off + 1) << 8);
    const hex2 = (v) => toU8(v).toString(16).padStart(2, "0");
    const hexRange = (off, len) => {
      const out = [];
      for (let i = 0; i < len; i++) out.push(hex2(get(off + i)));
      return out.join(" ");
    };

    const lines = [];
    lines.push("OnboardProfile 0x00..0x3F");
    lines.push(`0x00-0x01 polling: wireless=0x${hex2(get(0x00))}, wired=0x${hex2(get(0x01))}`);

    const DPI_BASE = 0x04;
    const DPI_STRIDE = 5;
    for (let i = 0; i < 5; i++) {
      const base = DPI_BASE + i * DPI_STRIDE;
      const x = readU16LE(base);
      const y = readU16LE(base + 2);
      const flags = get(base + 4);
      const flagBits = flags & 0x03;
      const enabled = flagBits !== 0;
      let lod = "mid";
      if (flagBits === 0x03) lod = "high";
      else if (flagBits === 0x01) lod = "low";
      lines.push(`0x${hex2(base)}-0x${hex2(base + 4)} dpiSlot${i}: x=${x} y=${y} flags=0x${hex2(flags)} enable=${enabled} lod=${lod}`);
    }

    lines.push(`0x20 activeDpiSlotIndex: ${get(0x20)}`);
    lines.push(`0x2C-0x2D bhopMs: ${readU16LE(0x2C)}`);

    const BTN_BASE = 0x30;
    for (let i = 0; i < 5; i++) {
      const base = BTN_BASE + i * 4;
      const bytes = hexRange(base, 4);
      const key = get(base + 3);
      lines.push(`0x${hex2(base)}-0x${hex2(base + 3)} btn${i + 1}: ${bytes} (key=0x${hex2(key)})`);
    }

    return lines.join("\n");
  }

  ProtocolApi.dumpOnboardProfile = function dumpOnboardProfile(rawData) {
    return formatOnboardProfileDump(rawData);
  };

  // ============================================================
  // 9) API: MouseMouseHidApi (Logitech HID++)
  // ============================================================
  class MouseMouseHidApi {
    constructor({ profile = DEFAULT_PROFILE } = {}) {
      this._profile = profile;
      this._planner = new CommandPlanner(this._profile);
      this._device = null;
      this._driver = new UniversalHidDriver();
      this._driver.defaultInterCmdDelayMs = this._profile.timings.interCmdDelayMs ?? 12;
      this._opQueue = new SendQueue();
      this._onConfigCbs = [];
      this._onBatteryCbs = [];
      this._onRawReportCbs = [];
      this._cfg = this._makeDefaultCfg();
      this._boundInputHandler = null;
      this._pendingSettingsKeys = [];
      this._trackedActiveDpiSlotIndex = null;
      this._deviceNameQuerySupported = null;
    }

    set device(dev) {
      const nextDevice = dev || null;
      if (this._device !== nextDevice) this._deviceNameQuerySupported = null;
      this._device = nextDevice;
      this._driver.setDevice(this._device);
    }
    get device() {
      return this._device;
    }

    get capabilities() {
      const cap = this._profile?.capabilities ?? {};
      return JSON.parse(JSON.stringify(cap));
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

    async _refreshStateSafe() {
      try {
        const updates = await this._readDeviceStateSnapshot();
        if (updates && Object.keys(updates).length) {
          this._cfg = Object.assign({}, this._cfg, updates);
        }
        this._emitConfig();
        if (updates && ("batteryPercent" in updates)) {
          this._emitBattery({
            batteryPercent: Number.isFinite(Number(updates.batteryPercent)) ? Number(updates.batteryPercent) : -1,
            batteryIsCharging: !!updates.batteryIsCharging,
          });
        }
      } catch (e) {
        console.warn("[Logitech] State refresh failed", e);
      }
    }

    async open() {
      if (!this.device) throw new ProtocolError("open() 缺少有效的 hidApi.device", "NO_DEVICE");

      const ensureBound = () => {
        if (this._boundInputHandler) return;
        this._boundInputHandler = (evt) => {
          try {
            const reportId = evt?.reportId;
            const dataView = evt?.data;
            const u8 = dataView ? new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength) : null;

            // Ignore keep-alive packets
            if (u8 && u8.length >= 3 && u8[0] === 0x01 && u8[1] === 0x0D && u8[2] === 0x2F) return;

            if (u8 && u8.length) this._handleInputReport(Number(reportId), u8);
            if (this._onRawReportCbs.length) {
              for (const cb of this._onRawReportCbs) cb({ reportId, data: u8, event: evt });
            }
          } catch {}
        };
        try { this.device.addEventListener("inputreport", this._boundInputHandler); } catch {}
      };

      if (this.device.opened) {
        ensureBound();
        await this._refreshStateSafe();
        return;
      }

      try {
        await this.device.open();
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("already open")) {
          try { await this.device.close(); } catch {}
          await sleep(100);
          await this.device.open();
          ensureBound();
          await this._refreshStateSafe();
          return;
        }
        throw new ProtocolError(`设备打开失败: ${msg}`, "OPEN_FAIL");
      }

      ensureBound();
      await this._refreshStateSafe();
    }

    async close(opts = {}) {
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

    async requestConfig() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestConfig() ?????? hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const updates = await this._readDeviceStateSnapshot();
        if (updates && Object.keys(updates).length) {
          this._cfg = Object.assign({}, this._cfg, updates);
        }
        this._emitConfig();
      });
    }

    async requestConfiguration() { return this.requestConfig(); }
    async getConfig() { return this.requestConfig(); }
    async readConfig() { return this.requestConfig(); }
    async requestDeviceConfig() { return this.requestConfig(); }
    dumpOnboardProfile(rawData) { return formatOnboardProfileDump(rawData); }

    async requestBattery() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestBattery() ?????? hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        let percent = Number(this._cfg?.batteryPercent);
        let isCharging = !!this._cfg?.batteryIsCharging;

        try {
          const updates = await this._readBatterySnapshot();
          if (updates && Object.keys(updates).length) {
            this._cfg = Object.assign({}, this._cfg, updates);
            percent = Number(this._cfg?.batteryPercent);
            isCharging = !!this._cfg?.batteryIsCharging;
          }
        } catch (e) {
          console.warn("[Logitech] 电量请求失败", e);
        }

        if (!Number.isFinite(percent)) percent = -1;
        this._emitBattery({ batteryPercent: percent, batteryIsCharging: isCharging });
      });
    }

    async sendPacket(packet) {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("sendPacket() ?????? hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();
        const { rid, hex } = ProtocolCodec.encode(packet || {});
        await this._driver.sendHex(rid, hex);
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

        const { patch, nextState, commands, pendingSettingsKeys } = this._planner.plan(this._cfg, externalPayload);
        this._pendingSettingsKeys = Array.isArray(pendingSettingsKeys) ? pendingSettingsKeys.slice() : [];

        await this._driver.runSequence(commands);

        this._cfg = Object.assign({}, this._cfg, nextState);
        this._emitConfig();
        return { patch, commands };
      });
    }

    async setDpi(slot, value, opts = {}) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const s = clampInt(assertFiniteNumber(slot, "slot"), 1, maxDpiSlots);
      const valueObj = (value && typeof value === "object") ? value : null;
      const dpiX = clampInt(
        assertFiniteNumber(valueObj ? (valueObj.x ?? valueObj.X ?? valueObj.y ?? valueObj.Y) : value, "dpiX"),
        cap.dpiMin ?? 50,
        cap.dpiMax ?? 26000
      );
      const dpiY = clampInt(
        assertFiniteNumber(valueObj ? (valueObj.y ?? valueObj.Y ?? dpiX) : dpiX, "dpiY"),
        cap.dpiMin ?? 50,
        cap.dpiMax ?? 26000
      );

      const baseX = Array.isArray(this._cfg.dpiSlotsX)
        ? this._cfg.dpiSlotsX
        : (Array.isArray(this._cfg.dpiSlots) ? this._cfg.dpiSlots : []);
      const baseY = Array.isArray(this._cfg.dpiSlotsY) ? this._cfg.dpiSlotsY : baseX;
      const nextSlotsX = Array.isArray(baseX) ? [...baseX] : [];
      const nextSlotsY = Array.isArray(baseY) ? [...baseY] : [];
      while (nextSlotsX.length < maxDpiSlots) nextSlotsX.push(800);
      while (nextSlotsY.length < maxDpiSlots) nextSlotsY.push(800);
      nextSlotsX[s - 1] = dpiX;
      nextSlotsY[s - 1] = dpiY;

      const patch = {
        dpiSlotsX: nextSlotsX,
        dpiSlotsY: nextSlotsY,
        dpiSlots: nextSlotsX.slice(0),
      };
      if (opts && opts.select) patch.activeDpiSlotIndex = s - 1;

      await this.setBatchFeatures(patch);
    }

    async setDpiSlotCount(n) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const count = clampInt(assertFiniteNumber(n, "dpiSlotCount"), 1, maxDpiSlots);
      await this.setBatchFeatures({ dpiSlotCount: count });
    }

    async setSlotCount(n) {
      return this.setDpiSlotCount(n);
    }

    async setActiveDpiSlotIndex(index) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const idx = clampInt(assertFiniteNumber(index, "index"), 0, maxDpiSlots - 1);
      this._trackedActiveDpiSlotIndex = idx; // 本地跟踪
      await this.setBatchFeatures({ activeDpiSlotIndex: idx });
    }

    async setCurrentDpiIndex(index) {
      return this.setActiveDpiSlotIndex(index);
    }

    async setButtonMappingBySelect(btnId, labelOrObj) {
      const b = clampInt(assertFiniteNumber(btnId, "btnId"), 1, 6);

      let action;
      if (typeof labelOrObj === "string") {
        const raw = labelOrObj.trim();
        const alias = KEYMAP_LABEL_ALIASES[raw.toLowerCase()] || raw;
        action = LABEL_TO_PROTOCOL_ACTION[alias];
        if (!action) throw new ProtocolError(`未知的按键动作: ${labelOrObj}`, "BAD_PARAM");
      } else if (isObject(labelOrObj)) {
        action = {
          funckey: Number(labelOrObj.funckey ?? labelOrObj.func ?? 0),
          keycode: Number(labelOrObj.keycode ?? labelOrObj.code ?? 0),
        };
      } else {
        throw new ProtocolError("不支持的参数类型，必须为 label 或对象", "BAD_PARAM");
      }

      const next = Array.isArray(this._cfg.buttonMappings) ? this._cfg.buttonMappings.slice(0) : [];
      while (next.length < 6) next.push({ funckey: 0, keycode: 0 });
      next[b - 1] = { funckey: toU8(action.funckey), keycode: clampInt(action.keycode ?? 0, 0, 0xffff) };

      await this.setBatchFeatures({ buttonMappings: next });
    }

    async setLightforceSwitch(mode) {
      await this.setBatchFeatures({ lightforceSwitch: mode });
    }

    async setSurfaceMode(mode) {
      await this.setBatchFeatures({ surfaceMode: mode });
    }

    // 切换当前激活的DPI档位 (实时生效，通过 0xCF 命令)
    async setActiveDpiSlot(slot) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const s = clampInt(assertFiniteNumber(slot, "slot"), 1, maxDpiSlots);
      this._trackedActiveDpiSlotIndex = s - 1; // 本地跟踪 (转为0-based)
      await this.setBatchFeatures({ activeDpiSlotIndex: s - 1 });
    }

    // 设置默认DPI档位索引 (存储到Profile，设备重启后恢复到此档位)
    // index: 0-based (0~4)
    async setDefaultDpiSlotIndex(index) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const idx = clampInt(assertFiniteNumber(index, "index"), 0, maxDpiSlots - 1);
      await this.setBatchFeatures({ defaultDpiSlotIndex: idx });
    }

    // 设置默认DPI档位 (1-based slot number，便于用户使用)
    // slot: 1-based (1~5)
    async setDefaultDpiSlot(slot) {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const s = clampInt(assertFiniteNumber(slot, "slot"), 1, maxDpiSlots);
      await this.setBatchFeatures({ defaultDpiSlotIndex: s - 1 });
    }

    // 获取默认DPI档位索引 (从当前配置状态读取)
    getDefaultDpiSlotIndex() {
      return this._cfg?.defaultDpiSlotIndex ?? 0;
    }

    // 获取当前激活DPI档位索引 (从当前配置状态读取)
    getActiveDpiSlotIndex() {
      return this._cfg?.activeDpiSlotIndex ?? 0;
    }

    // ============================================================
    // Profile Slot API (板载配置槽位)
    // ============================================================

    // 获取当前激活的 Profile Slot 索引 (0-based)
    async getActiveProfileSlot() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("getActiveProfileSlot() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();
        return await this.getActiveProfileSlotIndex();
      });
    }

    // 切换激活的 Profile Slot (0-based index, 0~4)
    // GHUB抓包: OUT 10 01 0D 3B 00 [slot_1based] 00
    async setActiveProfileSlot(index) {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("setActiveProfileSlot() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const slotIndex = clampInt(assertFiniteNumber(index, "profileSlotIndex"), 0, 4);
        const slotId = slotIndex + 1; // 设备使用 1-based (0x01 ~ 0x05)

        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.PROFILE,
          cmd: CMDS.PROFILE_SET_ACTIVE_SLOT,
          dataBytes: [0x00, slotId, 0x00],
        });

        const ack = {
          rid: REPORTS.PRE,
          match: (u8) => u8.length > 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.PROFILE_SET_ACTIVE_SLOT
        };

        await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });

        this._cfg.activeProfileSlotIndex = slotIndex;
        await this._refreshStateSafe();
      });
    }

    // 读取指定 Profile Slot 的配置 (不切换激活状态)
    async readProfileSlot(index) {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("readProfileSlot() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const slotIndex = clampInt(assertFiniteNumber(index, "profileSlotIndex"), 0, 4);
        const profileData = await this._readOnboardProfileRaw(slotIndex);
        const parsed = this._parseOnboardProfile(profileData);
        parsed.profileSlotIndex = slotIndex;
        return parsed;
      });
    }

    // 获取所有 Profile Slot 的配置摘要 (最多5个)
    async getAllProfileSlots() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("getAllProfileSlots() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const slots = [];
        for (let i = 0; i < 5; i++) {
          try {
            const profileData = await this._readOnboardProfileRaw(i);
            const parsed = this._parseOnboardProfile(profileData);
            parsed.profileSlotIndex = i;
            slots.push(parsed);
          } catch (e) {
            console.warn(`[Logitech] 读取 Profile Slot ${i} 失败`, e);
            slots.push({ profileSlotIndex: i, error: String(e?.message || e) });
          }
        }

        const activeIndex = await this.getActiveProfileSlotIndex();
        return {
          activeProfileSlotIndex: activeIndex,
          slots
        };
      });
    }

    // ============================================================
    // Onboard Memory Mode API (板载内存模式)
    // ============================================================

    // 获取当前板载内存模式状态
    // 抓包: OUT 10 01 0D 2E 00 00 00 -> IN 11 01 0D 2E [mode] 00 00
    // WebHID data: 01 0D 2E [mode] 00 00 (不含Report ID 0x11)
    // mode: 0x01=板载模式, 0x02=软件模式
    async getOnboardMemoryMode() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("getOnboardMemoryMode() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.PROFILE,
          cmd: CMDS.GET_ONBOARD_MODE,
          dataBytes: [0x00, 0x00, 0x00],
        });

        const ack = {
          rid: REPORTS.PRE,
          // WebHID data: [0]=0x01, [1]=feat, [2]=cmd, [3]=mode
          match: (u8) => u8.length > 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.GET_ONBOARD_MODE
        };

        try {
          const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
          if (res && res.length > 3) {
            const modeCode = res[3];
            // 0x01 = 板载模式, 0x02 = 软件模式
            const isOnboard = modeCode === 0x01;
            this._cfg.onboardMemoryMode = isOnboard;
            return isOnboard;
          }
        } catch (e) {
          console.warn("[Logitech] 获取板载内存模式失败", e);
        }
        return this._cfg?.onboardMemoryMode ?? true;
      });
    }

    // 设置板载内存模式
    // 抓包: OUT 10 01 0D 1E [mode] 00 00
    // WebHID data: 01 0D 1E 00 00 00 (ACK, 不含Report ID 0x11)
    // mode: 0x01=开启板载模式, 0x02=开启软件模式
    async setOnboardMemoryMode(enabled) {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("setOnboardMemoryMode() 缺少有效的 hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const modeCode = enabled ? 0x01 : 0x02;

        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.PROFILE,
          cmd: CMDS.SET_ONBOARD_MODE,
          dataBytes: [modeCode, 0x00, 0x00],
        });

        const ack = {
          rid: REPORTS.PRE,
          // WebHID data: [0]=0x01, [1]=feat, [2]=cmd
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.SET_ONBOARD_MODE
        };

        await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });

        this._cfg.onboardMemoryMode = enabled;
        this._emitConfig();

        // 切换模式后刷新设备状态
        if (enabled) {
          await this._refreshStateSafe();
        }

        return enabled;
      });
    }

    // 切换板载内存模式 (便捷方法)
    async toggleOnboardMemoryMode() {
      const current = this._cfg?.onboardMemoryMode ?? true;
      return await this.setOnboardMemoryMode(!current);
    }

    async readState({ emit = true } = {}) {
      return this._opQueue.enqueue(async () => {
        if (!this.device || !this.device.opened) return this._cfg;

        const updates = await this._readDeviceStateSnapshot();
        if (updates && Object.keys(updates).length) {
          this._cfg = Object.assign({}, this._cfg, updates);
        }
        if (emit) {
          this._emitConfig();
          if (updates && ("batteryPercent" in updates)) {
            this._emitBattery({
              batteryPercent: Number.isFinite(Number(updates.batteryPercent)) ? Number(updates.batteryPercent) : -1,
              batteryIsCharging: !!updates.batteryIsCharging,
            });
          }
        }
        return this._cfg;
      });
    }

    // [修正] 读取当前激活的板载配置槽位索引 (0-based, 0~4)
    // GHUB抓包: OUT 10 01 0D 4B 00 00 00 -> IN 11 01 0D 4B 00 [slot_1based] 00
    async getActiveProfileSlotIndex() {
      const packet = ProtocolCodec.encode({
        iface: "cmd",
        feat: FEAT.PROFILE,
        cmd: CMDS.GET_ACTIVE_PROFILE_SLOT,
        dataBytes: [0x00, 0x00, 0x00],
      });

      const ack = {
        rid: REPORTS.PRE,
        match: (u8) => u8.length > 4 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.GET_ACTIVE_PROFILE_SLOT
      };

      try {
        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
        if (res && res.length > 4) {
          const slotId = res[4]; // 1-based (0x01 ~ 0x05)
          return clampInt(slotId - 1, 0, 4);
        }
      } catch (e) {
        console.warn("[Logitech] 获取激活槽位失败，默认使用 Slot 0", e);
      }
      return 0;
    }

    // [修正] 读取性能配置 (Lightforce & Surface)
    async getPerformanceConfig() {
      const packet = ProtocolCodec.encode({
        iface: "cmd",
        feat: FEAT.SETTINGS,
        cmd: 0x0A,
        dataBytes: [0x00, 0x00, 0x00],
      });

      const ack = {
        rid: REPORTS.PRE,
        match: (u8) => u8.length > 4 && u8[0] === 0x01 && u8[1] === FEAT.SETTINGS && u8[2] === 0x0A
      };

      const result = {};
      try {
        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
        // 响应: 11 01 0A 0A 00 [mode] 00
        // WebHID: [0]=01, [1]=0A, [2]=0A, [3]=00(err), [4]=mode
        if (res && res.length > 4) {
          const configByte = res[4];

          // 根据抓包分析:
          // Lightforce: 0x00=Optical, 0x01=Hybrid
          // Surface: 0x00=Auto, 0x02=On, 0x04=Off
          // 这两个功能可能是独立存储的，需要根据实际设备行为判断

          // 暂时按位解析（如果设备返回组合值）
          // 或者按单值解析（如果设备只返回最后设置的值）
          if (configByte === 0x00) {
            result.lightforceSwitch = "optical";
            result.surfaceMode = "auto";
          } else if (configByte === 0x01) {
            result.lightforceSwitch = "hybrid";
          } else if (configByte === 0x02) {
            result.surfaceMode = "on";
          } else if (configByte === 0x04) {
            result.surfaceMode = "off";
          } else {
            // 组合值解析
            result.lightforceSwitch = (configByte & 0x01) ? "hybrid" : "optical";
            const surfaceBits = configByte & 0x06;
            if (surfaceBits === 0x02) result.surfaceMode = "on";
            else if (surfaceBits === 0x04) result.surfaceMode = "off";
            else result.surfaceMode = "auto";
          }
        }
      } catch (e) {
        console.warn("[Logitech] 获取性能配置失败", e);
      }
      return result;
    }

    async _readDeviceNameSnapshot() {
      const updates = {};
      const fallbackName = ProtocolApi.resolveMouseDisplayName(
        this.device?.vendorId,
        this.device?.productId,
        this.device?.productName || ""
      );

      if (this._deviceNameQuerySupported === false) {
        if (fallbackName) updates.deviceName = fallbackName;
        return updates;
      }

      try {
        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.DEVICE_INFO,
          cmd: 0x1F,
          dataBytes: [0x00, 0x00, 0x00],
        });

        const ack = {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 4 && u8[0] === 0x01 && u8[1] === FEAT.DEVICE_INFO && u8[2] === 0x1F,
        };

        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
        this._deviceNameQuerySupported = true;

        if (res && res.length >= 4) {
          const bytes = Array.from(res.slice(3));
          const nulPos = bytes.indexOf(0x00);
          const rawNameBytes = nulPos >= 0 ? bytes.slice(0, nulPos) : bytes;
          const decodedName = rawNameBytes.map((b) => String.fromCharCode(toU8(b))).join("").trim();
          if (decodedName) {
            updates.deviceName = decodedName;
            return updates;
          }
        }
      } catch (_) {
        this._deviceNameQuerySupported = false;
      }

      if (fallbackName) updates.deviceName = fallbackName;
      return updates;
    }

    async _readBatterySnapshot() {
      const updates = {};
      try {
        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.BATTERY,
          cmd: 0x1F,
          dataBytes: [0x00, 0x00, 0x00],
        });

        const ack = {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.BATTERY && u8[2] === 0x1F,
        };

        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });

        if (res && res.length >= 5) {
          const level = toU8(res[3]);
          const status = toU8(res[4]);
          const isCharging = status === 0x01;
          updates.battery = { level, status, isCharging };
          updates.batteryPercent = level;
          updates.batteryIsCharging = isCharging;
        }
      } catch (e) {
        console.warn("[Logitech] 电量读取失败", e);
      }
      return updates;
    }

    async _readDeviceStateSnapshot() {
      const updates = {};

      // 1. 读取设备名称
      const nameSnapshot = await this._readDeviceNameSnapshot();
      if (nameSnapshot && Object.keys(nameSnapshot).length) Object.assign(updates, nameSnapshot);

      // 2. 读取电量
      const battery = await this._readBatterySnapshot();
      if (battery && Object.keys(battery).length) Object.assign(updates, battery);

      // 3. 读取回报率
      try {
        const packet = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.REPORT_RATE,
          cmd: 0x01,
          dataBytes: [0x00, 0x00, 0x00],
        });
        const ack = {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 3 && u8[0] === 0x01 && u8[1] === FEAT.REPORT_RATE && u8[2] === 0x01,
        };
        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
        if (res && res.length >= 4) {
          updates.pollingHz = TRANSFORMERS.pollingHzFromCode(res[3]);
        }
      } catch (e) {
        console.warn("[Logitech] 读取回报率失败", e);
      }

      // 4. 读取板载内存模式状态
      try {
        const modePacket = ProtocolCodec.encode({
          iface: "cmd",
          feat: FEAT.PROFILE,
          cmd: CMDS.GET_ONBOARD_MODE,
          dataBytes: [0x00, 0x00, 0x00],
        });
        const modeAck = {
          rid: REPORTS.PRE,
          // WebHID data: [0]=0x01, [1]=feat, [2]=cmd, [3]=mode
          match: (u8) => u8.length > 3 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === CMDS.GET_ONBOARD_MODE
        };
        const modeRes = await this._driver.sendAndWait({ rid: modePacket.rid, hex: modePacket.hex, ack: modeAck });
        if (modeRes && modeRes.length > 3) {
          const modeCode = modeRes[3];
          updates.onboardMemoryMode = modeCode === 0x01;
        }
      } catch (e) {
        console.warn("[Logitech] 读取板载内存模式失败", e);
      }

      // 5. 动态读取板载配置与性能设置
      try {
        // 先读取 Profile Slot 启用状态
        const slotStates = await this._readProfileSlotStates();
        if (slotStates) {
          updates.profileSlotStates = slotStates.states;
          updates.enabledProfileSlotCount = slotStates.enabledCount;
        }

        const activeProfileSlotIndex = await this.getActiveProfileSlotIndex();
        const profileData = await this._readOnboardProfileRaw(activeProfileSlotIndex);
        const parsed = this._parseOnboardProfile(profileData);
        parsed.activeProfileSlotIndex = activeProfileSlotIndex;
        Object.assign(updates, parsed);

        const perfConfig = await this.getPerformanceConfig();
        Object.assign(updates, perfConfig);

        const dpiStatus = await this._readActiveDpiSlotFromDevice();
        if (dpiStatus) {
          updates.activeDpiSlotIndex = dpiStatus.activeDpiSlotIndex;
          updates.currentDpi = dpiStatus.currentDpi;
        }
      } catch (e) {
        console.warn("[Logitech] 读取板载/性能配置失败", e);
      }

      return updates;
    }

    // [新增方法] 读取 Profile Slot 启用状态
    // 抓包分析: OUT 11 01 0D 5F 00 00 00 00 10 -> IN 11 01 0D 5F 00 01 01 FF 00 02 01 FF 00 03 [enabled] FF 00 04 00 FF
    // 每个槽位格式: [00] [SlotId] [Enabled: 01=启用, 00=禁用] [FF]
    async _readProfileSlotStates() {
      try {
        const packet = ProtocolCodec.encode({
          iface: "pre",
          feat: FEAT.PROFILE,
          cmd: 0x5F,
          dataBytes: [0x00, 0x00, 0x00, 0x00, 0x10],
        });
        const ack = {
          rid: REPORTS.PRE,
          match: (u8) => u8.length >= 4 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === 0x5F,
        };
        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });

        if (res && res.length >= 16) {
          // 解析响应数据 (从 res[3] 开始):
          // 00 01 01 FF 00 02 01 FF 00 03 XX FF 00 04 XX FF
          // Slot 1: res[3]=00, res[4]=01, res[5]=enabled, res[6]=FF
          // Slot 2: res[7]=00, res[8]=02, res[9]=enabled, res[10]=FF
          // Slot 3: res[11]=00, res[12]=03, res[13]=enabled, res[14]=FF
          // Slot 4: res[15]=00, res[16]=04, res[17]=enabled, res[18]=FF
          const states = [];
          let enabledCount = 0;

          for (let i = 0; i < 5; i++) {
            const slotOffset = 3 + i * 4 + 2; // +2 跳过 [00] [SlotId]
            if (slotOffset >= res.length) {
              states.push(false);
              continue;
            }
            const enabled = res[slotOffset] === 0x01;
            states.push(enabled);
            if (enabled) enabledCount++;
          }

          return {
            states,
            enabledCount,
          };
        }
      } catch (e) {
        console.warn("[Logitech] 读取 Profile Slot 状态失败", e);
      }
      return null;
    }

    // [修正方法] 读取板载配置原始数据 (256 bytes)
    // 抓包格式: OUT 11 01 0D 5F 00 [ProfileId] 00 [Offset] 10
    async _readOnboardProfileRaw(profileIndex = 0) {
      const chunks = [];
      const CHUNK_SIZE = 16;
      const TOTAL_CHUNKS = 16;
      const offsets = [];
      for (let i = 0; i < TOTAL_CHUNKS - 1; i++) {
        offsets.push(i * CHUNK_SIZE);
      }
      // Match GHUB captures: last chunk uses 0xEF (not 0xF0) for tail data/CRC.
      offsets.push(0xEF);
      const profileId = profileIndex + 1; // 设备使用 1-based

      for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i];
        try {
          const packet = ProtocolCodec.encode({
            iface: "pre",
            feat: FEAT.PROFILE,
            cmd: 0x5F,
            dataBytes: [0x00, profileId, 0x00, offset, 0x10],
          });
          const ack = {
            rid: REPORTS.PRE,
            match: (u8) => u8.length >= 4 && u8[0] === 0x01 && u8[1] === FEAT.PROFILE && u8[2] === 0x5F,
          };
          const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });
          if (res && res.length >= 19) {
            chunks.push(Array.from(res.slice(3, 19)));
          } else {
            chunks.push(new Array(16).fill(0));
          }
        } catch (e) {
          console.warn(`[Logitech] 读取 Profile chunk ${i} 失败`, e);
          chunks.push(new Array(16).fill(0));
        }
      }

      const rawData = new Uint8Array(256);
      for (let i = 0; i < chunks.length && i < offsets.length; i++) {
        rawData.set(chunks[i], offsets[i]);
      }

      return rawData;
    }

    // [修正方法] 解析板载配置数据
    _parseOnboardProfile(rawData) {
      const readU16LE = (offset) => rawData[offset] | (rawData[offset + 1] << 8);

      // 解析回报率 (Chunk 0, Byte 0-1)
      const pollingWirelessCode = rawData[0];
      const pollingWiredCode = rawData[1];

      // 解析默认DPI档位索引 (Chunk 0, Byte 2) - 设备重启后恢复到此档位
      const defaultDpiSlotIndexRaw = rawData[2];

      // 解析 DPI Slots
      const dpiSlotsX = [];
      const dpiSlotsY = [];
      const dpiLods = [];
      let lastValidIndex = -1;

      const DPI_BASE = 4;
      const DPI_STRIDE = 5;

      for (let i = 0; i < 5; i++) {
        const base = DPI_BASE + i * DPI_STRIDE;
        if (base + 4 >= rawData.length) break;

        const dpiX = readU16LE(base);
        const dpiY = readU16LE(base + 2);
        const flags = rawData[base + 4];

        // 1. 只要 X/Y 任一轴 > 0，就更新有效档位索引（用于计算 dpiSlotCount）
        if (dpiX > 0 || dpiY > 0) {
            lastValidIndex = i;
        }

        // 2. X/Y 双轴读回，Y 缺省时回退到 X
        const xVal = dpiX > 0 ? dpiX : 800;
        const yVal = dpiY > 0 ? dpiY : xVal;
        dpiSlotsX.push(xVal);
        dpiSlotsY.push(yVal);

        // 3. 解析 LOD
        const flagBits = flags & 0x03;
        let lod = "mid";
        if (flagBits === 0x03) lod = "high";
        else if (flagBits === 0x01) lod = "low";
        dpiLods.push(lod);
      }

      // 4. 计算当前启用的DPI档位数量
      const dpiSlotCount = lastValidIndex >= 0 ? (lastValidIndex + 1) : 1;

      // 5. 解析默认DPI档位索引 (存储在Profile Chunk 0, Byte 2)
      const defaultDpiSlotIndex = clampInt(Number(defaultDpiSlotIndexRaw), 0, dpiSlotCount - 1);

      // 6. 当前激活DPI档位索引 (将通过 Feature 0x09 实时查询覆盖)
      // 这里先用默认值，后续 _readDeviceStateSnapshot 会用实时值覆盖
      const activeDpiSlotIndex = defaultDpiSlotIndex;

      // 解析按键映射
      const buttonMappings = [];
      const BTN_OFFSET = 0x30; // Chunk 3

      for (let i = 0; i < 5; i++) {
        const base = BTN_OFFSET + i * 4;
        if (base + 3 >= rawData.length) break;

        const type = rawData[base];
        const subType = rawData[base + 1];
        const param2 = rawData[base + 3]; // FuncKey

        // 按键映射格式: 0x80 0x01 0x00 [FuncKey]
        if (type === 0x80 && subType === 0x01) {
          buttonMappings.push({ funckey: param2, keycode: 0 });
        } else {
          buttonMappings.push({ funckey: 0, keycode: 0 });
        }
      }
      while (buttonMappings.length < 6) {
        buttonMappings.push({ funckey: 0, keycode: 0 });
      }

      // 解析 BHOP (Chunk 2, Offset 0x25)
      const bhopRaw = rawData[0x25];
      const bhopMs = bhopRaw * 10;

      // 7. 返回结果
      return {
        pollingWirelessHz: this._pollingHzFromCode(pollingWirelessCode),
        pollingHz: this._pollingHzFromCode(pollingWiredCode),
        dpiSlots: dpiSlotsX.slice(0),
        dpiSlotsX,
        dpiSlotsY,
        dpiLods,
        dpiSlotCount,
        defaultDpiSlotIndex,  // 默认DPI档位 (存储在Profile中)
        activeDpiSlotIndex,   // 当前激活DPI档位 (将被实时查询覆盖)
        currentDpi: dpiSlotsX[activeDpiSlotIndex] ?? 800,
        buttonMappings,
        bhopMs
      };
    }

    // [新增辅助方法] 回报率代码转换
    _pollingHzFromCode(code) {
      const map = {
        0x00: 125,
        0x01: 250,
        0x02: 500,
        0x03: 1000,
        0x04: 2000,
        0x05: 4000,
        0x06: 8000
      };
      return map[code] || 1000;
    }

    // [新增辅助方法] LOD 代码转换
    _lodFromCode(code) {
      if (code === 0x03) return "high";
      if (code === 0x01) return "low";
      return "mid";
    }

    // 读取当前激活的DPI档位 (Feature 0x09, Cmd 0x5F)
    async _readActiveDpiSlotFromDevice() {
      const packet = ProtocolCodec.encode({
        iface: "cmd",
        feat: FEAT.DPI,
        cmd: 0x5F,
        dataBytes: [0x00, 0x00, 0x00],
      });

      const ack = {
        rid: REPORTS.PRE,
        match: (u8) => u8.length >= 5 && u8[0] === 0x01 && u8[1] === FEAT.DPI && u8[2] === 0x5F
      };

      try {
        const res = await this._driver.sendAndWait({ rid: packet.rid, hex: packet.hex, ack });

        if (res && res.length >= 6) {
          const currentDpiHigh = res[4];
          const currentDpiLow = res[5];
          const currentDpi = (currentDpiHigh << 8) | currentDpiLow;

          let activeDpiSlotIndex = 0;
          const dpiSlots = this._cfg?.dpiSlotsX || this._cfg?.dpiSlots;
          if (Array.isArray(dpiSlots) && dpiSlots.length > 0) {
            // 查找最后一个匹配的slot（因为用户可能从后往前设置相同DPI）
            // 如果有本地跟踪的slot索引且DPI匹配，优先使用
            const trackedIndex = this._trackedActiveDpiSlotIndex;
            if (trackedIndex != null && trackedIndex >= 0 && trackedIndex < dpiSlots.length) {
              if (dpiSlots[trackedIndex] === currentDpi) {
                activeDpiSlotIndex = trackedIndex;
              } else {
                // 本地跟踪的slot DPI不匹配，说明设备状态已改变，重新匹配
                for (let i = 0; i < dpiSlots.length; i++) {
                  if (dpiSlots[i] === currentDpi) {
                    activeDpiSlotIndex = i;
                    break;
                  }
                }
              }
            } else {
              // 没有本地跟踪，使用第一个匹配的slot
              for (let i = 0; i < dpiSlots.length; i++) {
                if (dpiSlots[i] === currentDpi) {
                  activeDpiSlotIndex = i;
                  break;
                }
              }
            }
          }

          return {
            currentDpi,
            activeDpiSlotIndex,
          };
        }
      } catch (e) {
        console.warn("[Logitech] 读取当前DPI状态失败", e);
      }

      return null;
    }

    _handleInputReport(reportId, u8) {
      if (Number(reportId) !== REPORTS.PRE || !u8 || u8.length < 6) return;
      if (u8[0] !== 0x01) return;
      const group = u8[1];
      const cmd = u8[2];

      // 处理 0x0A 命令响应 (Apply 后的确认)
      if (group === FEAT.SETTINGS && cmd === 0x0A) {
        const modeCode = u8[4];
        const key = this._pendingSettingsKeys.length ? this._pendingSettingsKeys.shift() : null;
        if (!this._cfg) return;

        if (key === "lightforceSwitch") {
          const mode = TRANSFORMERS.lightforceSwitchFromCode(modeCode);
          if (mode) {
            this._cfg.lightforceSwitch = mode;
            this._emitConfig();
          }
        } else if (key === "surfaceMode") {
          const mode = TRANSFORMERS.surfaceModeFromCode(modeCode);
          this._cfg.surfaceMode = mode;
          this._emitConfig();
        }
      }
    }

    _makeDefaultCfg() {
      const cap = this._profile.capabilities || {};
      const maxDpiSlots = clampInt(cap.dpiSlotMax ?? 5, 1, 10);
      const pollingRatesWired = (Array.isArray(cap.pollingRatesWired) ? cap.pollingRatesWired : [])
        .map(Number)
        .filter(Number.isFinite);
      const pollingRatesWireless = (Array.isArray(cap.pollingRatesWireless) ? cap.pollingRatesWireless : [])
        .map(Number)
        .filter(Number.isFinite);
      const wiredRates = pollingRatesWired.length ? pollingRatesWired : [125, 250, 500, 1000];
      const wirelessRates = pollingRatesWireless.length
        ? pollingRatesWireless
        : [125, 250, 500, 1000, 2000, 4000, 8000];

      const dpiSlots = [2300, 800, 1600, 2400, 3200].slice(0, maxDpiSlots);
      while (dpiSlots.length < maxDpiSlots) dpiSlots.push(800);
      const dpiSlotsX = dpiSlots.slice(0);
      const dpiSlotsY = dpiSlots.slice(0);

      const buttonMappings = [
        { funckey: 0x01, keycode: 0x0000 },
        { funckey: 0x02, keycode: 0x0000 },
        { funckey: 0x04, keycode: 0x0000 },
        { funckey: 0x10, keycode: 0x0000 },
        { funckey: 0x08, keycode: 0x0000 },
        { funckey: 0x00, keycode: 0x0000 },
      ];

      return {
        capabilities: {
          dpiSlotCount: maxDpiSlots,
          maxDpi: cap.dpiMax ?? 26000,
          pollingRatesWired: [...wiredRates],
          pollingRatesWireless: [...wirelessRates],
        },
        deviceName: "",

        lightforceSwitch: "optical",
        surfaceMode: "auto",

        pollingHz: wiredRates[0] ?? 125,
        pollingWirelessHz: wirelessRates[wirelessRates.length - 1] ?? 8000,

        // DPI Slot 相关 (档位)
        dpiSlots,
        dpiSlotsX,
        dpiSlotsY,
        dpiLods: Array.from({ length: maxDpiSlots }, () => "mid"),
        dpiSlotCount: Math.min(2, maxDpiSlots),
        defaultDpiSlotIndex: 0,   // 默认DPI档位 (存储在Profile中，设备重启后恢复)
        activeDpiSlotIndex: 0,    // 当前激活DPI档位 (实时状态)
        currentDpi: dpiSlotsX[0] ?? null,

        // Profile Slot 相关 (板载配置)
        activeProfileSlotIndex: 0,
        enabledProfileSlotCount: 5,  // 启用的配置槽位总数 (从设备读取)
        profileSlotStates: [true, true, false, false, false], // 每个槽位的启用状态

        // 板载内存模式 (true=板载模式, false=软件模式)
        onboardMemoryMode: true,

        bhopMs: 0,

        buttonMappings,

        batteryPercent: -1,
        batteryIsCharging: false,
      };
    }

    _emitConfig() {
      const cfg = this._cfg;
      for (const cb of this._onConfigCbs.slice()) {
        try { cb(cfg); } catch {}
      }
    }

    _emitBattery(bat) {
      const b = bat || { batteryPercent: -1, batteryIsCharging: false };
      for (const cb of this._onBatteryCbs.slice()) {
        try { cb(b); } catch {}
      }
    }
  }


  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
  ProtocolApi.LogitechHidApi = MouseMouseHidApi;
})();
