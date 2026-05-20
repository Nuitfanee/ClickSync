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
  const CRDRAKO_PRODUCT_ID_006A = 0x006a;
  const CRDRAKO_PRODUCT_ID_006B = 0x006b;
  const CRDRAKO_REPORT_ID = 0x00;
  const CRDRAKO_REPORT_LEN = 64;
  const CRDRAKO_DEVICE_ID_WIRED = 0x00;
  const CRDRAKO_DEVICE_ID_WIRELESS_LIGHT = 0x01;
  const CRDRAKO_DEVICE_ID_WIRELESS = 0x02;
  const CRDRAKO_DEVICE_ID_DEFAULT = CRDRAKO_DEVICE_ID_WIRELESS;
  const CRDRAKO_PROFILE_ID_DEFAULT = 0x01;
  const CRDRAKO_PROFILE_ID_MIN = 0x01;
  const CRDRAKO_PROFILE_ID_MAX = 0x03;
  const CRDRAKO_MIN_DPI = 50;
  const CRDRAKO_MAX_DPI = 30000;
  const CRDRAKO_DPI_STEP = 50;
  const CRDRAKO_MAX_DPI_STAGES = 5;
  const CRDRAKO_KEYMAP_BUTTON_COUNT = 5;
  const CRDRAKO_BUSY_RETRY = 5;
  const CRDRAKO_BUSY_POLL = 30;
  const CRDRAKO_RETRY_DELAY_MS = 20;
  const CRDRAKO_POST_OPEN_SETTLE_MS = 80;

  const PID = Object.freeze({
    CRDRAKO_006A: CRDRAKO_PRODUCT_ID_006A,
    CRDRAKO_006B: CRDRAKO_PRODUCT_ID_006B,
  });

  const PID_NAME = Object.freeze({
    [PID.CRDRAKO_006A]: "CRDRAKO KO-ONE Wired",
    [PID.CRDRAKO_006B]: "CRDRAKO KO-ONE 8K",
  });

  const SUPPORTED_PIDS = Object.freeze([PID.CRDRAKO_006A, PID.CRDRAKO_006B]);
  const SUPPORTED_PID_SET = new Set(SUPPORTED_PIDS);
  const CRDRAKO_WIRELESS_LIGHT_FIELDS = new Set(["lightingEffect", "lightness"]);

  const COMMON_DEVICE_CAPABILITIES = Object.freeze({
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
    competitiveMode: true,
    hyperMode: true,
    dpiXYOnOff: true,
    dpiIndicator: true,
    buttonCombine: true,
    debounceTime: true,
    speedEnable: true,
    scrollHp: true,
    sensorAngle: true,
    keyMapping: true,
    lightingEffect: true,
    lightness: true,
    dpiStageColors: true,
    macro: false,
    firmwareUpgrade: false,
  });

  const DEVICE_CAPABILITIES = Object.freeze({
    [PID.CRDRAKO_006A]: Object.freeze({
      ...COMMON_DEVICE_CAPABILITIES,
      lightingEffect: false,
      lightness: false,
    }),
    [PID.CRDRAKO_006B]: Object.freeze({
      ...COMMON_DEVICE_CAPABILITIES,
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
      competitiveMode: false,
      hyperMode: false,
      dpiXYOnOff: false,
      dpiIndicator: false,
      buttonCombine: false,
      debounceTime: false,
      speedEnable: false,
      scrollHp: false,
      sensorAngle: false,
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

  function normalizeProfileId(v, fallback = CRDRAKO_PROFILE_ID_DEFAULT) {
    const n = Number(v);
    if (!Number.isFinite(n)) return normalizeProfileId(fallback, CRDRAKO_PROFILE_ID_DEFAULT);
    return clampInt(n, CRDRAKO_PROFILE_ID_MIN, CRDRAKO_PROFILE_ID_MAX);
  }

  function isDebugEnabled() {
    try {
      return typeof localStorage !== "undefined" && localStorage.DEBUG_CRDRAKO === "1";
    } catch {
      return false;
    }
  }

  function hexPreview(bytes, len = 32) {
    const u8 = bytes instanceof Uint8Array ? bytes : toDataViewU8(bytes);
    return Array.from(u8.slice(0, clampInt(len, 0, 64)))
      .map((x) => clampU8(x).toString(16).padStart(2, "0"))
      .join(" ");
  }

  function debugCrdrako(scope, payload) {
    if (!isDebugEnabled()) return;
    try {
      console.debug(`[CRDRAKO] ${scope}`, payload);
    } catch { }
  }

  function txForField(pid, field) {
    const normalizedPid = Number(pid) & 0xffff;
    if (normalizedPid === PID.CRDRAKO_006B && CRDRAKO_WIRELESS_LIGHT_FIELDS.has(String(field || ""))) {
      return CRDRAKO_DEVICE_ID_WIRELESS_LIGHT;
    }
    return CRDRAKO_DEVICE_ID_WIRELESS;
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
      let bytes = ProtocolCodec.fitReport(payload);
      if (
        (Number(this.productId) & 0xffff) === PID.CRDRAKO_006A
        && bytes[2] === CRDRAKO_DEVICE_ID_WIRELESS
      ) {
        bytes = bytes.slice(0);
        bytes[2] = CRDRAKO_DEVICE_ID_WIRED;
      }
      debugCrdrako("sendFeatureReport", {
        reportId: CRDRAKO_REPORT_ID,
        length: bytes.byteLength,
        productId: `0x${(Number(this.productId) & 0xffff).toString(16).padStart(4, "0")}`,
        reportDeviceId: clampU8(bytes[2]),
        targetId: clampU8(bytes[6]),
        commandClass: clampU8(bytes[4]),
        commandId: clampU8(bytes[5]),
        hex: hexPreview(bytes),
      });
      await this._withTimeout(
        this.device.sendFeatureReport(CRDRAKO_REPORT_ID, bytes),
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
      const bytes = ProtocolCodec.fitReport(raw);
      debugCrdrako("receiveFeatureReport", {
        reportId: CRDRAKO_REPORT_ID,
        length: bytes.byteLength,
        hex: hexPreview(bytes),
      });
      return bytes;
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
        debugCrdrako("parsedResponse", {
          hidIndex: parsed.hidIndex,
          status: `0x${parsed.status.toString(16).padStart(2, "0")}`,
          commandClass: `0x${parsed.commandClass.toString(16).padStart(2, "0")}`,
          commandId: `0x${parsed.commandId.toString(16).padStart(2, "0")}`,
          targetId: parsed.targetId,
          value0: parsed.values?.[0],
          value1: parsed.values?.[1],
        });

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
      reportDeviceId = null,
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
      out[2] = clampU8(reportDeviceId == null ? deviceId : reportDeviceId);
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
      const valueStart = 8 - hidIndex;
      const maxArgs = Math.max(0, CRDRAKO_REPORT_LEN - argsStart);
      const lenA = clampInt(u8[4 - hidIndex], 0, maxArgs);
      const lenB = clampInt(u8[3 - hidIndex], 0, maxArgs);
      const payloadSize = lenA > 0 ? lenA : lenB;
      const argsEnd = Math.min(CRDRAKO_REPORT_LEN, argsStart + payloadSize);
      const commandClass = requestBytes ? clampU8(requestBytes[4]) : clampU8(u8[5 - hidIndex]);
      return {
        status: clampU8(u8[1 - hidIndex]),
        hidIndex,
        deviceId: clampU8(u8[2 - hidIndex]),
        targetId: clampU8(u8[7 - hidIndex]),
        payloadSize,
        commandClass,
        commandId: clampU8(u8[6 - hidIndex]),
        valueStart,
        arguments: u8.slice(argsStart),
        argumentsData: u8.slice(argsStart, argsEnd),
        values: u8.slice(valueStart),
        raw: u8,
      };
    },

    valueAt(response, offset = 0, fallback = 0) {
      const parsed = response?.raw ? response : ProtocolCodec.parseCrdrakoReport(response);
      const idx = clampInt(offset, 0, CRDRAKO_REPORT_LEN);
      const values = parsed?.values instanceof Uint8Array ? parsed.values : new Uint8Array();
      return clampU8(values[idx] ?? fallback);
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

      getProfileId(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x85,
          dataSize: 0x01,
        });
      },

      getProfileList(deviceId = CRDRAKO_DEVICE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x86,
          dataSize: 0x01,
        });
      },

      getPollingRate(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x80,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setPollingRate(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, pollingCode = 0x01) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x00,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), clampU8(pollingCode)],
        });
      },

      getSleepTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x87,
          dataSize: 0x03,
          arguments: [normalizeProfileId(targetId), 0x00, 0x00],
        });
      },

      setSleepTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, idleSec = 300) {
        const value = clampU16(idleSec);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x07,
          dataSize: 0x03,
          arguments: [normalizeProfileId(targetId), (value >> 8) & 0xff, value & 0xff],
        });
      },

      getLod(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x88,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setLod(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, lodEncoded = 1) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x08,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), clampU8(lodEncoded)],
        });
      },

      getAngleSnap(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x84,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setAngleSnap(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x04,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getMotionSync(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x89,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setMotionSync(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x09,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getRippleControl(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8a,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setRippleControl(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0a,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getHyperMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8b,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setHyperMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0b,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getCompetitiveMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x93,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setCompetitiveMode(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x13,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getDpiXyOnOff(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x8d,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setDpiXyOnOff(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x0d,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getDpiIndicator(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x84,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setDpiIndicator(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x04,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getButtonCombine(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x81,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setButtonCombine(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, enabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x01,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), enabled ? 0x01 : 0x00],
        });
      },

      getDebounceTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x88,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setDebounceTime(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, debounce = 8) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x08,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), clampU8(debounce)],
        });
      },

      getSpeedEnable(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x9a,
          dataSize: 0x03,
          arguments: [normalizeProfileId(targetId), 0x00, 0x00],
        });
      },

      setSpeedEnable(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, leftEnabled = false, rightEnabled = false) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x1a,
          dataSize: 0x03,
          arguments: [normalizeProfileId(targetId), leftEnabled ? 0x01 : 0x00, rightEnabled ? 0x01 : 0x00],
        });
      },

      getScrollHP(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x99,
          dataSize: 0x04,
          arguments: [normalizeProfileId(targetId)],
        });
      },

      setScrollHP(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, rollerMode = 0, windowTime = 100) {
        const ms = TRANSFORMERS.normalizeScrollHpWindowMs(windowTime);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x00,
          commandId: 0x19,
          dataSize: 0x04,
          arguments: [
            normalizeProfileId(targetId),
            TRANSFORMERS.normalizeScrollHpMode(rollerMode),
            (ms >> 8) & 0xff,
            ms & 0xff,
          ],
        });
      },

      getAngleTune(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x94,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setAngleTune(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, angle = 0) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x14,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), TRANSFORMERS.sensorAngleToRaw(angle)],
        });
      },

      getDpiStages(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, slotCount = CRDRAKO_MAX_DPI_STAGES) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x81,
          dataSize: 0x0a,
          arguments: [normalizeProfileId(targetId), clampInt(slotCount, 1, CRDRAKO_MAX_DPI_STAGES)],
        });
      },

      setDpiStages(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, stages = [], stageCount = stages.length) {
        const count = clampInt(stageCount, 1, CRDRAKO_MAX_DPI_STAGES);
        const args = new Uint8Array(26);
        args[0] = normalizeProfileId(targetId);
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

      getActiveDpiStage(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x82,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), 0x00],
        });
      },

      setActiveDpiStage(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, oneBasedIndex = 1) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x01,
          commandId: 0x02,
          dataSize: 0x02,
          arguments: [normalizeProfileId(targetId), clampInt(oneBasedIndex, 1, CRDRAKO_MAX_DPI_STAGES)],
        });
      },

      getDpiStageColors(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT) {
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x81,
          dataSize: 0x13,
          arguments: [normalizeProfileId(targetId)],
        });
      },

      setDpiStageColors(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, colorBytes = []) {
        const normalized = Array.isArray(colorBytes) ? colorBytes.slice(0, 18).map((x) => clampU8(x)) : [];
        while (normalized.length < 18) normalized.push(0);
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x02,
          commandId: 0x01,
          dataSize: 0x13,
          arguments: [normalizeProfileId(targetId), ...normalized],
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

      getButtonMapping(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, sourceCode = 0x01, funckey = 0x00, payloadBytes = []) {
        const payload = Array.isArray(payloadBytes) ? payloadBytes.slice(0, 16).map((x) => clampU8(x)) : [];
        const args = [normalizeProfileId(targetId), clampU8(sourceCode), 0x00, clampU8(funckey), clampU8(payload.length), ...payload];
        return ProtocolCodec.encodeCrdrakoReport({
          deviceId,
          commandClass: 0x03,
          commandId: 0x80,
          dataSize: 5 + payload.length,
          arguments: args,
        });
      },

      setButtonMapping(deviceId = CRDRAKO_DEVICE_ID_DEFAULT, targetId = CRDRAKO_PROFILE_ID_DEFAULT, sourceCode = 0x01, funckey = 0x00, payloadBytes = []) {
        const payload = Array.isArray(payloadBytes) ? payloadBytes.slice(0, 16).map((x) => clampU8(x)) : [];
        const args = [normalizeProfileId(targetId), clampU8(sourceCode), 0x00, clampU8(funckey), clampU8(payload.length), ...payload];
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
    [125, 0x08],
    [250, 0x04],
    [500, 0x02],
    [1000, 0x01],
    [2000, 0x20],
    [4000, 0x40],
    [8000, 0x80],
  ]);
  const POLLING_DECODE_MAP = new Map([
    [0x08, 125],
    [0x04, 250],
    [0x02, 500],
    [0x01, 1000],
    [0x10, 1000],
    [0x20, 2000],
    [0x40, 4000],
    [0x80, 8000],
  ]);
  const SCROLL_HP_MODE_VALUES = Object.freeze([0, 1, 2, 3]);
  const SCROLL_HP_WINDOW_MS_VALUES = Object.freeze([100, 200, 300, 400, 500, 1000]);

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
      const clamped = clampInt(v, CRDRAKO_MIN_DPI, CRDRAKO_MAX_DPI);
      const snapped = CRDRAKO_MIN_DPI
        + Math.round((clamped - CRDRAKO_MIN_DPI) / CRDRAKO_DPI_STEP) * CRDRAKO_DPI_STEP;
      return clampInt(snapped, CRDRAKO_MIN_DPI, CRDRAKO_MAX_DPI);
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
      const raw = response?.raw instanceof Uint8Array ? response.raw : new Uint8Array();
      const hi = clampInt(response?.hidIndex ?? 0, 0, 1);
      const count = clampInt(raw[8 - hi] ?? 0, 0, CRDRAKO_MAX_DPI_STAGES);
      const dpiStages = [];
      for (let i = 0; i < count; i++) {
        const offset = 9 - hi + i * 4;
        const x = ((clampU8(raw[offset]) << 8) | clampU8(raw[offset + 1])) & 0xffff;
        const y = ((clampU8(raw[offset + 2]) << 8) | clampU8(raw[offset + 3])) & 0xffff;
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
      return normalizeBoolean(v, false);
    },

    normalizeScrollHpMode(v, fallback = 0) {
      const n = clampInt(v, 0, 3);
      if (SCROLL_HP_MODE_VALUES.includes(n)) return n;
      return SCROLL_HP_MODE_VALUES.includes(fallback) ? fallback : 0;
    },

    normalizeScrollHpWindowMs(v, fallback = 100) {
      const n = Number(v);
      const fb = SCROLL_HP_WINDOW_MS_VALUES.includes(Number(fallback)) ? Number(fallback) : 100;
      if (!Number.isFinite(n)) return fb;
      return SCROLL_HP_WINDOW_MS_VALUES.reduce((best, item) => (
        Math.abs(item - n) < Math.abs(best - n) ? item : best
      ), SCROLL_HP_WINDOW_MS_VALUES[0]);
    },

    normalizeSensorAngle(v, fallback = 0) {
      const n = Number(v);
      if (!Number.isFinite(n)) return TRANSFORMERS.normalizeSensorAngle(fallback, 0);
      return clampInt(Math.round(n), -30, 30);
    },

    sensorAngleToRaw(v) {
      const angle = TRANSFORMERS.normalizeSensorAngle(v);
      return angle < 0 ? ((256 + angle) & 0xff) : clampU8(angle);
    },

    sensorAngleFromRaw(raw) {
      const b = clampU8(raw);
      return TRANSFORMERS.normalizeSensorAngle(b > 30 ? b - 256 : b);
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
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "polling", "pollingHz", pid);
        const tx = txForField(pid, "pollingHz");
        const code = TRANSFORMERS.pollingEncode(nextState.pollingHz);
        return [{ packet: ProtocolCodec.commands.setPollingRate(tx, targetId, code) }];
      },
    },

    dpi: {
      key: "dpi",
      kind: "virtual",
      priority: 20,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "dpi", "dpi/dpiX/dpiY", pid);
        const tx = txForField(pid, "dpi");
        const count = nextState.dpiStages.length;
        return [
          { packet: ProtocolCodec.commands.setDpiStages(tx, targetId, nextState.dpiStages, count), checkHeader: true },
          { packet: ProtocolCodec.commands.setActiveDpiStage(tx, targetId, nextState.activeDpiStageIndex + 1) },
        ];
      },
    },

    dpiStages: {
      key: "dpiStages",
      kind: "direct",
      priority: 30,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "dpiStages", "dpiStages", pid);
        const tx = txForField(pid, "dpiStages");
        const count = nextState.dpiStages.length;
        return [
          { packet: ProtocolCodec.commands.setDpiStages(tx, targetId, nextState.dpiStages, count), checkHeader: true },
          { packet: ProtocolCodec.commands.setActiveDpiStage(tx, targetId, nextState.activeDpiStageIndex + 1) },
        ];
      },
    },

    activeDpiStageIndex: {
      key: "activeDpiStageIndex",
      kind: "direct",
      priority: 31,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "activeDpiStageIndex", "activeDpiStageIndex", pid);
        const tx = txForField(pid, "activeDpiStageIndex");
        return [{ packet: ProtocolCodec.commands.setActiveDpiStage(tx, targetId, nextState.activeDpiStageIndex + 1) }];
      },
    },

    deviceIdleTime: {
      key: "deviceIdleTime",
      kind: "direct",
      priority: 40,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "idle", "deviceIdleTime", pid);
        const tx = txForField(pid, "deviceIdleTime");
        return [{ packet: ProtocolCodec.commands.setSleepTime(tx, targetId, nextState.deviceIdleTime) }];
      },
    },

    lod: {
      key: "lod",
      kind: "direct",
      priority: 50,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "lod", "lod", pid);
        const tx = txForField(pid, "lod");
        return [{ packet: ProtocolCodec.commands.setLod(tx, targetId, TRANSFORMERS.lodToRaw(nextState.lod)) }];
      },
    },

    angleSnap: {
      key: "angleSnap",
      kind: "direct",
      priority: 51,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "angleSnap", "angleSnap", pid);
        const tx = txForField(pid, "angleSnap");
        return [{ packet: ProtocolCodec.commands.setAngleSnap(tx, targetId, !!nextState.angleSnap) }];
      },
    },

    motionSync: {
      key: "motionSync",
      kind: "direct",
      priority: 52,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "motionSync", "motionSync", pid);
        const tx = txForField(pid, "motionSync");
        return [{ packet: ProtocolCodec.commands.setMotionSync(tx, targetId, !!nextState.motionSync) }];
      },
    },

    rippleControl: {
      key: "rippleControl",
      kind: "direct",
      priority: 53,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "rippleControl", "rippleControl", pid);
        const tx = txForField(pid, "rippleControl");
        return [{ packet: ProtocolCodec.commands.setRippleControl(tx, targetId, !!nextState.rippleControl) }];
      },
    },

    competitiveMode: {
      key: "competitiveMode",
      kind: "direct",
      priority: 54,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "competitiveMode", "competitiveMode", pid);
        const tx = txForField(pid, "competitiveMode");
        return [{ packet: ProtocolCodec.commands.setCompetitiveMode(tx, targetId, !!nextState.competitiveMode) }];
      },
    },

    hyperMode: {
      key: "hyperMode",
      kind: "direct",
      priority: 55,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "hyperMode", "hyperMode", pid);
        const tx = txForField(pid, "hyperMode");
        return [{ packet: ProtocolCodec.commands.setHyperMode(tx, targetId, !!nextState.hyperMode) }];
      },
    },

    dpiXYOnOff: {
      key: "dpiXYOnOff",
      kind: "direct",
      priority: 55,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "dpiXYOnOff", "dpiXYOnOff", pid);
        const tx = txForField(pid, "dpiXYOnOff");
        return [{ packet: ProtocolCodec.commands.setDpiXyOnOff(tx, targetId, !!nextState.dpiXYOnOff) }];
      },
    },

    dpiIndicator: {
      key: "dpiIndicator",
      kind: "direct",
      priority: 56,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "dpiIndicator", "dpiIndicator", pid);
        const tx = txForField(pid, "dpiIndicator");
        return [{ packet: ProtocolCodec.commands.setDpiIndicator(tx, targetId, !!nextState.dpiIndicator) }];
      },
    },

    buttonCombine: {
      key: "buttonCombine",
      kind: "direct",
      priority: 57,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "buttonCombine", "buttonCombine", pid);
        const tx = txForField(pid, "buttonCombine");
        return [{ packet: ProtocolCodec.commands.setButtonCombine(tx, targetId, !!nextState.buttonCombine) }];
      },
    },

    debounceTime: {
      key: "debounceTime",
      kind: "direct",
      priority: 58,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "debounceTime", "debounceTime", pid);
        const tx = txForField(pid, "debounceTime");
        return [{ packet: ProtocolCodec.commands.setDebounceTime(tx, targetId, nextState.debounceTime) }];
      },
    },

    speedEnable: {
      key: "speedEnable",
      kind: "direct",
      priority: 59,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "speedEnable", "speedEnable", pid);
        const tx = txForField(pid, "speedEnable");
        return [{
          packet: ProtocolCodec.commands.setSpeedEnable(tx, targetId, !!nextState.speedEnable, !!nextState.speedWindow),
        }];
      },
    },

    scrollHp: {
      key: "scrollHp",
      kind: "virtual",
      priority: 60,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "scrollHp", "scrollHp", pid);
        const tx = txForField(pid, "scrollHp");
        return [{
          packet: ProtocolCodec.commands.setScrollHP(
            tx,
            targetId,
            nextState.scrollHpMode,
            nextState.scrollHpWindowMs
          ),
        }];
      },
    },

    sensorAngle: {
      key: "sensorAngle",
      kind: "direct",
      priority: 61,
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "sensorAngle", "sensorAngle", pid);
        const tx = txForField(pid, "sensorAngle");
        return [{
          packet: ProtocolCodec.commands.setAngleTune(tx, targetId, nextState.sensorAngle),
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
      plan({ pid, caps, nextState, targetId }) {
        requireCapability(caps, "dpiStageColors", "dpiStageColors", pid);
        const tx = txForField(pid, "dpiStageColors");
        return [{
          packet: ProtocolCodec.commands.setDpiStageColors(tx, targetId, TRANSFORMERS.dpiStageColorsToBytes(nextState.dpiStageColors)),
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
        "competitiveMode",
        "hyperMode",
        "dpiXYOnOff",
        "dpiIndicator",
        "buttonCombine",
        "debounceTime",
        "speedEnable",
        "speedWindow",
        "scrollHpMode",
        "scrollHpWindowMs",
        "sensorAngle",
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
      if (Object.prototype.hasOwnProperty.call(patch, "competitiveMode")) {
        next.competitiveMode = normalizeBoolean(patch.competitiveMode, next.competitiveMode);
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
      if (Object.prototype.hasOwnProperty.call(patch, "scrollHpMode")) {
        next.scrollHpMode = TRANSFORMERS.normalizeScrollHpMode(patch.scrollHpMode, next.scrollHpMode);
        next.scrollHpWindowMs = TRANSFORMERS.normalizeScrollHpWindowMs(next.scrollHpWindowMs, 100);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "scrollHpWindowMs")) {
        next.scrollHpWindowMs = TRANSFORMERS.normalizeScrollHpWindowMs(patch.scrollHpWindowMs, next.scrollHpWindowMs);
        next.scrollHpMode = TRANSFORMERS.normalizeScrollHpMode(next.scrollHpMode, 0);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "sensorAngle")) {
        next.sensorAngle = TRANSFORMERS.normalizeSensorAngle(patch.sensorAngle, next.sensorAngle);
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
      if (has("competitiveMode")) keys.push("competitiveMode");
      if (has("hyperMode")) keys.push("hyperMode");
      if (has("dpiXYOnOff")) keys.push("dpiXYOnOff");
      if (has("dpiIndicator")) keys.push("dpiIndicator");
      if (has("buttonCombine")) keys.push("buttonCombine");
      if (has("debounceTime")) keys.push("debounceTime");
      if (has("speedEnable") || has("speedWindow")) keys.push("speedEnable");
      if (has("scrollHpMode") || has("scrollHpWindowMs")) keys.push("scrollHp");
      if (has("sensorAngle")) keys.push("sensorAngle");
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
      const targetId = normalizeProfileId(
        nextState.profileId ?? prevState?.profileId,
        CRDRAKO_PROFILE_ID_DEFAULT
      );

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
          targetId,
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
    2: 0x04,
    3: 0x05,
    4: 0x02,
    5: 0x03,
  });

  const DEFAULT_ACTION_LABEL_BY_BUTTON_ID = Object.freeze({
    1: "Left Click",
    2: "Back",
    3: "Forward",
    4: "Right Click",
    5: "Middle Click",
  });

  const CRDRAKO_KEYMAP_ACTION_TYPE = Object.freeze({
    OFF: 0x00,
    BUTTON_CODE: 0x01,
    KEYBOARD_CODE: 0x04,
    CONSUMER_KEYS: 0x05,
    DPI: 0x07,
  });

  const CRDRAKO_KEYBOARD_MODIFIER = Object.freeze({
    LEFT_CTRL: 0x01,
    LEFT_SHIFT: 0x02,
    LEFT_ALT: 0x04,
    LEFT_WIN: 0x08,
    RIGHT_CTRL: 0x10,
    RIGHT_SHIFT: 0x20,
    RIGHT_ALT: 0x40,
    RIGHT_WIN: 0x80,
  });

  const CRDRAKO_CONSUMER_USAGE = Object.freeze({
    VOLUME_UP: 0x00e9,
    VOLUME_DOWN: 0x00ea,
    MUTE: 0x00e2,
    PLAY_PAUSE: 0x00cd,
    NEXT_TRACK: 0x00b5,
    PREVIOUS_TRACK: 0x00b6,
    STOP: 0x00b7,
    CALCULATOR: 0x0192,
    THIS_PC: 0x0194,
    BROWSER: 0x0196,
    MAIL: 0x018a,
    MEDIA_PLAYER: 0x0183,
    WWW_HOME: 0x0223,
    WWW_REFRESH: 0x0227,
    LIGHTING_UP: 0x006f,
    LIGHTING_DOWN: 0x0070,
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

    const addKeyboardUsage = (label, usage) => {
      add(label, "keyboard", CRDRAKO_KEYMAP_ACTION_TYPE.KEYBOARD_CODE, clampU8(usage));
    };
    const addKeyboardModifier = (label, modifier) => {
      add(label, "keyboard", CRDRAKO_KEYMAP_ACTION_TYPE.KEYBOARD_CODE, (clampU8(modifier) << 8) & 0xffff);
    };
    const addKeyboardChord = (label, modifier, usage) => {
      add(label, "keyboard", CRDRAKO_KEYMAP_ACTION_TYPE.KEYBOARD_CODE, ((clampU8(modifier) << 8) | clampU8(usage)) & 0xffff);
    };
    const addConsumer = (label, usage) => {
      add(label, "system", CRDRAKO_KEYMAP_ACTION_TYPE.CONSUMER_KEYS, clampInt(usage, 0, 0xffff));
    };

    add("Disable", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.OFF, 0x0000);
    add("Left Click", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0001);
    add("Right Click", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0002);
    add("Middle Click", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0003);
    add("Back", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0004);
    add("Forward", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0005);
    add("Wheel Up", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0010);
    add("Wheel Down", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0011);
    add("DPI Loop Up", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.BUTTON_CODE, 0x0014);
    add("DPI Loop", "mouse", CRDRAKO_KEYMAP_ACTION_TYPE.DPI, 0x0006);

    for (let i = 0; i < 26; i++) {
      addKeyboardUsage(String.fromCharCode(65 + i), 0x04 + i);
    }
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    for (let i = 0; i < digits.length; i++) {
      addKeyboardUsage(digits[i], 0x1e + i);
    }
    for (let i = 1; i <= 12; i++) {
      addKeyboardUsage(`F${i}`, 0x39 + i);
    }

    [
      ["Enter", 0x28], ["Esc", 0x29], ["Backspace", 0x2a], ["Tab", 0x2b], ["Space", 0x2c],
      ["- _", 0x2d], ["= +", 0x2e], ["[ {", 0x2f], ["] }", 0x30], ["\\ |", 0x31],
      ["; :", 0x33], ["' \"", 0x34], ["` ~", 0x35], [", <", 0x36], [". >", 0x37], ["/ ?", 0x38],
      ["Caps Lock", 0x39], ["Print Screen", 0x46], ["Scroll Lock", 0x47], ["Pause", 0x48],
      ["Insert", 0x49], ["Home", 0x4a], ["Page Up", 0x4b], ["Delete", 0x4c], ["End", 0x4d],
      ["Page Down", 0x4e], ["Right Arrow", 0x4f], ["Left Arrow", 0x50], ["Down Arrow", 0x51],
      ["Up Arrow", 0x52], ["Num Lock", 0x53], ["Numpad /", 0x54], ["Numpad *", 0x55],
      ["Numpad -", 0x56], ["Numpad +", 0x57], ["Numpad Enter", 0x58], ["Numpad 1", 0x59],
      ["Numpad 2", 0x5a], ["Numpad 3", 0x5b], ["Numpad 4", 0x5c], ["Numpad 5", 0x5d],
      ["Numpad 6", 0x5e], ["Numpad 7", 0x5f], ["Numpad 8", 0x60], ["Numpad 9", 0x61],
      ["Numpad 0", 0x62], ["Numpad .", 0x63],
    ].forEach(([label, usage]) => addKeyboardUsage(label, usage));

    addKeyboardModifier("Left Ctrl", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL);
    addKeyboardModifier("Left Shift", CRDRAKO_KEYBOARD_MODIFIER.LEFT_SHIFT);
    addKeyboardModifier("Left Alt", CRDRAKO_KEYBOARD_MODIFIER.LEFT_ALT);
    addKeyboardModifier("Left Win", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN);
    addKeyboardModifier("Right Ctrl", CRDRAKO_KEYBOARD_MODIFIER.RIGHT_CTRL);
    addKeyboardModifier("Right Shift", CRDRAKO_KEYBOARD_MODIFIER.RIGHT_SHIFT);
    addKeyboardModifier("Right Alt", CRDRAKO_KEYBOARD_MODIFIER.RIGHT_ALT);
    addKeyboardModifier("Right Win", CRDRAKO_KEYBOARD_MODIFIER.RIGHT_WIN);

    addKeyboardChord("Copy Ctrl + C", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x06);
    addKeyboardChord("Paste Ctrl + V", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x19);
    addKeyboardChord("Cut Ctrl + X", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x1b);
    addKeyboardChord("Undo Ctrl + Z", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x1d);
    addKeyboardChord("Redo Ctrl + Y", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x1c);
    addKeyboardChord("Select All Ctrl + A", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x04);
    addKeyboardChord("Save Ctrl + S", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x16);
    addKeyboardChord("Find Ctrl + F", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x09);
    addKeyboardChord("New Ctrl + N", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x11);
    addKeyboardChord("Print Ctrl + P", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL, 0x13);
    addKeyboardChord("Switch Window Alt + Tab", CRDRAKO_KEYBOARD_MODIFIER.LEFT_ALT, 0x2b);
    addKeyboardChord("Close Window Alt + F4", CRDRAKO_KEYBOARD_MODIFIER.LEFT_ALT, 0x3d);
    addKeyboardChord("Show Desktop Win + D", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN, 0x07);
    addKeyboardChord("File Explorer Win + E", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN, 0x08);
    addKeyboardChord("Lock Computer Win + L", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN, 0x0f);
    addKeyboardChord("Run Win + R", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN, 0x15);
    addKeyboardChord("Open Settings Win + I", CRDRAKO_KEYBOARD_MODIFIER.LEFT_WIN, 0x0c);
    addKeyboardChord("Task Manager Ctrl + Shift + Esc", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL | CRDRAKO_KEYBOARD_MODIFIER.LEFT_SHIFT, 0x29);
    addKeyboardChord("Reopen Closed Tab Ctrl + Shift + T", CRDRAKO_KEYBOARD_MODIFIER.LEFT_CTRL | CRDRAKO_KEYBOARD_MODIFIER.LEFT_SHIFT, 0x17);

    addConsumer("Volume Up", CRDRAKO_CONSUMER_USAGE.VOLUME_UP);
    addConsumer("Volume Down", CRDRAKO_CONSUMER_USAGE.VOLUME_DOWN);
    addConsumer("Mute", CRDRAKO_CONSUMER_USAGE.MUTE);
    addConsumer("Play/Pause", CRDRAKO_CONSUMER_USAGE.PLAY_PAUSE);
    addConsumer("Next Track", CRDRAKO_CONSUMER_USAGE.NEXT_TRACK);
    addConsumer("Previous Track", CRDRAKO_CONSUMER_USAGE.PREVIOUS_TRACK);
    addConsumer("Stop", CRDRAKO_CONSUMER_USAGE.STOP);
    addConsumer("Calculator", CRDRAKO_CONSUMER_USAGE.CALCULATOR);
    addConsumer("This PC", CRDRAKO_CONSUMER_USAGE.THIS_PC);
    addConsumer("Browser", CRDRAKO_CONSUMER_USAGE.BROWSER);
    addConsumer("Mail", CRDRAKO_CONSUMER_USAGE.MAIL);
    addConsumer("Media Player", CRDRAKO_CONSUMER_USAGE.MEDIA_PLAYER);
    addConsumer("WWW Home", CRDRAKO_CONSUMER_USAGE.WWW_HOME);
    addConsumer("WWW Refresh", CRDRAKO_CONSUMER_USAGE.WWW_REFRESH);
    addConsumer("Lighting Up", CRDRAKO_CONSUMER_USAGE.LIGHTING_UP);
    addConsumer("Lighting Down", CRDRAKO_CONSUMER_USAGE.LIGHTING_DOWN);

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
    "dpi loop up": "DPI Loop Up",
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
    next: "Next Track",
    "next track": "Next Track",
    previous: "Previous Track",
    "previous track": "Previous Track",
    stop: "Stop",
    "stop playback": "Stop",
    calculator: "Calculator",
    "this pc": "This PC",
    "my computer": "This PC",
    browser: "Browser",
    mail: "Mail",
    "media player": "Media Player",
    "www home": "WWW Home",
    "www refresh": "WWW Refresh",
    "lighting up": "Lighting Up",
    "lighting down": "Lighting Down",
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
    if (
      fk === CRDRAKO_KEYMAP_ACTION_TYPE.KEYBOARD_CODE
      || fk === CRDRAKO_KEYMAP_ACTION_TYPE.CONSUMER_KEYS
    ) {
      return [(kc >> 8) & 0xff, kc & 0xff];
    }
    if (kc > 0) return [kc & 0xff];
    return [];
  }

  function decodeButtonPayload(funckey, payloadBytes = []) {
    const fk = clampU8(funckey);
    const bytes = Array.isArray(payloadBytes) ? payloadBytes : [];
    if (
      fk === CRDRAKO_KEYMAP_ACTION_TYPE.KEYBOARD_CODE
      || fk === CRDRAKO_KEYMAP_ACTION_TYPE.CONSUMER_KEYS
      || bytes.length >= 2
    ) {
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
    for (let i = 1; i <= CRDRAKO_KEYMAP_BUTTON_COUNT; i++) {
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
    const raw = response?.raw instanceof Uint8Array ? response.raw : new Uint8Array();
    const hi = clampInt(response?.hidIndex ?? 0, 0, 1);
    if (raw.length < 12 - hi) {
      return normalizeButtonMappingEntry(fallback || { source: "Unknown", funckey: 0, keycode: 0 });
    }
    const funckey = clampU8(raw[10 - hi] ?? 0);
    const payloadLen = clampInt(raw[11 - hi] ?? 0, 0, 16);
    const payloadStart = 12 - hi;
    const payload = Array.from(raw.slice(payloadStart, payloadStart + payloadLen)).map((x) => clampU8(x));
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
        minDpi: CRDRAKO_MIN_DPI,
        maxDpi: CRDRAKO_MAX_DPI,
        dpiStep: CRDRAKO_DPI_STEP,
        battery: !!caps.battery,
        charging: !!caps.charging,
        deviceIdleTime: !!caps.idle,
        surfaceFeel: !!caps.lod,
        lod: !!caps.lod,
        angleSnap: !!caps.angleSnap,
        motionSync: !!caps.motionSync,
        rippleControl: !!caps.rippleControl,
        competitiveMode: !!caps.competitiveMode,
        hyperMode: !!caps.hyperMode,
        dpiXYOnOff: !!caps.dpiXYOnOff,
        dpiIndicator: !!caps.dpiIndicator,
        buttonCombine: !!caps.buttonCombine,
        debounceTime: !!caps.debounceTime,
        speedEnable: !!caps.speedEnable,
        scrollHp: !!caps.scrollHp,
        sensorAngle: !!caps.sensorAngle,
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
        profileId: CRDRAKO_PROFILE_ID_DEFAULT,
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
        competitiveMode: false,
        hyperMode: false,
        dpiXYOnOff: false,
        dpiIndicator: false,
        buttonCombine: true,
        debounceTime: 8,
        speedEnable: false,
        speedWindow: 0,
        scrollHpMode: 0,
        scrollHpWindowMs: 100,
        sensorAngle: 0,
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
        const b = clampInt(btnId, 1, CRDRAKO_KEYMAP_BUTTON_COUNT);
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
        const targetId = normalizeProfileId(this._cfg?.profileId, CRDRAKO_PROFILE_ID_DEFAULT);
        await this._driver.sendAndWait(
          ProtocolCodec.commands.setButtonMapping(tx, targetId, sourceCode, action.funckey, payload),
          { checkHeader: false }
        );

        const next = Array.isArray(this._cfg?.buttonMappings)
          ? this._cfg.buttonMappings.slice(0, CRDRAKO_KEYMAP_BUTTON_COUNT)
          : buildDefaultButtonMappings();
        while (next.length < CRDRAKO_KEYMAP_BUTTON_COUNT) {
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
        out.batteryIsCharging = !!clampU8(bat.arguments[0] ?? 0);
        out.batteryPercent = TRANSFORMERS.batteryPercentFromRaw(bat.arguments[1] ?? 0);
        debugCrdrako("parsedValue", {
          feature: "battery",
          charge: out.batteryIsCharging,
          percent: out.batteryPercent,
        });
      }
      return out;
    }

    async _readButtonMappingsSnapshot({ strictStability = false, targetId = CRDRAKO_PROFILE_ID_DEFAULT } = {}) {
      void strictStability;
      const pid = this._ensureSupported();
      const tx = txForField(pid, "buttonMapping");
      const profileId = normalizeProfileId(targetId, this._cfg?.profileId ?? CRDRAKO_PROFILE_ID_DEFAULT);
      const out = Array.from({ length: CRDRAKO_KEYMAP_BUTTON_COUNT }, () => normalizeButtonMappingEntry({ source: "Unknown", funckey: 0, keycode: 0 }));

      for (let btnId = 1; btnId <= CRDRAKO_KEYMAP_BUTTON_COUNT; btnId++) {
        const sourceCode = DEFAULT_BUTTON_SOURCE_CODE_BY_BUTTON_ID[btnId];
        const fallback = normalizeButtonMappingEntry(this._cfg?.buttonMappings?.[btnId - 1], DEFAULT_ACTION_LABEL_BY_BUTTON_ID[btnId]);
        const res = await this._safeQuery(
          ProtocolCodec.commands.getButtonMapping(tx, profileId, sourceCode, fallback.funckey, encodeButtonPayload(fallback.funckey, fallback.keycode)),
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

      let targetId = normalizeProfileId(this._cfg?.profileId, CRDRAKO_PROFILE_ID_DEFAULT);
      const profile = await this._safeQuery(ProtocolCodec.commands.getProfileId(tx), null, { checkHeader: true });
      if (profile?.raw) {
        targetId = normalizeProfileId(profile.arguments?.[0] ?? targetId, targetId);
        updates.profileId = targetId;
      } else {
        updates.profileId = targetId;
      }

      const poll = await this._safeQuery(ProtocolCodec.commands.getPollingRate(tx, targetId), null, { checkHeader: false });
      if (poll?.raw) {
        const rawPolling = ProtocolCodec.valueAt(poll, 0, 0x01);
        updates.pollingHz = TRANSFORMERS.pollingDecode(rawPolling, this._cfg?.pollingHz ?? 1000);
        debugCrdrako("parsedValue", { feature: "pollingHz", raw: rawPolling, value: updates.pollingHz });
      }

      const dpiStagesRes = await this._safeQuery(
        ProtocolCodec.commands.getDpiStages(tx, targetId, CRDRAKO_MAX_DPI_STAGES),
        null,
        { checkHeader: true }
      );
      if (dpiStagesRes?.arguments) {
        const parsed = TRANSFORMERS.parseDpiStagesResponse(dpiStagesRes);
        if (parsed.dpiStages.length) {
          updates.dpiStages = parsed.dpiStages;
          debugCrdrako("parsedValue", { feature: "dpiStages", count: parsed.stageCount, value: parsed.dpiStages });
        }
      }

      const activeRes = await this._safeQuery(ProtocolCodec.commands.getActiveDpiStage(tx, targetId));
      if (activeRes?.raw) {
        const oneBased = clampInt(ProtocolCodec.valueAt(activeRes, 0, 1), 1, CRDRAKO_MAX_DPI_STAGES);
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
        const idleRes = await this._safeQuery(ProtocolCodec.commands.getSleepTime(tx, targetId));
        if (idleRes?.raw) {
          updates.deviceIdleTime = TRANSFORMERS.normalizeIdleTime(
            ((ProtocolCodec.valueAt(idleRes, 0, 0) << 8) | ProtocolCodec.valueAt(idleRes, 1, 0)) & 0xffff
          );
        }
      }

      if (caps.lod) {
        const lodRes = await this._safeQuery(ProtocolCodec.commands.getLod(tx, targetId));
        if (lodRes?.raw) {
          const rawLod = ProtocolCodec.valueAt(lodRes, 0, 1);
          updates.lod = TRANSFORMERS.lodFromRaw(rawLod, this._cfg?.lod ?? 1);
          debugCrdrako("parsedValue", { feature: "lod", raw: rawLod, value: updates.lod });
        }
      }

      if (caps.angleSnap) {
        const angle = await this._safeQuery(ProtocolCodec.commands.getAngleSnap(tx, targetId));
        if (angle?.raw) updates.angleSnap = !!ProtocolCodec.valueAt(angle, 0, 0);
      }
      if (caps.motionSync) {
        const motion = await this._safeQuery(ProtocolCodec.commands.getMotionSync(tx, targetId));
        if (motion?.raw) {
          updates.motionSync = !!ProtocolCodec.valueAt(motion, 0, 0);
          debugCrdrako("parsedValue", { feature: "motionSync", value: updates.motionSync });
        }
      }
      if (caps.rippleControl) {
        const ripple = await this._safeQuery(ProtocolCodec.commands.getRippleControl(tx, targetId));
        if (ripple?.raw) {
          updates.rippleControl = !!ProtocolCodec.valueAt(ripple, 0, 0);
          debugCrdrako("parsedValue", { feature: "rippleControl", value: updates.rippleControl });
        }
      }
      if (caps.competitiveMode) {
        const competitive = await this._safeQuery(ProtocolCodec.commands.getCompetitiveMode(tx, targetId));
        if (competitive?.raw) {
          updates.competitiveMode = !!ProtocolCodec.valueAt(competitive, 0, 0);
          debugCrdrako("parsedValue", { feature: "competitiveMode", value: updates.competitiveMode });
        }
      }
      if (caps.hyperMode) {
        const hyper = await this._safeQuery(ProtocolCodec.commands.getHyperMode(tx, targetId));
        if (hyper?.raw) updates.hyperMode = !!ProtocolCodec.valueAt(hyper, 0, 0);
      }
      if (caps.dpiXYOnOff) {
        const dpixy = await this._safeQuery(ProtocolCodec.commands.getDpiXyOnOff(tx, targetId));
        if (dpixy?.raw) updates.dpiXYOnOff = !!ProtocolCodec.valueAt(dpixy, 0, 0);
      }
      if (caps.dpiIndicator) {
        const indicator = await this._safeQuery(ProtocolCodec.commands.getDpiIndicator(tx, targetId));
        if (indicator?.raw) updates.dpiIndicator = !!ProtocolCodec.valueAt(indicator, 0, 0);
      }
      if (caps.buttonCombine) {
        const combine = await this._safeQuery(ProtocolCodec.commands.getButtonCombine(tx, targetId));
        if (combine?.raw) updates.buttonCombine = !!ProtocolCodec.valueAt(combine, 0, 0);
      }
      if (caps.debounceTime) {
        const debounce = await this._safeQuery(ProtocolCodec.commands.getDebounceTime(tx, targetId));
        if (debounce?.raw) {
          const rawDebounce = ProtocolCodec.valueAt(debounce, 0, 8);
          updates.debounceTime = TRANSFORMERS.normalizeDebounceTime(rawDebounce);
          debugCrdrako("parsedValue", { feature: "debounceTime", raw: rawDebounce, value: updates.debounceTime });
        }
      }
      if (caps.speedEnable) {
        const speed = await this._safeQuery(ProtocolCodec.commands.getSpeedEnable(tx, targetId));
        if (speed?.raw) {
          updates.speedEnable = !!ProtocolCodec.valueAt(speed, 0, 0);
          updates.speedWindow = !!ProtocolCodec.valueAt(speed, 1, 0);
        }
      }
      if (caps.scrollHp) {
        const scrollHp = await this._safeQuery(ProtocolCodec.commands.getScrollHP(tx, targetId));
        if (scrollHp?.raw) {
          const mode = ProtocolCodec.valueAt(scrollHp, 0, 0);
          const windowTime = (ProtocolCodec.valueAt(scrollHp, 1, 0) << 8)
            + ProtocolCodec.valueAt(scrollHp, 2, 0);
          updates.scrollHpMode = TRANSFORMERS.normalizeScrollHpMode(mode, this._cfg?.scrollHpMode ?? 0);
          updates.scrollHpWindowMs = TRANSFORMERS.normalizeScrollHpWindowMs(
            windowTime,
            this._cfg?.scrollHpWindowMs ?? 100
          );
        }
      }
      if (caps.sensorAngle) {
        const angleTune = await this._safeQuery(ProtocolCodec.commands.getAngleTune(tx, targetId));
        if (angleTune?.raw) {
          updates.sensorAngle = TRANSFORMERS.sensorAngleFromRaw(ProtocolCodec.valueAt(angleTune, 0, 0));
        }
      }
      if (caps.lightness) {
        const lightnessTx = txForField(pid, "lightness");
        const lightness = await this._safeQuery(ProtocolCodec.commands.getLightness(lightnessTx));
        if (lightness?.arguments) updates.lightness = TRANSFORMERS.normalizeLightness(lightness.arguments[2] ?? 100);
      }
      if (caps.lightingEffect) {
        const lightingTx = txForField(pid, "lightingEffect");
        const effect = await this._safeQuery(ProtocolCodec.commands.getLightEffect(lightingTx, 0, 8));
        if (effect?.arguments) updates.lightingEffect = TRANSFORMERS.parseLightingEffectResponse(effect);
      }
      if (caps.dpiStageColors) {
        const colors = await this._safeQuery(ProtocolCodec.commands.getDpiStageColors(tx, targetId));
        if (colors?.arguments) updates.dpiStageColors = TRANSFORMERS.parseDpiStageColorsResponse(colors);
      }
      if (caps.keyMapping) {
        const mappings = await this._readButtonMappingsSnapshot({ strictStability: !!strictButtonMappingRead, targetId });
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

  ProtocolApi.CRDRAKO_HID = {
    vendorId: CRDRAKO_VENDOR_ID,
    productIds: SUPPORTED_PIDS.slice(0),
    defaultFilters: SUPPORTED_PIDS.map((productId) => ({
      vendorId: CRDRAKO_VENDOR_ID,
      productId,
    })),
    isSupportedPid(productId) {
      return SUPPORTED_PID_SET.has(Number(productId));
    },
  };
  ProtocolApi.RAZER_HID = ProtocolApi.CRDRAKO_HID;

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
    ProtocolApi.MOUSE_HID = ProtocolApi.CRDRAKO_HID;
  }

  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
  ProtocolApi.CrdrakoHidApi = MouseMouseHidApi;
  ProtocolApi.RazerHidApi = MouseMouseHidApi;
})();
