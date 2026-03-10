(() => {
  "use strict";

  /*
   * ============================================================
   * protocol_api_crdrkao.js
   *
   * Goal:
   * - Production-oriented WebHID protocol driver for CRDRAKO mouse.
   * - Keep protocol knowledge centralized and maintainable.
   * - Keep business/UI layer free from packet assembly details.
   *
   * Architecture:
   * 0) Errors & utility helpers
   * 1) PID capability model
   * 2) Transport layer (queue + send/recv + retry)
   * 3) Codec layer (64-byte CRDRAKO feature report)
   * 4) Value transformers
   * 5) SPEC + Planner
   * 6) Public API facade + exports
   *
   */

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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const clampInt = (n, min, max) => {
    const x = Math.trunc(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.min(max, Math.max(min, x));
  };
  const clampU8 = (n) => clampInt(n, 0, 0xff);
  const clampU16 = (n) => clampInt(n, 0, 0xffff);

  const toDataViewU8 = (raw) => {
    if (raw instanceof DataView) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw instanceof Uint8Array) return raw;
    return new Uint8Array(raw || []);
  };

  const deepClone = (v) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      if (Array.isArray(v)) return v.slice(0);
      if (isObject(v)) return Object.assign({}, v);
      return v;
    }
  };

  function normalizeBoolean(v, fallback = false) {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === "1" || v === "true") return true;
    if (v === 0 || v === "0" || v === "false") return false;
    return !!fallback;
  }

  // ============================================================
  // 1) Device constants & capability model
  // ============================================================
  const CRDRAKO_VENDOR_ID = 0x373e;
  const CRDRAKO_PRODUCT_ID_006B = 0x006b;
  const CRDRAKO_REPORT_ID = 0x00;
  const CRDRAKO_REPORT_LEN = 64;
  const CRDRAKO_DEVICE_ID_DEFAULT = 0x02;
  const CRDRAKO_MAX_DPI_STAGES = 6;
  const CRDRAKO_BUSY_RETRY = 5;
  const CRDRAKO_BUSY_POLL = 30;
  const CRDRAKO_RETRY_DELAY_MS = 20;
  const CRDRAKO_POST_OPEN_SETTLE_MS = 80;

  const PID = Object.freeze({
    CRDRAKO_006B: CRDRAKO_PRODUCT_ID_006B,
  });

  const PID_NAME = Object.freeze({
    [PID.CRDRAKO_006B]: "CRDRAKO Mouse",
  });

  const SUPPORTED_PIDS = Object.freeze([PID.CRDRAKO_006B]);
  const SUPPORTED_PID_SET = new Set(SUPPORTED_PIDS);

  const DEVICE_CAPABILITIES = Object.freeze({
    [PID.CRDRAKO_006B]: Object.freeze({
      polling: true,
      battery: true,
      charging: true,
      dpi: true,
      dpiStages: true,
      activeDpiStageIndex: true,
      idle: true,
      lod: true,
      angleSnap: true,
      motionSync: true,
      rippleControl: true,
      hyperMode: true,
      dpiXYOnOff: true,
      dpiIndicator: true,
      buttonCombine: true,
      debounceTime: true,
      speedEnable: true,
      keyMapping: true,
      lightingEffect: true,
      lightness: true,
      dpiStageColors: true,
      macro: false,
      firmwareUpgrade: false,
    }),
  });

  function buildCapabilities(pid) {
    const key = Number(pid) & 0xffff;
    const base = DEVICE_CAPABILITIES[key];
    const defaults = {
      polling: false,
      battery: false,
      charging: false,
      dpi: false,
      dpiStages: false,
      activeDpiStageIndex: false,
      idle: false,
      lod: false,
      angleSnap: false,
      motionSync: false,
      rippleControl: false,
      hyperMode: false,
      dpiXYOnOff: false,
      dpiIndicator: false,
      buttonCombine: false,
      debounceTime: false,
      speedEnable: false,
      keyMapping: false,
      lightingEffect: false,
      lightness: false,
      dpiStageColors: false,
      macro: false,
      firmwareUpgrade: false,
    };
    return Object.assign(
      { supported: SUPPORTED_PID_SET.has(key) },
      defaults,
      base || {}
    );
  }

  function normalizePid(device) {
    return Number(device?.productId ?? device?.productID ?? 0);
  }

  function ensureSupportedPid(pid) {
    const normalized = Number(pid) & 0xffff;
    if (!SUPPORTED_PID_SET.has(normalized)) {
      throw new ProtocolError(
        `Unsupported CRDRAKO PID: 0x${normalized.toString(16).padStart(4, "0")}`,
        "UNSUPPORTED_DEVICE",
        { pid: normalized, supportedPids: SUPPORTED_PIDS.slice(0) }
      );
    }
    return normalized;
  }

  function txForField(_pid, _field) {
    return CRDRAKO_DEVICE_ID_DEFAULT;
  }

  class SendQueue {
    constructor() {
      this._p = Promise.resolve();
    }

    enqueue(task) {
      this._p = this._p.then(task, task);
      return this._p;
    }
  }

  // ============================================================
  // 2) Transport layer (Feature Report I/O)
  // ============================================================
  class UniversalHidDriver {
    constructor() {
      this.device = null;
      this.productId = 0;
      this.queue = new SendQueue();
      this.sendTimeoutMs = 1500;
      this.readTimeoutMs = 1500;
      this.commonDelayMs = CRDRAKO_RETRY_DELAY_MS;
      this.hidIndex = 0;
    }

    setDevice(device, productId = 0) {
      this.device = device || null;
      this.productId = Number(productId || 0);
      this.hidIndex = 0;
    }

    _requireOpenDevice() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("HID device is not opened", "NOT_OPEN");
    }

    async _withTimeout(promise, timeoutMs, code, message) {
      return await Promise.race([
        promise,
        sleep(timeoutMs).then(() => {
          throw new ProtocolError(message, code, { timeoutMs });
        }),
      ]);
    }

    async _sendFeature(payload) {
      this._requireOpenDevice();
      await this._withTimeout(
        this.device.sendFeatureReport(CRDRAKO_REPORT_ID, payload),
        this.sendTimeoutMs,
        "IO_WRITE_TIMEOUT",
        `sendFeatureReport timeout (${this.sendTimeoutMs}ms)`
      );
    }

    async _recvFeature() {
      this._requireOpenDevice();
      const raw = await this._withTimeout(
        this.device.receiveFeatureReport(CRDRAKO_REPORT_ID),
        this.readTimeoutMs,
        "IO_READ_TIMEOUT",
        `receiveFeatureReport timeout (${this.readTimeoutMs}ms)`
      );
      return ProtocolCodec.fitReport(raw);
    }

    _isResponseOk(requestBytes, responseBytes, hidIndex, checkHeader) {
      const status = ProtocolCodec.statusAt(responseBytes, hidIndex);
      if (!ProtocolCodec.isSuccessStatus(status)) return false;
      if (checkHeader && !ProtocolCodec.responseHeaderEquals(requestBytes, responseBytes, hidIndex)) return false;
      return true;
    }

    async _retrySetGet(requestBytes, firstResponse, { checkHeader = false, delayMs = this.commonDelayMs } = {}) {
      let response = ProtocolCodec.fitReport(firstResponse);
      let hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, this.hidIndex);

      if (this._isResponseOk(requestBytes, response, hidIndex, checkHeader)) {
        return { buffer: response, hidIndex };
      }

      for (let attempt = 0; attempt < CRDRAKO_BUSY_RETRY; attempt++) {
        hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, hidIndex);
        const status = ProtocolCodec.statusAt(response, hidIndex);

        if (status > 0xa1) {
          if (delayMs > 0) await sleep(delayMs);
          await this._sendFeature(requestBytes);
          if (delayMs > 0) await sleep(delayMs);
          response = await this._recvFeature();
          hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, hidIndex);
          if (this._isResponseOk(requestBytes, response, hidIndex, checkHeader)) {
            return { buffer: response, hidIndex };
          }
          continue;
        }

        if (status < 0xa1 || !this._isResponseOk(requestBytes, response, hidIndex, checkHeader)) {
          for (let poll = 0; poll < CRDRAKO_BUSY_POLL; poll++) {
            if (delayMs > 0) await sleep(delayMs);
            response = await this._recvFeature();
            hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, hidIndex);
            if (this._isResponseOk(requestBytes, response, hidIndex, checkHeader)) {
              return { buffer: response, hidIndex };
            }
          }

          if (delayMs > 0) await sleep(delayMs);
          await this._sendFeature(requestBytes);
          if (delayMs > 0) await sleep(delayMs);
          response = await this._recvFeature();
          hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, hidIndex);
          if (this._isResponseOk(requestBytes, response, hidIndex, checkHeader)) {
            return { buffer: response, hidIndex };
          }
        }
      }

      hidIndex = ProtocolCodec.inferHidIndex(requestBytes, response, hidIndex);
      return { buffer: response, hidIndex };
    }

    async sendAndWait(packet, opts = {}) {
      return this.queue.enqueue(async () => {
        this._requireOpenDevice();
        const requestBytes = packet instanceof Uint8Array
          ? ProtocolCodec.fitReport(packet)
          : ProtocolCodec.encodeCrdrakoReport(packet || {});
        const waitMs = Number.isFinite(Number(opts.waitMs))
          ? Number(opts.waitMs)
          : this.commonDelayMs;
        const checkHeader = !!opts.checkHeader;
        const responseValidator = typeof opts.responseValidator === "function"
          ? opts.responseValidator
          : null;

        await this._sendFeature(requestBytes);
        if (waitMs > 0) await sleep(waitMs);
        const firstResponse = await this._recvFeature();
        const settled = await this._retrySetGet(requestBytes, firstResponse, { checkHeader, delayMs: waitMs });

        this.hidIndex = settled.hidIndex;
        const parsed = ProtocolCodec.parseCrdrakoReport(settled.buffer, this.hidIndex, requestBytes);

        if (checkHeader && !ProtocolCodec.matchResponse(requestBytes, parsed)) {
          throw new ProtocolError("Response does not match request header", "RESPONSE_MISMATCH", {
            expectedCommandId: clampU8(requestBytes[5]),
            gotCommandId: clampU8(parsed.commandId),
            hidIndex: parsed.hidIndex,
          });
        }
        if (responseValidator && !responseValidator(requestBytes, parsed)) {
          throw new ProtocolError("Response validator rejected packet", "RESPONSE_VALIDATION_FAILED", {
            commandId: parsed.commandId,
            commandClass: parsed.commandClass,
          });
        }
        if (!ProtocolCodec.isSuccessStatus(parsed.status)) {
          throw new ProtocolError("CRDRAKO command failed", "DEVICE_COMMAND_FAILURE", {
            status: parsed.status,
            commandId: parsed.commandId,
            commandClass: parsed.commandClass,
          });
        }

        return parsed;
      });
    }

    async runSequence(commands) {
      if (!Array.isArray(commands) || commands.length === 0) return [];
      const out = [];
      for (const command of commands) {
        const packet = command?.packet ?? command?.report ?? command;
        const result = await this.sendAndWait(packet, {
          waitMs: command?.waitMs,
          checkHeader: command?.checkHeader,
          responseValidator: command?.responseValidator,
        });
        out.push(result);
      }
      return out;
    }
  }

  // ============================================================
  // 3) Codec layer
  // ============================================================
  const ProtocolCodec = Object.freeze({
    fitReport(raw) {
      const src = toDataViewU8(raw);
      if (src.byteLength === CRDRAKO_REPORT_LEN) return src;
      const out = new Uint8Array(CRDRAKO_REPORT_LEN);
      out.set(src.subarray(0, CRDRAKO_REPORT_LEN));
      return out;
    },

    encodeCrdrakoReport({
      deviceId = CRDRAKO_DEVICE_ID_DEFAULT,
      commandClass = 0x00,
      commandId = 0x00,
      arguments: argsInput = [],
      dataSize = null,
    } = {}) {
      const args = argsInput instanceof Uint8Array ? argsInput : new Uint8Array(argsInput || []);
      if (args.length > (CRDRAKO_REPORT_LEN - 6)) {
        throw new ProtocolError("CRDRAKO arguments length overflow", "BAD_PARAM", { length: args.length });
      }
      const finalDataSize = dataSize == null ? args.length : clampInt(dataSize, 0, CRDRAKO_REPORT_LEN - 6);
      if (finalDataSize < args.length) {
        throw new ProtocolError("dataSize cannot be smaller than argument length", "BAD_PARAM", {
          dataSize: finalDataSize,
          argsLength: args.length,
        });
      }

      const out = new Uint8Array(CRDRAKO_REPORT_LEN);
      out[2] = clampU8(deviceId);
      out[3] = clampU8(finalDataSize);
      out[4] = clampU8(commandClass);
      out[5] = clampU8(commandId);
      out.set(args, 6);
      return out;
    },

    inferHidIndex(requestBytes, responseBytes, fallback = 0) {
      const req = requestBytes instanceof Uint8Array ? requestBytes : ProtocolCodec.fitReport(requestBytes);
      const res = responseBytes instanceof Uint8Array ? responseBytes : ProtocolCodec.fitReport(responseBytes);
      const cmd = clampU8(req[5]);
      if (clampU8(res[6]) === cmd) return 0;
      if (clampU8(res[5]) === cmd) return 1;
      const s0 = clampU8(res[1]);
      const s1 = clampU8(res[0]);
      if (s0 === 0xa1 || s0 === 0x02) return 0;
      if (s1 === 0xa1 || s1 === 0x02) return 1;
      return clampInt(fallback, 0, 1);
    },

    statusAt(responseBytes, hidIndex = 0) {
      const res = responseBytes instanceof Uint8Array ? responseBytes : ProtocolCodec.fitReport(responseBytes);
      return clampU8(res[1 - clampInt(hidIndex, 0, 1)]);
    },

    responseHeaderEquals(requestBytes, responseBytes, hidIndex = 0) {
      const req = requestBytes instanceof Uint8Array ? requestBytes : ProtocolCodec.fitReport(requestBytes);
      const res = responseBytes instanceof Uint8Array ? responseBytes : ProtocolCodec.fitReport(responseBytes);
      const hi = clampInt(hidIndex, 0, 1);
      return clampU8(res[6 - hi]) === clampU8(req[5]);
    },

    parseCrdrakoReport(raw, hidIndexHint = 0, requestBytes = null) {
      const u8 = ProtocolCodec.fitReport(raw);
      const hidIndex = requestBytes
        ? ProtocolCodec.inferHidIndex(requestBytes, u8, hidIndexHint)
        : clampInt(hidIndexHint, 0, 1);
      const argsStart = 7 - hidIndex;
      const maxArgs = Math.max(0, CRDRAKO_REPORT_LEN - argsStart);
      const lenA = clampInt(u8[4 - hidIndex], 0, maxArgs);
      const lenB = clampInt(u8[3 - hidIndex], 0, maxArgs);
      const payloadSize = lenA > 0 ? lenA : lenB;
      const argsEnd = Math.min(CRDRAKO_REPORT_LEN, argsStart + payloadSize);
      return {
        status: clampU8(u8[1 - hidIndex]),
        hidIndex,
        deviceId: clampU8(u8[2 - hidIndex]),
        payloadSize,
        commandClass: clampU8(u8[4 - hidIndex]),
        commandId: clampU8(u8[6 - hidIndex]),
        arguments: u8.slice(argsStart),
        argumentsData: u8.slice(argsStart, argsEnd),
        raw: u8,
      };
    },

    matchResponse(request, response) {
      const req = request instanceof Uint8Array ? request : ProtocolCodec.fitReport(request);
      const parsed = response?.raw ? response : ProtocolCodec.parseCrdrakoReport(response, 0, req);
      return clampU8(req[5]) === clampU8(parsed.commandId);
    },

    isSuccessStatus(status) {
      const s = clampU8(status);
      return s === 0xa1 || s === 0x02;
    },

    commands: {
      getFirmwareVersion(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x81,
          dataSize: 0x10,
        });
      },

      getBatteryStatus(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x83,
          dataSize: 0x02,
        });
      },

      getPollingRate(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x80,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setPollingRate(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, pollingCode = 0x01) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x00,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), clampU8(pollingCode)],
        });
      },

      getSleepTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x87,
          dataSize: 0x03,
          arguments: [clampU8(deviceId), 0x00, 0x00],
        });
      },

      setSleepTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, idleSec = 300) {
        const value = clampU16(idleSec);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x07,
          dataSize: 0x03,
          arguments: [clampU8(deviceId), (value >> 8) & 0xff, value & 0xff],
        });
      },

      getLod(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x88,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setLod(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, lodEncoded = 1) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x08,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), clampU8(lodEncoded)],
        });
      },

      getAngleSnap(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x84,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setAngleSnap(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x04,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getMotionSync(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x89,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setMotionSync(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x09,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getRippleControl(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8a,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setRippleControl(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0a,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getHyperMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8b,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setHyperMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0b,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getDpiXyOnOff(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8d,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setDpiXyOnOff(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0d,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getDpiIndicator(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x84,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setDpiIndicator(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x04,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getButtonCombine(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x81,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setButtonCombine(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x01,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00],
        });
      },

      getDebounceTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x88,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setDebounceTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, debounce = 8) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x08,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), clampU8(debounce)],
        });
      },

      getSpeedEnable(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x9a,
          dataSize: 0x03,
          arguments: [clampU8(deviceId), 0x00, 0x00],
        });
      },

      setSpeedEnable(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, enabled = false, speedWindow = 0) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x1a,
          dataSize: 0x03,
          arguments: [clampU8(deviceId), enabled ? 0x01 : 0x00, clampU8(speedWindow)],
        });
      },

      getDpiStages(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, slotCount = CRDRAKO_MAX_DPI_STAGES) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x81,
          dataSize: 0x0a,
          arguments: [clampU8(deviceId), clampInt(slotCount, 1, CRDRAKO_MAX_DPI_STAGES)],
        });
      },

      setDpiStages(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, stages = [], stageCount = stages.length) {
        const count = clampInt(stageCount, 1, CRDRAKO_MAX_DPI_STAGES);
        const args = new Uint8Array(26);
        args[0] = clampU8(deviceId);
        args[1] = clampU8(count);
        for (let i = 0; i < CRDRAKO_MAX_DPI_STAGES; i++) {
          const stage = stages[i] || stages[stages.length - 1] || { x: 1600, y: 1600 };
          const x = clampU16(stage.x);
          const y = clampU16(stage.y);
          const offset = 2 + i * 4;
          args[offset] = (x >> 8) & 0xff;
          args[offset + 1] = x & 0xff;
          args[offset + 2] = (y >> 8) & 0xff;
          args[offset + 3] = y & 0xff;
        }
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x01,
          dataSize: 0x1a,
          arguments: args,
        });
      },

      getActiveDpiStage(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x82,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), 0x00],
        });
      },

      setActiveDpiStage(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, oneBasedIndex = 1) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x02,
          dataSize: 0x02,
          arguments: [clampU8(deviceId), clampInt(oneBasedIndex, 1, CRDRAKO_MAX_DPI_STAGES)],
        });
      },

      getDpiStageColors(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x81,
          dataSize: 0x13,
          arguments: [clampU8(deviceId)],
        });
      },

      setDpiStageColors(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, colorBytes = []) {
        const normalized = Array.isArray(colorBytes) ? colorBytes.slice(0, 18).map((x) => clampU8(x)) : [];
        while (normalized.length < 18) normalized.push(0);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x01,
          dataSize: 0x13,
          arguments: [clampU8(deviceId), ...normalized],
        });
      },

      getLightEffect(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, zone = 0, paramLength = 8) {
        const extraLen = clampInt(paramLength, 0, 32);
        const args = [clampU8(zone), 0x00, 0x00, 0x00, 0x00];
        for (let i = 0; i < extraLen; i++) args.push(0x00);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x80,
          dataSize: 5 + extraLen,
          arguments: args,
        });
      },

      setLightEffect(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, effect = {}) {
        const zone = clampU8(effect.zone ?? 0x00);
        const mode = clampU8(effect.mode ?? effect.effect ?? 0x00);
        const speed = clampU8(effect.speed ?? 0x00);
        const colorCount = clampU8(effect.colorCount ?? effect.colors ?? 0x00);
        const paramA = clampU8(effect.paramA ?? effect.brightness ?? 0x00);
        const params = Array.isArray(effect.params) ? effect.params.slice(0, 32).map((x) => clampU8(x)) : [];
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x00,
          dataSize: 5 + params.length,
          arguments: [zone, mode, speed, colorCount, paramA, ...params],
        });
      },

      getLightness(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, zone = 0x00, channel = 0x00) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x82,
          dataSize: 0x03,
          arguments: [clampU8(zone), clampU8(channel), 0x00],
        });
      },

      setLightness(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, zone = 0x00, channel = 0x00, lightness = 100) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x02,
          dataSize: 0x03,
          arguments: [clampU8(zone), clampU8(channel), clampU8(lightness)],
        });
      },

      getButtonMapping(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, sourceCode = 0x01, funckey = 0x00, payloadBytes = []) {
        const payload = Array.isArray(payloadBytes) ? payloadBytes.slice(0, 16).map((x) => clampU8(x)) : [];
        const args = [clampU8(deviceId), clampU8(sourceCode), 0x00, clampU8(funckey), clampU8(payload.length), ...payload];
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x80,
          dataSize: 5 + payload.length,
          arguments: args,
        });
      },

      setButtonMapping(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, sourceCode = 0x01, funckey = 0x00, payloadBytes = []) {
        const payload = Array.isArray(payloadBytes) ? payloadBytes.slice(0, 16).map((x) => clampU8(x)) : [];
        const args = [clampU8(deviceId), clampU8(sourceCode), 0x00, clampU8(funckey), clampU8(payload.length), ...payload];
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x00,
          dataSize: 5 + payload.length,
          arguments: args,
        });
      },
    },
  });
  // ============================================================
  // 4) Transformers
  // ============================================================
  const POLLING_ENCODE_MAP = new Map([
    [1000, 0x01],
    [2000, 0x02],
    [4000, 0x04],
    [8000, 0x08],
    [500, 0x10],
    [250, 0x20],
    [125, 0x40],
  ]);
  const POLLING_DECODE_MAP = new Map([
    [0x01, 1000],
    [0x02, 2000],
    [0x04, 4000],
    [0x08, 8000],
    [0x10, 500],
    [0x20, 250],
    [0x40, 125],
  ]);

  const TRANSFORMERS = Object.freeze({
    normalizePollingHz(v) {
      const hz = clampInt(v, 125, 8000);
      const options = [125, 250, 500, 1000, 2000, 4000, 8000];
      let nearest = options[0];
      let minGap = Math.abs(options[0] - hz);
      for (let i = 1; i < options.length; i++) {
        const gap = Math.abs(options[i] - hz);
        if (gap < minGap) {
          minGap = gap;
          nearest = options[i];
        }
      }
      return nearest;
    },

    pollingEncode(hz) {
      const v = TRANSFORMERS.normalizePollingHz(hz);
      return POLLING_ENCODE_MAP.get(v) ?? 0x01;
    },

    pollingDecode(code, fallback = 1000) {
      const hit = POLLING_DECODE_MAP.get(clampU8(code));
      return Number.isFinite(hit) ? hit : TRANSFORMERS.normalizePollingHz(fallback);
    },

    clampDpi(v) {
      return clampInt(v, 100, 50000);
    },

    normalizeDpi(prevDpi, patch) {
      const prev = isObject(prevDpi) ? prevDpi : { x: 1600, y: 1600 };
      let x = prev.x;
      let y = prev.y;

      if (Object.prototype.hasOwnProperty.call(patch, "dpi")) {
        const raw = patch.dpi;
        if (isObject(raw)) {
          if (raw.x != null) x = raw.x;
          if (raw.X != null) x = raw.X;
          if (raw.y != null) y = raw.y;
          if (raw.Y != null) y = raw.Y;
        } else {
          x = raw;
          y = raw;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dpiX")) x = patch.dpiX;
      if (Object.prototype.hasOwnProperty.call(patch, "dpiY")) y = patch.dpiY;

      return {
        x: TRANSFORMERS.clampDpi(x),
        y: TRANSFORMERS.clampDpi(y),
      };
    },

    normalizeDpiStages(input, fallback) {
      const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
      const out = [];

      for (const item of source) {
        if (out.length >= CRDRAKO_MAX_DPI_STAGES) break;
        if (Number.isFinite(Number(item))) {
          const v = TRANSFORMERS.clampDpi(item);
          out.push({ x: v, y: v });
          continue;
        }
        if (isObject(item)) {
          const x = TRANSFORMERS.clampDpi(item.x ?? item.X ?? item.y ?? item.Y ?? 1600);
          const y = TRANSFORMERS.clampDpi(item.y ?? item.Y ?? item.x ?? item.X ?? x);
          out.push({ x, y });
        }
      }

      if (!out.length) {
        out.push(
          { x: 400, y: 400 },
          { x: 800, y: 800 },
          { x: 1600, y: 1600 },
          { x: 3200, y: 3200 }
        );
      }
      return out.slice(0, CRDRAKO_MAX_DPI_STAGES);
    },

    parseDpiStagesResponse(response) {
      const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
      const count = clampInt(args[1] ?? 0, 0, CRDRAKO_MAX_DPI_STAGES);
      const dpiStages = [];
      for (let i = 0; i < count; i++) {
        const offset = 2 + i * 4;
        const x = ((clampU8(args[offset]) << 8) | clampU8(args[offset + 1])) & 0xffff;
        const y = ((clampU8(args[offset + 2]) << 8) | clampU8(args[offset + 3])) & 0xffff;
        dpiStages.push({
          x: TRANSFORMERS.clampDpi(x),
          y: TRANSFORMERS.clampDpi(y),
        });
      }
      return { dpiStages, stageCount: count };
    },

    normalizeActiveStageIndex(value, stageCount) {
      return clampInt(value, 0, Math.max(0, stageCount - 1));
    },

    normalizeIdleTime(v) {
      const sec = clampInt(v, 60, 3600);
      return clampInt(Math.round(sec / 60) * 60, 60, 3600);
    },

    normalizeLod(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return 1;
      if (n >= 1) return clampInt(Math.round(n), 1, 10);
      const tenth = clampInt(Math.round(n * 10), 1, 9);
      return tenth / 10;
    },

    lodToRaw(v) {
      const lod = TRANSFORMERS.normalizeLod(v);
      if (lod >= 1) return clampU8(Math.round(lod));
      return clampU8((Math.round(lod * 10) & 0x7f) | 0x80);
    },

    lodFromRaw(raw, fallback = 1) {
      const b = clampU8(raw);
      if (b === 0) return TRANSFORMERS.normalizeLod(fallback);
      if (b & 0x80) return (b & 0x7f) / 10;
      return b;
    },

    normalizeDebounceTime(v) {
      return clampInt(v, 0, 50);
    },

    normalizeSpeedWindow(v) {
      return clampInt(v, 0, 255);
    },

    normalizeLightness(v) {
      return clampInt(v, 0, 100);
    },

    normalizeDpiStageColors(input, fallback) {
      const source = Array.isArray(input) ? input : (Array.isArray(fallback) ? fallback : []);
      const out = [];
      for (let i = 0; i < CRDRAKO_MAX_DPI_STAGES; i++) {
        const item = source[i];
        if (Array.isArray(item)) {
          out.push([
            clampU8(item[0] ?? 0),
            clampU8(item[1] ?? 0),
            clampU8(item[2] ?? 0),
          ]);
        } else if (isObject(item)) {
          out.push([
            clampU8(item.r ?? item.red ?? 0),
            clampU8(item.g ?? item.green ?? 0),
            clampU8(item.b ?? item.blue ?? 0),
          ]);
        } else {
          out.push([0, 0, 0]);
        }
      }
      return out;
    },

    dpiStageColorsToBytes(colors) {
      const normalized = TRANSFORMERS.normalizeDpiStageColors(colors, []);
      const bytes = [];
      for (const rgb of normalized) {
        bytes.push(clampU8(rgb[0]), clampU8(rgb[1]), clampU8(rgb[2]));
      }
      return bytes.slice(0, 18);
    },

    parseDpiStageColorsResponse(response) {
      const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
      const bytes = [];
      for (let i = 1; i < Math.min(args.length, 19); i++) bytes.push(clampU8(args[i]));
      while (bytes.length < 18) bytes.push(0);
      const out = [];
      for (let i = 0; i < CRDRAKO_MAX_DPI_STAGES; i++) {
        out.push([bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]]);
      }
      return out;
    },

    normalizeLightingEffect(v, fallback = null) {
      if (Number.isFinite(Number(v))) {
        return {
          zone: 0,
          mode: clampU8(v),
          speed: 0,
          colorCount: 0,
          paramA: 0,
          params: [],
        };
      }

      const base = isObject(fallback) ? fallback : {};
      const raw = isObject(v) ? v : {};
      const params = Array.isArray(raw.params)
        ? raw.params.slice(0, 32).map((x) => clampU8(x))
        : (Array.isArray(base.params) ? base.params.slice(0, 32).map((x) => clampU8(x)) : []);
      return {
        zone: clampU8(raw.zone ?? base.zone ?? 0),
        mode: clampU8(raw.mode ?? raw.effect ?? base.mode ?? base.effect ?? 0),
        speed: clampU8(raw.speed ?? base.speed ?? 0),
        colorCount: clampU8(raw.colorCount ?? raw.colors ?? base.colorCount ?? 0),
        paramA: clampU8(raw.paramA ?? raw.brightness ?? base.paramA ?? 0),
        params,
      };
    },

    parseLightingEffectResponse(response) {
      const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
      return {
        zone: clampU8(args[0] ?? 0),
        mode: clampU8(args[1] ?? 0),
        speed: clampU8(args[2] ?? 0),
        colorCount: clampU8(args[3] ?? 0),
        paramA: clampU8(args[4] ?? 0),
        params: Array.from(args.slice(5)).map((x) => clampU8(x)),
      };
    },

    batteryPercentFromRaw(raw) {
      const value = clampInt(raw, 0, 255);
      if (value <= 100) return value;
      return clampInt(Math.round((value * 100) / 255), 0, 100);
    },

    parseFirmwareVersion(response) {
      const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
      const a = clampU8(args[0] ?? 0);
      const b = clampU8(args[1] ?? 0);
      const c = clampU8(args[2] ?? 0);
      const d = clampU8(args[3] ?? 0);
      return `${a}.${b}.${c}.${d}`;
    },
  });

  function requireCapability(caps, capKey, featureName, pid) {
    if (!caps?.[capKey]) {
      throw new ProtocolError(
        `${featureName} is not supported for PID 0x${clampU16(pid).toString(16).padStart(4, "0")}`,
        "NOT_SUPPORTED_FOR_DEVICE",
        { featureName, pid, capability: capKey }
      );
    }
  }

  // ============================================================
  // 5) SPEC + Planner
  // ============================================================
  const SPEC = Object.freeze({
    pollingHz: {
      key: "pollingHz",
      kind: "direct",
      priority: 10,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "polling", "pollingHz", pid);
        const tx = txForField(pid, "pollingHz");
        const code = TRANSFORMERS.pollingEncode(nextState.pollingHz);
        return [{ packet: ProtocolCodec.commands.setPollingRate(tx, code) }];
      },
    },

    dpi: {
      key: "dpi",
      kind: "virtual",
      priority: 20,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpi", "dpi/dpiX/dpiY", pid);
        const tx = txForField(pid, "dpi");
        const count = nextState.dpiStages.length;
        return [
          { packet: ProtocolCodec.commands.setDpiStages(tx, nextState.dpiStages, count), checkHeader: true },
          { packet: ProtocolCodec.commands.setActiveDpiStage(tx, nextState.activeDpiStageIndex + 1) },
        ];
      },
    },

    dpiStages: {
      key: "dpiStages",
      kind: "direct",
      priority: 30,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiStages", "dpiStages", pid);
        const tx = txForField(pid, "dpiStages");
        const count = nextState.dpiStages.length;
        return [
          { packet: ProtocolCodec.commands.setDpiStages(tx, nextState.dpiStages, count), checkHeader: true },
          { packet: ProtocolCodec.commands.setActiveDpiStage(tx, nextState.activeDpiStageIndex + 1) },
        ];
      },
    },

    activeDpiStageIndex: {
      key: "activeDpiStageIndex",
      kind: "direct",
      priority: 31,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "activeDpiStageIndex", "activeDpiStageIndex", pid);
        const tx = txForField(pid, "activeDpiStageIndex");
        return [{ packet: ProtocolCodec.commands.setActiveDpiStage(tx, nextState.activeDpiStageIndex + 1) }];
      },
    },

    deviceIdleTime: {
      key: "deviceIdleTime",
      kind: "direct",
      priority: 40,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "idle", "deviceIdleTime", pid);
        const tx = txForField(pid, "deviceIdleTime");
        return [{ packet: ProtocolCodec.commands.setSleepTime(tx, nextState.deviceIdleTime) }];
      },
    },

    lod: {
      key: "lod",
      kind: "direct",
      priority: 50,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "lod", "lod", pid);
        const tx = txForField(pid, "lod");
        return [{ packet: ProtocolCodec.commands.setLod(tx, TRANSFORMERS.lodToRaw(nextState.lod)) }];
      },
    },

    angleSnap: {
      key: "angleSnap",
      kind: "direct",
      priority: 51,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "angleSnap", "angleSnap", pid);
        const tx = txForField(pid, "angleSnap");
        return [{ packet: ProtocolCodec.commands.setAngleSnap(tx, !!nextState.angleSnap) }];
      },
    },

    motionSync: {
      key: "motionSync",
      kind: "direct",
      priority: 52,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "motionSync", "motionSync", pid);
        const tx = txForField(pid, "motionSync");
        return [{ packet: ProtocolCodec.commands.setMotionSync(tx, !!nextState.motionSync) }];
      },
    },

    rippleControl: {
      key: "rippleControl",
      kind: "direct",
      priority: 53,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "rippleControl", "rippleControl", pid);
        const tx = txForField(pid, "rippleControl");
        return [{ packet: ProtocolCodec.commands.setRippleControl(tx, !!nextState.rippleControl) }];
      },
    },

    hyperMode: {
      key: "hyperMode",
      kind: "direct",
      priority: 54,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "hyperMode", "hyperMode", pid);
        const tx = txForField(pid, "hyperMode");
        return [{ packet: ProtocolCodec.commands.setHyperMode(tx, !!nextState.hyperMode) }];
      },
    },

    dpiXYOnOff: {
      key: "dpiXYOnOff",
      kind: "direct",
      priority: 55,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiXYOnOff", "dpiXYOnOff", pid);
        const tx = txForField(pid, "dpiXYOnOff");
        return [{ packet: ProtocolCodec.commands.setDpiXyOnOff(tx, !!nextState.dpiXYOnOff) }];
      },
    },

    dpiIndicator: {
      key: "dpiIndicator",
      kind: "direct",
      priority: 56,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiIndicator", "dpiIndicator", pid);
        const tx = txForField(pid, "dpiIndicator");
        return [{ packet: ProtocolCodec.commands.setDpiIndicator(tx, !!nextState.dpiIndicator) }];
      },
    },

    buttonCombine: {
      key: "buttonCombine",
      kind: "direct",
      priority: 57,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "buttonCombine", "buttonCombine", pid);
        const tx = txForField(pid, "buttonCombine");
        return [{ packet: ProtocolCodec.commands.setButtonCombine(tx, !!nextState.buttonCombine) }];
      },
    },

    debounceTime: {
      key: "debounceTime",
      kind: "direct",
      priority: 58,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "debounceTime", "debounceTime", pid);
        const tx = txForField(pid, "debounceTime");
        return [{ packet: ProtocolCodec.commands.setDebounceTime(tx, nextState.debounceTime) }];
      },
    },

    speedEnable: {
      key: "speedEnable",
      kind: "direct",
      priority: 59,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "speedEnable", "speedEnable", pid);
        const tx = txForField(pid, "speedEnable");
        return [{
          packet: ProtocolCodec.commands.setSpeedEnable(tx, !!nextState.speedEnable, nextState.speedWindow ?? 0),
        }];
      },
    },

    lightingEffect: {
      key: "lightingEffect",
      kind: "direct",
      priority: 70,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "lightingEffect", "lightingEffect", pid);
        const tx = txForField(pid, "lightingEffect");
        return [{ packet: ProtocolCodec.commands.setLightEffect(tx, nextState.lightingEffect) }];
      },
    },

    lightness: {
      key: "lightness",
      kind: "direct",
      priority: 71,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "lightness", "lightness", pid);
        const tx = txForField(pid, "lightness");
        return [{ packet: ProtocolCodec.commands.setLightness(tx, 0x00, 0x00, nextState.lightness) }];
      },
    },

    dpiStageColors: {
      key: "dpiStageColors",
      kind: "direct",
      priority: 72,
      plan({ pid, caps, nextState }) {
        requireCapability(caps, "dpiStageColors", "dpiStageColors", pid);
        const tx = txForField(pid, "dpiStageColors");
        return [{
          packet: ProtocolCodec.commands.setDpiStageColors(tx, TRANSFORMERS.dpiStageColorsToBytes(nextState.dpiStageColors)),
        }];
      },
    },
  });

  class CommandPlanner {
    constructor(productId = 0) {
      this.productId = Number(productId || 0);
      this.capabilities = buildCapabilities(this.productId);
    }

    setProductId(productId) {
      this.productId = Number(productId || 0);
      this.capabilities = buildCapabilities(this.productId);
    }

    normalizePayload(payload) {
      if (!isObject(payload)) return {};
      const out = {};
      const allow = new Set([
        "pollingHz",
        "dpi",
        "dpiX",
        "dpiY",
        "dpiStages",
        "activeDpiStageIndex",
        "deviceIdleTime",
        "lod",
        "angleSnap",
        "motionSync",
        "rippleControl",
        "hyperMode",
        "dpiXYOnOff",
        "dpiIndicator",
        "buttonCombine",
        "debounceTime",
        "speedEnable",
        "speedWindow",
        "lightingEffect",
        "lightness",
        "dpiStageColors",
      ]);

      const notSupported = new Set([
        "AllocateMacroDataSize",
        "SetMacroData",
        "GetMacroData",
        "GetMacroDataSize",
        "DeleteMacro",
        "enterBL",
        "erase",
        "program",
        "verify",
        "exitBL",
      ]);

      for (const key of Object.keys(payload)) {
        if (notSupported.has(key)) {
          throw new ProtocolError(`${key} is not supported for this device`, "NOT_SUPPORTED_FOR_DEVICE", {
            field: key,
            reason: "macro_or_firmware_upgrade_blocked",
          });
        }
        if (allow.has(key)) out[key] = payload[key];
      }
      return out;
    }

    _buildNextState(prevState, patch) {
      const next = deepClone(prevState || {});
      next.dpiStages = TRANSFORMERS.normalizeDpiStages(next.dpiStages, next.dpiStages);
      next.activeDpiStageIndex = TRANSFORMERS.normalizeActiveStageIndex(
        next.activeDpiStageIndex ?? 0,
        next.dpiStages.length
      );

      if (Object.prototype.hasOwnProperty.call(patch, "pollingHz")) {
        next.pollingHz = TRANSFORMERS.normalizePollingHz(patch.pollingHz);
      }

      if (
        Object.prototype.hasOwnProperty.call(patch, "dpi")
        || Object.prototype.hasOwnProperty.call(patch, "dpiX")
        || Object.prototype.hasOwnProperty.call(patch, "dpiY")
      ) {
        next.dpi = TRANSFORMERS.normalizeDpi(next.dpi, patch);
        const active = TRANSFORMERS.normalizeActiveStageIndex(next.activeDpiStageIndex, next.dpiStages.length);
        if (!next.dpiStages[active]) next.dpiStages[active] = { x: 1600, y: 1600 };
        next.dpiStages[active] = { x: next.dpi.x, y: next.dpi.y };
      }

      if (Object.prototype.hasOwnProperty.call(patch, "dpiStages")) {
        next.dpiStages = TRANSFORMERS.normalizeDpiStages(patch.dpiStages, next.dpiStages);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "activeDpiStageIndex")) {
        next.activeDpiStageIndex = TRANSFORMERS.normalizeActiveStageIndex(
          patch.activeDpiStageIndex,
          next.dpiStages.length
        );
      } else {
        next.activeDpiStageIndex = TRANSFORMERS.normalizeActiveStageIndex(
          next.activeDpiStageIndex,
          next.dpiStages.length
        );
      }

      if (Array.isArray(next.dpiStages) && next.dpiStages.length) {
        const active = next.dpiStages[next.activeDpiStageIndex] || next.dpiStages[0];
        next.dpi = {
          x: TRANSFORMERS.clampDpi(active.x),
          y: TRANSFORMERS.clampDpi(active.y),
        };
      }

      if (Object.prototype.hasOwnProperty.call(patch, "deviceIdleTime")) {
        next.deviceIdleTime = TRANSFORMERS.normalizeIdleTime(patch.deviceIdleTime);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "lod")) {
        next.lod = TRANSFORMERS.normalizeLod(patch.lod);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "angleSnap")) {
        next.angleSnap = normalizeBoolean(patch.angleSnap, next.angleSnap);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "motionSync")) {
        next.motionSync = normalizeBoolean(patch.motionSync, next.motionSync);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "rippleControl")) {
        next.rippleControl = normalizeBoolean(patch.rippleControl, next.rippleControl);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "hyperMode")) {
        next.hyperMode = normalizeBoolean(patch.hyperMode, next.hyperMode);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dpiXYOnOff")) {
        next.dpiXYOnOff = normalizeBoolean(patch.dpiXYOnOff, next.dpiXYOnOff);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dpiIndicator")) {
        next.dpiIndicator = normalizeBoolean(patch.dpiIndicator, next.dpiIndicator);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "buttonCombine")) {
        next.buttonCombine = normalizeBoolean(patch.buttonCombine, next.buttonCombine);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "debounceTime")) {
        next.debounceTime = TRANSFORMERS.normalizeDebounceTime(patch.debounceTime);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "speedEnable")) {
        next.speedEnable = normalizeBoolean(patch.speedEnable, next.speedEnable);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "speedWindow")) {
        next.speedWindow = TRANSFORMERS.normalizeSpeedWindow(patch.speedWindow);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "lightingEffect")) {
        next.lightingEffect = TRANSFORMERS.normalizeLightingEffect(patch.lightingEffect, next.lightingEffect);
      } else {
        next.lightingEffect = TRANSFORMERS.normalizeLightingEffect(next.lightingEffect, next.lightingEffect);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "lightness")) {
        next.lightness = TRANSFORMERS.normalizeLightness(patch.lightness);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "dpiStageColors")) {
        next.dpiStageColors = TRANSFORMERS.normalizeDpiStageColors(patch.dpiStageColors, next.dpiStageColors);
      } else {
        next.dpiStageColors = TRANSFORMERS.normalizeDpiStageColors(next.dpiStageColors, next.dpiStageColors);
      }

      return next;
    }

    _collectSpecKeys(patch) {
      const keys = [];
      const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);

      if (has("pollingHz")) keys.push("pollingHz");
      if (has("dpi") || has("dpiX") || has("dpiY")) keys.push("dpi");
      if (has("dpiStages")) keys.push("dpiStages");
      if (has("activeDpiStageIndex")) keys.push("activeDpiStageIndex");
      if (has("deviceIdleTime")) keys.push("deviceIdleTime");
      if (has("lod")) keys.push("lod");
      if (has("angleSnap")) keys.push("angleSnap");
      if (has("motionSync")) keys.push("motionSync");
      if (has("rippleControl")) keys.push("rippleControl");
      if (has("hyperMode")) keys.push("hyperMode");
      if (has("dpiXYOnOff")) keys.push("dpiXYOnOff");
      if (has("dpiIndicator")) keys.push("dpiIndicator");
      if (has("buttonCombine")) keys.push("buttonCombine");
      if (has("debounceTime")) keys.push("debounceTime");
      if (has("speedEnable") || has("speedWindow")) keys.push("speedEnable");
      if (has("lightingEffect")) keys.push("lightingEffect");
      if (has("lightness")) keys.push("lightness");
      if (has("dpiStageColors")) keys.push("dpiStageColors");
      return keys;
    }

    _topoSort(keys) {
      return keys.slice(0).sort((a, b) => {
        const pa = SPEC[a]?.priority ?? 0;
        const pb = SPEC[b]?.priority ?? 0;
        return pa - pb;
      });
    }

    plan(prevState, payload) {
      const patch = this.normalizePayload(payload);
      const nextState = this._buildNextState(prevState, patch);
      const keys = this._collectSpecKeys(patch);
      const sorted = this._topoSort(keys);

      const commands = [];
      for (const key of sorted) {
        const spec = SPEC[key];
        if (!spec) continue;
        const seq = spec.plan({
          pid: this.productId,
          caps: this.capabilities,
          patch,
          prevState,
          nextState,
        });
        if (Array.isArray(seq) && seq.length) commands.push(...seq);
      }
      return { patch, nextState, commands };
    }
  }
  // ============================================================
  // Key mapping helpers
  // ============================================================
  const DEFAULT_BUTTON_SOURCE_CODE_BY_BUTTON_ID = Object.freeze({
    1: 0x01,
    2: 0x02,
    3: 0x03,
    4: 0x05,
    5: 0x04,
    6: 0x60,
  });

  const DEFAULT_ACTION_LABEL_BY_BUTTON_ID = Object.freeze({
    1: "Left Click",
    2: "Right Click",
    3: "Middle Click",
    4: "Forward",
    5: "Back",
    6: "DPI Loop",
  });

  const KEYMAP_ACTIONS = (() => {
    const actions = Object.create(null);
    const add = (label, type, funckey, keycode) => {
      if (!label || actions[label]) return;
      actions[label] = {
        type: String(type || "system"),
        funckey: clampU8(funckey),
        keycode: clampInt(keycode, 0, 0xffff),
      };
    };

    add("Left Click", "mouse", 0x01, 0x0000);
    add("Right Click", "mouse", 0x02, 0x0000);
    add("Middle Click", "mouse", 0x04, 0x0000);
    add("Forward", "mouse", 0x08, 0x0000);
    add("Back", "mouse", 0x10, 0x0000);
    add("DPI Loop", "mouse", 0x20, 0x0005);
    add("Disable", "mouse", 0x07, 0x0000);
    add("Double Click", "mouse", 0x01, 0x0006);
    add("Wheel Up", "mouse", 0x01, 0x0009);
    add("Wheel Down", "mouse", 0x01, 0x000a);

    for (let i = 0; i < 26; i++) {
      add(String.fromCharCode(65 + i), "keyboard", 0x02, 0x0004 + i);
    }
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    for (let i = 0; i < digits.length; i++) {
      add(digits[i], "keyboard", 0x02, 0x001e + i);
    }
    for (let i = 1; i <= 12; i++) {
      add(`F${i}`, "keyboard", 0x02, 0x0039 + i);
    }

    add("Volume Up", "system", 0x40, 0x0000);
    add("Volume Down", "system", 0x40, 0x0001);
    add("Mute", "system", 0x40, 0x0002);
    add("Play/Pause", "system", 0x40, 0x0004);
    add("Next Track", "system", 0x40, 0x0005);
    add("Previous Track", "system", 0x40, 0x0006);

    return Object.freeze(actions);
  })();

  const KEYMAP_LABEL_ALIASES = Object.freeze({
    left: "Left Click",
    "left click": "Left Click",
    right: "Right Click",
    "right click": "Right Click",
    middle: "Middle Click",
    "middle click": "Middle Click",
    back: "Back",
    backward: "Back",
    forward: "Forward",
    dpiloop: "DPI Loop",
    "dpi loop": "DPI Loop",
    disable: "Disable",
    disabled: "Disable",
    "double click": "Double Click",
    "wheel up": "Wheel Up",
    "wheel down": "Wheel Down",
    volup: "Volume Up",
    voldown: "Volume Down",
    mute: "Mute",
    "play pause": "Play/Pause",
    "play/pause": "Play/Pause",
    "next track": "Next Track",
    "previous track": "Previous Track",
  });

  const FUNCKEY_KEYCODE_TO_LABEL = (() => {
    const out = new Map();
    for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
      const key = `${Number(action.funckey)}:${Number(action.keycode)}`;
      if (!out.has(key)) out.set(key, label);
    }
    return out;
  })();

  function normalizeActionLabel(label) {
    const raw = String(label || "").trim();
    if (!raw) return "";
    const alias = KEYMAP_LABEL_ALIASES[raw.toLowerCase()];
    return alias || raw;
  }

  function resolveActionFromLabel(label) {
    const canonical = normalizeActionLabel(label);
    const action = KEYMAP_ACTIONS[canonical];
    if (!action) return null;
    return {
      label: canonical,
      source: canonical,
      action: {
        funckey: clampU8(action.funckey),
        keycode: clampInt(action.keycode, 0, 0xffff),
      },
    };
  }

  function encodeButtonPayload(funckey, keycode) {
    const fk = clampU8(funckey);
    const kc = clampInt(keycode, 0, 0xffff);
    if (fk === 0x02 || fk === 0x40 || kc > 0xff) {
      return [(kc >> 8) & 0xff, kc & 0xff];
    }
    if (kc > 0) return [kc & 0xff];
    return [];
  }

  function decodeButtonPayload(funckey, payloadBytes = []) {
    const fk = clampU8(funckey);
    const bytes = Array.isArray(payloadBytes) ? payloadBytes : [];
    if (fk === 0x02 || fk === 0x40 || bytes.length >= 2) {
      const hi = clampU8(bytes[0] ?? 0);
      const lo = clampU8(bytes[1] ?? 0);
      return ((hi << 8) | lo) & 0xffff;
    }
    return clampU8(bytes[0] ?? 0);
  }

  function normalizeButtonMappingEntry(entry, fallbackSource = "") {
    const raw = isObject(entry) ? entry : {};
    return {
      source: String(raw.source ?? raw.label ?? fallbackSource ?? "").trim() || String(fallbackSource || "").trim(),
      funckey: clampU8(raw.funckey ?? raw.func ?? 0),
      keycode: clampInt(raw.keycode ?? raw.code ?? 0, 0, 0xffff),
    };
  }

  function buildDefaultButtonMappings() {
    const out = [];
    for (let i = 1; i <= 6; i++) {
      const label = DEFAULT_ACTION_LABEL_BY_BUTTON_ID[i];
      const action = KEYMAP_ACTIONS[label] || { funckey: 0x00, keycode: 0x0000 };
      out.push({
        source: label,
        funckey: clampU8(action.funckey),
        keycode: clampInt(action.keycode, 0, 0xffff),
      });
    }
    return out;
  }

  function parseButtonMappingResponse(response, fallback = null) {
    const args = response?.arguments instanceof Uint8Array ? response.arguments : new Uint8Array();
    if (args.length < 5) {
      return normalizeButtonMappingEntry(fallback || { source: "Unknown", funckey: 0, keycode: 0 });
    }
    const funckey = clampU8(args[3] ?? 0);
    const payloadLen = clampInt(args[4] ?? 0, 0, 16);
    const payload = Array.from(args.slice(5, 5 + payloadLen)).map((x) => clampU8(x));
    const keycode = decodeButtonPayload(funckey, payload);
    const label = FUNCKEY_KEYCODE_TO_LABEL.get(`${funckey}:${keycode}`) || `Unknown(${funckey},${keycode})`;
    return {
      source: label,
      funckey,
      keycode,
    };
  }

  // ============================================================
  // 6) Public API facade
  // ============================================================
  class MouseMouseHidApi {
    constructor({ device = null } = {}) {
      this._device = null;
      this._driver = new UniversalHidDriver();
      this._planner = new CommandPlanner(0);
      this._opQueue = new SendQueue();
      this._onConfigCbs = new Set();
      this._onBatteryCbs = new Set();
      this._onRawReportCbs = new Set();
      this._boundInputReport = (event) => this._handleInputReport(event);
      this._closed = true;
      if (device) this.device = device;
      this._cfg = this._makeDefaultCfg();
    }

    set device(dev) {
      if (this._device && this._device !== dev && typeof this._device.removeEventListener === "function") {
        this._device.removeEventListener("inputreport", this._boundInputReport);
      }
      this._device = dev || null;
      const pid = normalizePid(this._device);
      this._planner.setProductId(pid);
      this._driver.setDevice(this._device, pid);
      this._cfg = this._makeDefaultCfg();
    }

    get device() {
      return this._device;
    }

    get capabilities() {
      return this._capabilitiesSnapshot();
    }

    _pid() {
      return normalizePid(this._device);
    }

    _caps() {
      return buildCapabilities(this._pid());
    }

    _ensureSupported() {
      const pid = this._pid();
      ensureSupportedPid(pid);
      return pid;
    }

    async _ensureOpen() {
      if (!this.device) throw new ProtocolError("No HID device assigned", "NO_DEVICE");
      this._ensureSupported();
      if (!this.device.opened) await this.open();
    }

    _capabilitiesSnapshot(caps = this._caps()) {
      return {
        pollingRates: [125, 250, 500, 1000, 2000, 4000, 8000],
        dpiSlotCount: CRDRAKO_MAX_DPI_STAGES,
        maxDpi: 50000,
        dpiStep: 1,
        battery: !!caps.battery,
        charging: !!caps.charging,
        deviceIdleTime: !!caps.idle,
        lod: !!caps.lod,
        angleSnap: !!caps.angleSnap,
        motionSync: !!caps.motionSync,
        rippleControl: !!caps.rippleControl,
        hyperMode: !!caps.hyperMode,
        dpiXYOnOff: !!caps.dpiXYOnOff,
        dpiIndicator: !!caps.dpiIndicator,
        buttonCombine: !!caps.buttonCombine,
        debounceTime: !!caps.debounceTime,
        speedEnable: !!caps.speedEnable,
        keyMapping: !!caps.keyMapping,
        lightingEffect: !!caps.lightingEffect,
        lightness: !!caps.lightness,
        dpiStageColors: !!caps.dpiStageColors,
      };
    }

    _snapshotForUi() {
      const cfg = deepClone(this._cfg || {});
      if (!isObject(cfg.capabilities)) {
        cfg.capabilities = this._capabilitiesSnapshot(this._caps());
      }
      return cfg;
    }

    _emitConfig() {
      if (this._closed) return;
      const cfg = this._snapshotForUi();
      for (const cb of Array.from(this._onConfigCbs)) {
        try { cb(cfg); } catch { }
      }
    }

    _emitBattery(bat) {
      if (this._closed) return;
      const payload = {
        batteryPercent: clampInt(bat?.batteryPercent ?? -1, -1, 100),
        batteryIsCharging: !!bat?.batteryIsCharging,
      };
      for (const cb of Array.from(this._onBatteryCbs)) {
        try { cb(payload); } catch { }
      }
    }

    _emitRawReport(raw) {
      if (this._closed) return;
      for (const cb of Array.from(this._onRawReportCbs)) {
        try { cb(raw); } catch { }
      }
    }

    _handleInputReport(event) {
      if (this._closed) return;
      const reportId = clampU8(event?.reportId ?? 0);
      const reportBytes = toDataViewU8(event?.data);
      this._emitRawReport({
        reportId,
        bytes: new Uint8Array(reportBytes || []),
        timestamp: Number(event?.timeStamp ?? Date.now()),
      });
    }

    _attachInputReportListener() {
      if (!this.device || typeof this.device.addEventListener !== "function") return;
      if (typeof this.device.removeEventListener === "function") {
        this.device.removeEventListener("inputreport", this._boundInputReport);
      }
      this.device.addEventListener("inputreport", this._boundInputReport);
    }

    _detachInputReportListener() {
      if (!this.device || typeof this.device.removeEventListener !== "function") return;
      this.device.removeEventListener("inputreport", this._boundInputReport);
    }

    _makeDefaultCfg() {
      const pid = this._pid();
      const caps = this._caps();
      const cfg = {
        capabilities: this._capabilitiesSnapshot(caps),
        deviceName: this.device?.productName
          ? String(this.device.productName)
          : (PID_NAME[pid] || "CRDRAKO Mouse"),
        firmwareVersion: "0.0.0.0",
        pollingHz: 1000,
        dpi: { x: 1600, y: 1600 },
        dpiStages: [
          { x: 400, y: 400 },
          { x: 800, y: 800 },
          { x: 1600, y: 1600 },
          { x: 3200, y: 3200 },
        ],
        activeDpiStageIndex: 0,
        buttonMappings: buildDefaultButtonMappings(),
        batteryPercent: -1,
        batteryIsCharging: false,
        deviceIdleTime: 300,
        lod: 1,
        angleSnap: false,
        motionSync: false,
        rippleControl: false,
        hyperMode: false,
        dpiXYOnOff: false,
        dpiIndicator: false,
        buttonCombine: true,
        debounceTime: 8,
        speedEnable: false,
        speedWindow: 0,
        lightingEffect: {
          zone: 0,
          mode: 0,
          speed: 0,
          colorCount: 0,
          paramA: 0,
          params: [],
        },
        lightness: 100,
        dpiStageColors: [
          [255, 0, 0],
          [0, 255, 0],
          [0, 0, 255],
          [255, 255, 0],
          [255, 0, 255],
          [0, 255, 255],
        ],
      };
      return cfg;
    }

    async open() {
      if (!this.device) throw new ProtocolError("open() requires a HID device", "NO_DEVICE");
      const pid = this._ensureSupported();
      if (!this.device.opened) await this.device.open();

      this._closed = false;
      this._driver.setDevice(this.device, pid);
      this._planner.setProductId(pid);
      this._cfg = this._makeDefaultCfg();
      this._attachInputReportListener();

      if (CRDRAKO_POST_OPEN_SETTLE_MS > 0) await sleep(CRDRAKO_POST_OPEN_SETTLE_MS);

      let updates = null;
      try {
        updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: true });
      } catch (e) {
        const msg = String(e?.message || e);
        throw new ProtocolError(`Initial state read failed: ${msg}`, "INITIAL_READ_FAIL", { cause: e });
      }

      if (updates && Object.keys(updates).length) {
        this._cfg = Object.assign({}, this._cfg, updates);
      }
      this._emitConfig();
      this._emitBattery({
        batteryPercent: this._cfg.batteryPercent,
        batteryIsCharging: this._cfg.batteryIsCharging,
      });
    }

    async bootstrapSession(opts = {}) {
      const options = isObject(opts) ? opts : {};
      const {
        device = null,
        reason = "",
        openRetry = 2,
        openRetryDelayMs = 120,
        useCacheFallback = true,
      } = options;

      if (device) this.device = device;

      const cachedCfg = this.getCachedConfig();
      const maxOpenAttempts = clampInt(openRetry, 1, 10);
      const openDelayMs = clampInt(openRetryDelayMs, 0, 5000);

      let openErr = null;
      let attempts = 0;
      for (let i = 0; i < maxOpenAttempts; i++) {
        attempts = i + 1;
        try {
          await this.open();
          openErr = null;
          break;
        } catch (e) {
          openErr = e;
          if (i < maxOpenAttempts - 1 && openDelayMs > 0) await sleep(openDelayMs);
        }
      }

      let usedCacheFallback = false;
      if (openErr) {
        const isInitialReadFail = String(openErr?.code || "") === "INITIAL_READ_FAIL";
        if (isInitialReadFail && useCacheFallback && cachedCfg && typeof cachedCfg === "object") {
          this._cfg = Object.assign({}, cachedCfg);
          usedCacheFallback = true;
        } else {
          throw openErr;
        }
      }

      this._emitConfig();
      this._emitBattery({
        batteryPercent: this._cfg?.batteryPercent,
        batteryIsCharging: this._cfg?.batteryIsCharging,
      });

      return {
        cfg: this.getCachedConfig(),
        meta: {
          reason: String(reason || ""),
          openAttempts: attempts,
          readAttempts: attempts,
          usedCacheFallback,
        },
      };
    }

    async close() {
      this._closed = true;
      this._detachInputReportListener();
      if (!this.device) return;
      try {
        if (this.device.opened) await this.device.close();
      } catch { }
    }

    onConfig(cb, { replay = true } = {}) {
      if (typeof cb !== "function") return () => { };
      this._onConfigCbs.add(cb);
      if (replay && this._cfg) {
        const snapshot = this._snapshotForUi();
        queueMicrotask(() => {
          if (this._onConfigCbs.has(cb)) cb(snapshot);
        });
      }
      return () => this._onConfigCbs.delete(cb);
    }

    onBattery(cb) {
      if (typeof cb !== "function") return () => { };
      this._onBatteryCbs.add(cb);
      return () => this._onBatteryCbs.delete(cb);
    }

    onRawReport(cb) {
      if (typeof cb !== "function") return () => { };
      this._onRawReportCbs.add(cb);
      return () => this._onRawReportCbs.delete(cb);
    }

    getCachedConfig() {
      return this._snapshotForUi();
    }

    async requestConfig() {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: false });
        if (updates && Object.keys(updates).length) {
          this._cfg = Object.assign({}, this._cfg, updates);
        }
        this._emitConfig();
        this._emitBattery({
          batteryPercent: this._cfg.batteryPercent,
          batteryIsCharging: this._cfg.batteryIsCharging,
        });
        return this.getCachedConfig();
      });
    }

    async requestConfiguration() { return this.requestConfig(); }
    async getConfig() { return this.requestConfig(); }
    async readConfig() { return this.requestConfig(); }
    async requestDeviceConfig() { return this.requestConfig(); }

    async requestBattery() {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const caps = this._caps();
        if (!caps.battery) {
          throw new ProtocolError("Battery is not supported for this device", "NOT_SUPPORTED_FOR_DEVICE", {
            pid: this._pid(),
          });
        }
        const updates = await this._readBatterySnapshot();
        this._cfg = Object.assign({}, this._cfg, updates);
        const bat = {
          batteryPercent: this._cfg.batteryPercent,
          batteryIsCharging: this._cfg.batteryIsCharging,
        };
        this._emitBattery(bat);
        this._emitConfig();
        return bat;
      });
    }

    async setBatchFeatures(obj) {
      const payload = isObject(obj) ? obj : {};
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const { patch, nextState, commands } = this._planner.plan(this._cfg, payload);

        if (commands.length) {
          try {
            await this._driver.runSequence(commands);
          } catch (err) {
            try {
              const updates = await this._readDeviceStateSnapshot({ strictButtonMappingRead: false });
              if (updates && Object.keys(updates).length) {
                this._cfg = Object.assign({}, this._cfg, updates);
              }
              this._emitConfig();
              this._emitBattery({
                batteryPercent: this._cfg?.batteryPercent,
                batteryIsCharging: this._cfg?.batteryIsCharging,
              });
            } catch (reconcileErr) {
              console.warn("[CRDRAKO] Write reconcile failed", reconcileErr);
            }
            throw err;
          }
        }

        this._cfg = Object.assign({}, this._cfg, nextState);
        this._emitConfig();
        this._emitBattery({
          batteryPercent: this._cfg.batteryPercent,
          batteryIsCharging: this._cfg.batteryIsCharging,
        });
        return { patch, commands };
      });
    }

    async setFeature(key, value) {
      const k = String(key || "");
      if (!k) throw new ProtocolError("setFeature() requires key", "BAD_PARAM");
      return this.setBatchFeatures({ [k]: value });
    }

    async setDpi(slot, value, opts = {}) {
      const requestedSlot = clampInt(slot, 1, CRDRAKO_MAX_DPI_STAGES);
      const base = TRANSFORMERS.normalizeDpiStages(this._cfg?.dpiStages, this._cfg?.dpiStages);
      const targetCount = clampInt(Math.max(base.length, requestedSlot), 1, CRDRAKO_MAX_DPI_STAGES);
      const next = base.slice(0, targetCount);
      while (next.length < targetCount) {
        const seed = next[next.length - 1] || { x: 1600, y: 1600 };
        next.push({ x: seed.x, y: seed.y });
      }

      const valObj = isObject(value) ? value : null;
      const nextX = TRANSFORMERS.clampDpi(valObj ? (valObj.x ?? valObj.X ?? valObj.y ?? valObj.Y) : value);
      const nextY = TRANSFORMERS.clampDpi(valObj ? (valObj.y ?? valObj.Y ?? nextX) : nextX);
      next[requestedSlot - 1] = { x: nextX, y: nextY };

      const patch = { dpiStages: next };
      if (opts && opts.select) patch.activeDpiStageIndex = requestedSlot - 1;
      return this.setBatchFeatures(patch);
    }

    async setDpiSlotCount(n) {
      const count = clampInt(n, 1, CRDRAKO_MAX_DPI_STAGES);
      const base = TRANSFORMERS.normalizeDpiStages(this._cfg?.dpiStages, this._cfg?.dpiStages);
      const next = base.slice(0, count);
      while (next.length < count) {
        next.push({ x: 800, y: 800 });
      }
      const active = clampInt(this._cfg?.activeDpiStageIndex ?? 0, 0, Math.max(0, count - 1));
      return this.setBatchFeatures({ dpiStages: next, activeDpiStageIndex: active });
    }

    async setSlotCount(n) {
      return this.setDpiSlotCount(n);
    }

    async setActiveDpiSlotIndex(index) {
      const max = Math.max(0, (Array.isArray(this._cfg?.dpiStages) ? this._cfg.dpiStages.length : 1) - 1);
      const idx = clampInt(index, 0, max);
      return this.setBatchFeatures({ activeDpiStageIndex: idx });
    }

    async setCurrentDpiIndex(index) {
      return this.setActiveDpiSlotIndex(index);
    }

    async setButtonMappingBySelect(btnId, labelOrObj) {
      return this._opQueue.enqueue(async () => {
        await this._ensureOpen();
        const b = clampInt(btnId, 1, 6);
        const sourceCode = DEFAULT_BUTTON_SOURCE_CODE_BY_BUTTON_ID[b];
        if (!Number.isFinite(sourceCode)) {
          throw new ProtocolError(`Btn${b} mapping source code is not defined`, "FEATURE_UNSUPPORTED", { btnId: b });
        }

        let action = null;
        let source = "";
        if (typeof labelOrObj === "string") {
          const resolved = resolveActionFromLabel(labelOrObj);
          if (!resolved) {
            throw new ProtocolError(`Unknown key action label: ${labelOrObj}`, "BAD_PARAM", {
              btnId: b,
              label: labelOrObj,
            });
          }
          action = resolved.action;
          source = resolved.source || resolved.label || "";
        } else if (isObject(labelOrObj)) {
          action = {
            funckey: clampU8(labelOrObj.funckey ?? labelOrObj.func ?? 0),
            keycode: clampInt(labelOrObj.keycode ?? labelOrObj.code ?? 0, 0, 0xffff),
          };
          source = String(labelOrObj.source ?? labelOrObj.label ?? "custom").trim() || "custom";
        } else {
          throw new ProtocolError("key action must be label string or {funckey,keycode}", "BAD_PARAM");
        }

        const payload = encodeButtonPayload(action.funckey, action.keycode);
        const tx = txForField(this._pid(), "buttonMapping");
        await this._driver.sendAndWait(
          ProtocolCodec.commands.setButtonMapping(tx, sourceCode, action.funckey, payload),
          { checkHeader: false }
        );

        const next = Array.isArray(this._cfg?.buttonMappings)
          ? this._cfg.buttonMappings.slice(0, 6)
          : buildDefaultButtonMappings();
        while (next.length < 6) {
          next.push({ source: "", funckey: 0x00, keycode: 0x0000 });
        }
        next[b - 1] = {
          source,
          funckey: clampU8(action.funckey),
          keycode: clampInt(action.keycode, 0, 0xffff),
        };
        this._cfg = Object.assign({}, this._cfg, { buttonMappings: next });
        this._emitConfig();

        return {
          btnId: b,
          sourceCode,
          action: next[b - 1],
        };
      });
    }

    async _safeQuery(packet, fallback = null, opts = {}) {
      try {
        return await this._driver.sendAndWait(packet, opts);
      } catch (err) {
        const name = String(err?.name || "");
        const msg = String(err?.message || "").toLowerCase();
        if (
          name === "NotAllowedError"
          || msg.includes("notallowederror")
          || msg.includes("failed to write the feature report")
          || msg.includes("failed to receive the feature report")
          || msg.includes("failed to read the feature report")
        ) {
          throw err;
        }
        return fallback;
      }
    }

    async _readBatterySnapshot() {
      const pid = this._ensureSupported();
      const caps = this._caps();
      if (!caps.battery) {
        throw new ProtocolError("Battery is not supported for this device", "NOT_SUPPORTED_FOR_DEVICE", { pid });
      }

      const tx = txForField(pid, "battery");
      const out = {
        batteryPercent: this._cfg?.batteryPercent ?? -1,
        batteryIsCharging: this._cfg?.batteryIsCharging ?? false,
      };
      const bat = await this._safeQuery(ProtocolCodec.commands.getBatteryStatus(tx));
      if (bat?.arguments) {
        out.batteryPercent = TRANSFORMERS.batteryPercentFromRaw(bat.arguments[0] ?? 0);
        out.batteryIsCharging = !!clampU8(bat.arguments[1] ?? 0);
      }
      return out;
    }

    async _readButtonMappingsSnapshot({ strictStability = false } = {}) {
      void strictStability;
      const pid = this._ensureSupported();
      const tx = txForField(pid, "buttonMapping");
      const out = Array.from({ length: 6 }, () => normalizeButtonMappingEntry({ source: "Unknown", funckey: 0, keycode: 0 }));

      for (let btnId = 1; btnId <= 6; btnId++) {
        const sourceCode = DEFAULT_BUTTON_SOURCE_CODE_BY_BUTTON_ID[btnId];
        const fallback = normalizeButtonMappingEntry(this._cfg?.buttonMappings?.[btnId - 1], DEFAULT_ACTION_LABEL_BY_BUTTON_ID[btnId]);
        const res = await this._safeQuery(
          ProtocolCodec.commands.getButtonMapping(tx, sourceCode, fallback.funckey, encodeButtonPayload(fallback.funckey, fallback.keycode)),
          null,
          { checkHeader: false }
        );
        out[btnId - 1] = res ? parseButtonMappingResponse(res, fallback) : fallback;
      }

      return out;
    }

    async _readDeviceStateSnapshot({ strictButtonMappingRead = false } = {}) {
      const pid = this._ensureSupported();
      const caps = this._caps();
      const tx = txForField(pid, "snapshot");
      const updates = {
        deviceName: this.device?.productName ? String(this.device.productName) : (PID_NAME[pid] || "CRDRAKO Mouse"),
        capabilities: this._capabilitiesSnapshot(caps),
      };

      const fw = await this._safeQuery(ProtocolCodec.commands.getFirmwareVersion(tx), null, { checkHeader: false });
      if (fw?.arguments) updates.firmwareVersion = TRANSFORMERS.parseFirmwareVersion(fw);

      const poll = await this._safeQuery(ProtocolCodec.commands.getPollingRate(tx), null, { checkHeader: false });
      if (poll?.arguments) updates.pollingHz = TRANSFORMERS.pollingDecode(poll.arguments[1] ?? poll.arguments[0] ?? 0x01, this._cfg?.pollingHz ?? 1000);

      const dpiStagesRes = await this._safeQuery(
        ProtocolCodec.commands.getDpiStages(tx, CRDRAKO_MAX_DPI_STAGES),
        null,
        { checkHeader: true }
      );
      if (dpiStagesRes?.arguments) {
        const parsed = TRANSFORMERS.parseDpiStagesResponse(dpiStagesRes);
        if (parsed.dpiStages.length) {
          updates.dpiStages = parsed.dpiStages;
        }
      }

      const activeRes = await this._safeQuery(ProtocolCodec.commands.getActiveDpiStage(tx));
      if (activeRes?.arguments) {
        const oneBased = clampInt(activeRes.arguments[1] ?? 1, 1, CRDRAKO_MAX_DPI_STAGES);
        const stageCount = Array.isArray(updates.dpiStages)
          ? updates.dpiStages.length
          : (Array.isArray(this._cfg?.dpiStages) ? this._cfg.dpiStages.length : 1);
        updates.activeDpiStageIndex = clampInt(oneBased - 1, 0, Math.max(0, stageCount - 1));
      }

      const stagesForDpi = Array.isArray(updates.dpiStages) ? updates.dpiStages : (this._cfg?.dpiStages || []);
      const activeIdx = Number.isFinite(updates.activeDpiStageIndex)
        ? updates.activeDpiStageIndex
        : (this._cfg?.activeDpiStageIndex ?? 0);
      if (stagesForDpi.length) {
        const stage = stagesForDpi[clampInt(activeIdx, 0, stagesForDpi.length - 1)] || stagesForDpi[0];
        if (stage) updates.dpi = { x: clampU16(stage.x), y: clampU16(stage.y) };
      }

      if (caps.battery) {
        Object.assign(updates, await this._readBatterySnapshot());
      }

      if (caps.idle) {
        const idleRes = await this._safeQuery(ProtocolCodec.commands.getSleepTime(tx));
        if (idleRes?.arguments) {
          updates.deviceIdleTime = TRANSFORMERS.normalizeIdleTime(
            ((clampU8(idleRes.arguments[1]) << 8) | clampU8(idleRes.arguments[2])) & 0xffff
          );
        }
      }

      if (caps.lod) {
        const lodRes = await this._safeQuery(ProtocolCodec.commands.getLod(tx));
        if (lodRes?.arguments) {
          updates.lod = TRANSFORMERS.lodFromRaw(lodRes.arguments[1], this._cfg?.lod ?? 1);
        }
      }

      if (caps.angleSnap) {
        const angle = await this._safeQuery(ProtocolCodec.commands.getAngleSnap(tx));
        if (angle?.arguments) updates.angleSnap = !!clampU8(angle.arguments[1] ?? 0);
      }
      if (caps.motionSync) {
        const motion = await this._safeQuery(ProtocolCodec.commands.getMotionSync(tx));
        if (motion?.arguments) updates.motionSync = !!clampU8(motion.arguments[1] ?? 0);
      }
      if (caps.rippleControl) {
        const ripple = await this._safeQuery(ProtocolCodec.commands.getRippleControl(tx));
        if (ripple?.arguments) updates.rippleControl = !!clampU8(ripple.arguments[1] ?? 0);
      }
      if (caps.hyperMode) {
        const hyper = await this._safeQuery(ProtocolCodec.commands.getHyperMode(tx));
        if (hyper?.arguments) updates.hyperMode = !!clampU8(hyper.arguments[1] ?? 0);
      }
      if (caps.dpiXYOnOff) {
        const dpixy = await this._safeQuery(ProtocolCodec.commands.getDpiXyOnOff(tx));
        if (dpixy?.arguments) updates.dpiXYOnOff = !!clampU8(dpixy.arguments[1] ?? 0);
      }
      if (caps.dpiIndicator) {
        const indicator = await this._safeQuery(ProtocolCodec.commands.getDpiIndicator(tx));
        if (indicator?.arguments) updates.dpiIndicator = !!clampU8(indicator.arguments[1] ?? 0);
      }
      if (caps.buttonCombine) {
        const combine = await this._safeQuery(ProtocolCodec.commands.getButtonCombine(tx));
        if (combine?.arguments) updates.buttonCombine = !!clampU8(combine.arguments[1] ?? 0);
      }
      if (caps.debounceTime) {
        const debounce = await this._safeQuery(ProtocolCodec.commands.getDebounceTime(tx));
        if (debounce?.arguments) {
          updates.debounceTime = TRANSFORMERS.normalizeDebounceTime(debounce.arguments[1] ?? 8);
        }
      }
      if (caps.speedEnable) {
        const speed = await this._safeQuery(ProtocolCodec.commands.getSpeedEnable(tx));
        if (speed?.arguments) {
          updates.speedEnable = !!clampU8(speed.arguments[1] ?? 0);
          updates.speedWindow = TRANSFORMERS.normalizeSpeedWindow(speed.arguments[2] ?? 0);
        }
      }
      if (caps.lightness) {
        const lightness = await this._safeQuery(ProtocolCodec.commands.getLightness(tx));
        if (lightness?.arguments) updates.lightness = TRANSFORMERS.normalizeLightness(lightness.arguments[2] ?? 100);
      }
      if (caps.lightingEffect) {
        const effect = await this._safeQuery(ProtocolCodec.commands.getLightEffect(tx, 0, 8));
        if (effect?.arguments) updates.lightingEffect = TRANSFORMERS.parseLightingEffectResponse(effect);
      }
      if (caps.dpiStageColors) {
        const colors = await this._safeQuery(ProtocolCodec.commands.getDpiStageColors(tx));
        if (colors?.arguments) updates.dpiStageColors = TRANSFORMERS.parseDpiStageColorsResponse(colors);
      }
      if (caps.keyMapping) {
        const mappings = await this._readButtonMappingsSnapshot({ strictStability: !!strictButtonMappingRead });
        if (Array.isArray(mappings) && mappings.length) updates.buttonMappings = mappings;
      }

      return updates;
    }

    isSupportedPid(productId) {
      return SUPPORTED_PID_SET.has(Number(productId));
    }
  }

  // ============================================================
  // 7) ProtocolApi exports
  // ============================================================
  const root = typeof window !== "undefined"
    ? window
    : (typeof globalThis !== "undefined" ? globalThis : global);
  const ProtocolApi = (root.ProtocolApi = root.ProtocolApi || {});

  ProtocolApi.RAZER_HID = {
    vendorId: CRDRAKO_VENDOR_ID,
    productIds: SUPPORTED_PIDS.slice(0),
    defaultFilters: [{
      vendorId: CRDRAKO_VENDOR_ID,
      productId: CRDRAKO_PRODUCT_ID_006B,
    }],
    isSupportedPid(productId) {
      return SUPPORTED_PID_SET.has(Number(productId));
    },
  };

  ProtocolApi.resolveMouseDisplayName = function resolveMouseDisplayName(vendorId, productId, fallbackName) {
    const vid = Number(vendorId) & 0xffff;
    const pid = Number(productId) & 0xffff;
    if (vid === CRDRAKO_VENDOR_ID) {
      return PID_NAME[pid] || String(fallbackName || "CRDRAKO Mouse");
    }
    return String(fallbackName || `VID 0x${vid.toString(16)} PID 0x${pid.toString(16)}`);
  };

  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  ProtocolApi.listKeyActionsByType = function listKeyActionsByType() {
    const buckets = Object.create(null);
    for (const [label, action] of Object.entries(KEYMAP_ACTIONS)) {
      const type = String(action?.type || "system");
      if (!buckets[type]) buckets[type] = [];
      buckets[type].push(label);
    }
    return Object.entries(buckets).map(([type, items]) => ({ type, items }));
  };

  ProtocolApi.labelFromFunckeyKeycode = function labelFromFunckeyKeycode(funckey, keycode) {
    const fk = Number(funckey);
    const kc = Number(keycode);
    return FUNCKEY_KEYCODE_TO_LABEL.get(`${fk}:${kc}`) || `Unknown(${fk},${kc})`;
  };

  if (!ProtocolApi.MOUSE_HID) {
    ProtocolApi.MOUSE_HID = ProtocolApi.RAZER_HID;
  }

  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
  ProtocolApi.RazerHidApi = MouseMouseHidApi;
})();
