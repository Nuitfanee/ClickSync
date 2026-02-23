(() => {
  "use strict";

  // ============================================================
  // 0) Errors and basic helpers
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
    if (!Number.isFinite(x)) {
      throw new ProtocolError(`${name} is not a finite number`, "BAD_PARAM", { name, value: n });
    }
    return x;
  }

  function clampInt(n, min, max) {
    const x = Math.trunc(Number(n));
    if (!Number.isFinite(x)) return min;
    return Math.min(max, Math.max(min, x));
  }

  function clampNumber(n, min, max, fallback = min) {
    const x = Number(n);
    if (!Number.isFinite(x)) return fallback;
    return Math.min(max, Math.max(min, x));
  }

  function toU8(n) {
    return clampInt(n, 0, 0xff);
  }

  function toI8(n) {
    const x = clampInt(n, -128, 127);
    return x < 0 ? 0x100 + x : x;
  }

  function u16leBytes(n) {
    const v = clampInt(n, 0, 0xffff);
    return [v & 0xff, (v >> 8) & 0xff];
  }

  function bytesToHex(bytes) {
    const arr = bytes instanceof Uint8Array
      ? Array.from(bytes)
      : (Array.isArray(bytes) ? bytes : []);
    return arr.map((b) => toU8(b).toString(16).padStart(2, "0")).join("");
  }

  function hexToU8(hex) {
    const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
    if (clean.length % 2 !== 0) {
      throw new ProtocolError(`Invalid hex length: ${hex}`, "BAD_HEX");
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function deepClone(v) {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch (_) {
      if (Array.isArray(v)) return v.slice(0);
      if (isObject(v)) return { ...v };
      return v;
    }
  }

  function normalizeColorHex(raw, fallback = "#11119a") {
    const fail = String(fallback || "#11119a").toLowerCase();
    if (typeof raw === "string") {
      const s = raw.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
      if (/^#[0-9a-fA-F]{3}$/.test(s)) {
        const r = s[1];
        const g = s[2];
        const b = s[3];
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
      }
      return fail;
    }
    if (Array.isArray(raw) && raw.length >= 3) {
      const r = toU8(raw[0]).toString(16).padStart(2, "0");
      const g = toU8(raw[1]).toString(16).padStart(2, "0");
      const b = toU8(raw[2]).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }
    if (isObject(raw)) {
      const r = toU8(raw.r).toString(16).padStart(2, "0");
      const g = toU8(raw.g).toString(16).padStart(2, "0");
      const b = toU8(raw.b).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }
    return fail;
  }

  function trimTrailingZeros(u8) {
    const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
    let end = arr.length;
    while (end > 0 && arr[end - 1] === 0x00) end--;
    return arr.subarray(0, end);
  }

  // ============================================================
  // 1) Ninjutso protocol constants
  // ============================================================
  const HID_CONST = Object.freeze({
    VID: 0x093a,
    PID: 0xeb02,
    MAIN_RID: 0x06,
    SECURE_RID: 0x03,
    MAIN_PACKET_SIZE: 15,
    SECURE_PACKET_SIZE: 63,
    DEFAULT_PROFILE_ID: 0x01,
  });

  const CMD = Object.freeze({
    // Base controls
    POLLING_W: 0x05,
    POLLING_R: 0x06,
    LOD_W: 0x07,
    LOD_R: 0x08,
    PERF_W: 0x0b,
    PERF_R: 0x0c,
    DEBOUNCE_W: 0x29,
    DEBOUNCE_R: 0x2a,
    HYPER_W: 0x16,
    HYPER_R: 0x17,
    BURST_W: 0x31,
    BURST_R: 0x32,
    SLEEP_W: 0x18,
    SLEEP_R: 0x19,
    DPI_INDEX_W: 0x1b,
    DPI_INDEX_R: 0x1c,
    DPI_COUNT_W: 0x1d,
    DPI_COUNT_R: 0x1e,
    FACTORY_RESET_W: 0x14,
    PAIR_W: 0x1a,
    BATTERY_R: 0x12,
    PROFILE_W: 0x0f,
    PROFILE_R: 0x10,

    // Advanced
    DPI_VALUE_W: 0x03,
    DPI_VALUE_R: 0x04,
    KEYMAP_W: 0x01,
    KEYMAP_R: 0x02,

    // LED
    LED_ENABLED_W: 0x25,
    LED_ENABLED_R: 0x26,
    LED_BRIGHTNESS_W: 0x2f,
    LED_BRIGHTNESS_R: 0x30,
    LED_MODE_W: 0x1f,
    LED_MODE_R: 0x20,
    LED_SPEED_W: 0x27,
    LED_SPEED_R: 0x28,
    LED_COLOR_W: 0x21,
    LED_COLOR_R: 0x22,

    // Firmware info
    VERSION_R: 0x15,
    COLOR_R: 0xa3,
    PAIR_PID_R: 0xa7,
  });

  // Packet byte[6] policy:
  // - profile-scoped commands: byte[6] = active profile id
  // - global commands: byte[6] = fixed value (usually 0x00)
  const PROFILE_BYTE_MODE = Object.freeze({
    ACTIVE: "active",
    FIXED: "fixed",
  });

  const CMD_PACKET_META = Object.freeze({
    [CMD.PROFILE_W]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.PROFILE_R]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.BATTERY_R]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.VERSION_R]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.COLOR_R]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.PAIR_PID_R]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.PAIR_W]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
    [CMD.FACTORY_RESET_W]: Object.freeze({ profileByteMode: PROFILE_BYTE_MODE.FIXED, fixedProfileByte: 0x00 }),
  });

  function getCmdPacketMeta(cmd) {
    const opcode = toU8(cmd);
    return CMD_PACKET_META[opcode] || null;
  }

  function isProfileScopedCommand(cmd) {
    const meta = getCmdPacketMeta(cmd);
    if (!meta) return true;
    return meta.profileByteMode !== PROFILE_BYTE_MODE.FIXED;
  }

  function resolveCommandProfileByte(cmd, requestedProfileId = HID_CONST.DEFAULT_PROFILE_ID) {
    const meta = getCmdPacketMeta(cmd);
    if (!meta) return toU8(requestedProfileId);
    if (meta.profileByteMode === PROFILE_BYTE_MODE.FIXED) {
      return toU8(meta.fixedProfileByte ?? 0x00);
    }
    return toU8(requestedProfileId);
  }

  const SECURE_UNLOCK_U8 = (() => {
    const out = new Uint8Array(HID_CONST.SECURE_PACKET_SIZE);
    out.set([0x1b, 0x1a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], 0);
    return out;
  })();
  const SECURE_LOCK_U8 = (() => {
    const out = new Uint8Array(HID_CONST.SECURE_PACKET_SIZE);
    out.set([0x1c, 0x1b, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00], 0);
    return out;
  })();
  const SECURE_UNLOCK_HEX = bytesToHex(SECURE_UNLOCK_U8);
  const SECURE_LOCK_HEX = bytesToHex(SECURE_LOCK_U8);

  // ============================================================
  // 2) Transport layer
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
      this.defaultInterCmdDelayMs = 12;
    }

    setDevice(device) {
      this.device = device || null;
    }

    _requireDeviceOpen() {
      if (!this.device) throw new ProtocolError("HID device not injected", "NO_DEVICE");
      if (!this.device.opened) throw new ProtocolError("HID device is not open", "NOT_OPEN");
    }

    _fitToPacketSize(u8, reportId) {
      const src = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
      const rid = Number(reportId);
      let targetSize = src.byteLength;
      if (rid === HID_CONST.MAIN_RID) targetSize = HID_CONST.MAIN_PACKET_SIZE;
      else if (rid === HID_CONST.SECURE_RID) targetSize = HID_CONST.SECURE_PACKET_SIZE;

      if (src.byteLength === targetSize) return src;
      const out = new Uint8Array(targetSize);
      out.set(src.subarray(0, targetSize));
      return out;
    }

    async _withTimeout(promise, timeoutMs = this.sendTimeoutMs) {
      const ms = clampInt(timeoutMs, 1, 60_000);
      return await Promise.race([
        promise,
        sleep(ms).then(() => {
          throw new ProtocolError(`I/O timeout (${ms}ms)`, "IO_TIMEOUT");
        }),
      ]);
    }

    async _sendReportDirect(reportId, hex) {
      this._requireDeviceOpen();
      const rid = Number(reportId);
      const payload = this._fitToPacketSize(hexToU8(hex), rid);
      const dev = this.device;
      try {
        await this._withTimeout(dev.sendFeatureReport(rid, payload));
        return;
      } catch (e) {
        throw new ProtocolError(`write failed: sendFeatureReport: ${String(e?.message || e)}`, "IO_WRITE_FAIL", { rid });
      }
    }

    async _receiveFeatureReportDirect(reportId, timeoutMs = null) {
      this._requireDeviceOpen();
      const rid = Number(reportId);
      const ms = timeoutMs == null ? this.sendTimeoutMs : Number(timeoutMs);
      const dv = await this._withTimeout(this.device.receiveFeatureReport(rid), ms);
      if (!dv) return new Uint8Array(0);
      return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    }

    async sendHex(reportId, hex) {
      return this.queue.enqueue(() => this._sendReportDirect(Number(reportId), String(hex)));
    }

    async receiveFeatureReport(reportId, { timeoutMs = null } = {}) {
      return this.queue.enqueue(() => this._receiveFeatureReportDirect(Number(reportId), timeoutMs));
    }

    async sendAndReceiveFeature({ rid, hex, featureRid = HID_CONST.MAIN_RID, waitMs = null }) {
      const wait = waitMs != null ? Number(waitMs) : this.defaultInterCmdDelayMs;
      return this.queue.enqueue(async () => {
        await this._sendReportDirect(Number(rid), String(hex));
        if (wait > 0) await sleep(wait);
        return await this._receiveFeatureReportDirect(Number(featureRid));
      });
    }

    async runSequence(seq) {
      if (!Array.isArray(seq) || !seq.length) return;
      for (const cmd of seq) {
        await this.sendHex(Number(cmd?.rid ?? HID_CONST.MAIN_RID), String(cmd?.hex || ""));
        const w = cmd?.waitMs != null ? Number(cmd.waitMs) : this.defaultInterCmdDelayMs;
        if (w > 0) await sleep(w);
      }
    }

    async unlockGate() {
      await this.sendHex(HID_CONST.SECURE_RID, SECURE_UNLOCK_HEX);
    }

    async lockGate() {
      await this.sendHex(HID_CONST.SECURE_RID, SECURE_LOCK_HEX);
    }
  }

  // ============================================================
  // 3) Codec layer (Ninjutso main command packet = 15 bytes)
  // ============================================================
  const ProtocolCodec = Object.freeze({
    buildPacket({ cmd, lenOrIdx = 0x00, profileId = HID_CONST.DEFAULT_PROFILE_ID, dataBytes = [] }) {
      const out = new Uint8Array(HID_CONST.MAIN_PACKET_SIZE);
      const opcode = toU8(cmd);
      out[0] = opcode;
      out[1] = 0x00;
      out[2] = 0x00;
      out[3] = 0x01;
      out[4] = 0x00;
      out[5] = toU8(lenOrIdx);
      out[6] = resolveCommandProfileByte(opcode, profileId);

      const payload = Array.isArray(dataBytes)
        ? dataBytes.map(toU8)
        : (dataBytes instanceof Uint8Array ? Array.from(dataBytes).map(toU8) : []);
      const max = Math.max(0, HID_CONST.MAIN_PACKET_SIZE - 7);
      out.set(payload.slice(0, max), 7);
      return out;
    },

    write({ cmd, lenOrIdx = null, profileId = HID_CONST.DEFAULT_PROFILE_ID, dataBytes = [] }) {
      const bytes = Array.isArray(dataBytes)
        ? dataBytes.map(toU8)
        : (dataBytes instanceof Uint8Array ? Array.from(dataBytes).map(toU8) : []);
      const l = lenOrIdx == null ? bytes.length : toU8(lenOrIdx);
      return bytesToHex(this.buildPacket({ cmd, lenOrIdx: l, profileId, dataBytes: bytes }));
    },

    read({ cmd, lenOrIdx = 0x00, profileId = HID_CONST.DEFAULT_PROFILE_ID, dataBytes = [] }) {
      const bytes = Array.isArray(dataBytes)
        ? dataBytes.map(toU8)
        : (dataBytes instanceof Uint8Array ? Array.from(dataBytes).map(toU8) : []);
      return bytesToHex(this.buildPacket({ cmd, lenOrIdx, profileId, dataBytes: bytes }));
    },

    secureUnlockPacket() {
      return SECURE_UNLOCK_HEX;
    },

    secureLockPacket() {
      return SECURE_LOCK_HEX;
    },
  });

  function parseMainResponseFrame(featureU8, expectedCmd = null) {
    const u8 = featureU8 instanceof Uint8Array ? featureU8 : new Uint8Array(featureU8 || []);
    if (!u8.length) {
      throw new ProtocolError("empty feature report payload", "IO_READ_FAIL");
    }

    if (u8.length < 9) {
      throw new ProtocolError("response payload is too short", "IO_READ_FAIL", { hex: bytesToHex(u8) });
    }
    if (u8[0] !== HID_CONST.MAIN_RID) {
      throw new ProtocolError("response rid mismatch", "IO_READ_FAIL", {
        expectedRid: HID_CONST.MAIN_RID,
        gotRid: toU8(u8[0]),
        hex: bytesToHex(u8),
      });
    }

    const selected = {
      frame: "with_rid_echo",
      cmd: toU8(u8[1]),
      len: toU8(u8[6]),
      dataOffset: 8,
    };
    if (expectedCmd != null) {
      const expect = toU8(expectedCmd);
      if (selected.cmd !== expect) {
        throw new ProtocolError("response command mismatch", "IO_CMD_MISMATCH", {
          expectedCmd: expect,
          observedCmd: selected.cmd,
          frame: selected.frame,
          hex: bytesToHex(u8),
        });
      }
    }

    const remaining = Math.max(0, u8.length - selected.dataOffset);
    const declared = clampInt(selected.len, 0, 255);
    const usedLen = declared > 0 ? Math.min(declared, remaining) : remaining;
    const data = u8.subarray(selected.dataOffset, selected.dataOffset + usedLen);

    return {
      frame: selected.frame,
      cmd: selected.cmd,
      declaredLen: declared,
      data,
      raw: u8,
    };
  }

  function decodeReadData(featureU8, { expectedCmd = null, expectedLen = null } = {}) {
    const frame = parseMainResponseFrame(featureU8, expectedCmd);
    let data = frame.data;

    if (expectedLen != null) {
      const need = clampInt(expectedLen, 0, 255);
      if (need === 0) return new Uint8Array(0);
      if (data.length < need) {
        throw new ProtocolError("response payload is shorter than expected", "IO_READ_FAIL", {
          expectedCmd: expectedCmd == null ? null : toU8(expectedCmd),
          got: data.length,
          need,
          frame: frame.frame,
          hex: bytesToHex(frame.raw),
        });
      }
      return data.subarray(0, need);
    }

    if (frame.declaredLen > 0) return data;
    return trimTrailingZeros(data);
  }

  // ============================================================
  // 4) Profile + aliases
  // ============================================================
  const DEFAULT_PROFILE = Object.freeze({
    id: "ninjutso-default",
    capabilities: Object.freeze({
      dpiSlotMax: 4,
      dpiMin: 100,
      dpiMax: 26000,
      dpiStep: 1,
      pollingRates: Object.freeze([1000, 2000, 4000, 8000]),
      performanceModes: Object.freeze(["hp", "sport", "oc"]),
      lodModes: Object.freeze(["ultra", "low", "mid"]),
      debounceLevels: Object.freeze(["low", "mid", "high"]),
      ledModes: Object.freeze(["static", "marquee"]),
      ledBrightnessPercents: Object.freeze([25, 50, 75, 100]),
    }),
    timings: Object.freeze({
      interCmdDelayMs: 12,
      secureGateWaitMs: 10,
      configReadDelayMs: 15,
      configReadRetries: 4,
    }),
    compat: Object.freeze({
      // Older devices may encode DPI as (value + 1) * 50; disabled by default for V3 alignment.
      dpiDecodeLegacyScale50: false,
    }),
  });

  const KEY_ALIASES = Object.freeze({
    polling_rate: "pollingHz",
    pollingHz: "pollingHz",

    lod_height: "lodHeight",
    lodHeight: "lodHeight",

    performance_mode: "performanceMode",
    performanceMode: "performanceMode",

    debounce_ms: "debounceMs",
    debounceMs: "debounceMs",
    debounce_level: "debounceLevel",
    debounceLevel: "debounceLevel",

    hyper_click: "hyperClick",
    hyperClick: "hyperClick",

    burst: "burstEnabled",
    burstEnabled: "burstEnabled",

    sleep_seconds: "sleepSeconds",
    sleepSeconds: "sleepSeconds",
    sleep_time: "sleepSeconds",
    sleepTime: "sleepSeconds",
    sleepTimeout: "sleepSeconds",
    sleep_timeout: "sleepSeconds",

    current_slot_count: "currentSlotCount",
    currentSlotCount: "currentSlotCount",
    slot_count: "currentSlotCount",

    current_dpi_index: "currentDpiIndex",
    currentDpiIndex: "currentDpiIndex",
    dpi_index: "currentDpiIndex",
    activeDpiSlotIndex: "currentDpiIndex",

    dpi_slots: "dpiSlots",
    dpiSlots: "dpiSlots",
    dpi_slots_x: "dpiSlotsX",
    dpiSlotsX: "dpiSlotsX",
    dpi_slots_y: "dpiSlotsY",
    dpiSlotsY: "dpiSlotsY",

    led_enabled: "ledEnabled",
    ledEnabled: "ledEnabled",
    led_brightness: "ledBrightness",
    ledBrightness: "ledBrightness",
    led_mode: "ledMode",
    ledMode: "ledMode",
    led_speed: "ledSpeed",
    ledSpeed: "ledSpeed",
    led_color: "ledColor",
    ledColor: "ledColor",

    protocol_profile_id: "protocolProfileId",
    protocolProfileId: "protocolProfileId",
    profileId: "protocolProfileId",

    dpiProfile: "dpiProfile",
    ledProfile: "ledProfile",
  });

  const KNOWN_PATCH_KEYS = new Set([
    "pollingHz",
    "lodHeight",
    "performanceMode",
    "debounceMs",
    "debounceLevel",
    "hyperClick",
    "burstEnabled",
    "sleepSeconds",
    "currentSlotCount",
    "currentDpiIndex",
    "dpiSlots",
    "dpiSlotsX",
    "dpiSlotsY",
    "ledEnabled",
    "ledBrightness",
    "ledMode",
    "ledSpeed",
    "ledColor",
    "protocolProfileId",
    "dpiProfile",
    "ledProfile",
  ]);

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
  // 5) Transformers / Decoders
  // ============================================================
  const TRANSFORMERS = Object.freeze({
    boolU8(v) {
      return v ? 0x01 : 0x00;
    },

    profileIdU8(v) {
      return clampInt(assertFiniteNumber(v, "protocolProfileId"), 0, 0xff);
    },

    pollingHzCode(hz) {
      const n = clampInt(assertFiniteNumber(hz, "pollingHz"), 1000, 8000);
      const map = new Map([
        [1000, 0x01],
        [2000, 0x02],
        [4000, 0x03],
        [8000, 0x04],
      ]);
      const code = map.get(n);
      if (code == null) {
        throw new ProtocolError(`unsupported pollingHz: ${hz}`, "FEATURE_UNSUPPORTED", {
          allowed: [1000, 2000, 4000, 8000],
        });
      }
      return code;
    },

    lodHeightCode(v) {
      const s = String(v || "").trim().toLowerCase();
      if (s === "ultra") return 0x00;
      if (s === "low") return 0x01;
      if (s === "mid" || s === "middle" || s === "medium" || s === "high") return 0x02;
      throw new ProtocolError(`unsupported lodHeight: ${v}`, "BAD_PARAM");
    },

    performanceModeCode(v) {
      const s = String(v || "").trim().toLowerCase();
      const map = {
        hp: 0x00,
        standard: 0x00,
        std: 0x00,
        sport: 0x01,
        oc: 0x02,
      };
      if (!(s in map)) throw new ProtocolError(`unsupported performanceMode: ${v}`, "BAD_PARAM");
      return map[s];
    },

    debounceLevelCode(v) {
      if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "low") return 0x00;
        if (s === "mid" || s === "middle" || s === "medium") return 0x01;
        if (s === "high") return 0x02;
      }
      const n = Number(v);
      if (Number.isFinite(n)) {
        if (n >= 0 && n <= 2) return clampInt(n, 0, 2);
        const ms = Math.max(0, n);
        if (ms <= 3) return 0x00;
        if (ms <= 7) return 0x01;
        return 0x02;
      }
      throw new ProtocolError(`unsupported debounce value: ${v}`, "BAD_PARAM");
    },

    debounceMsFromLevel(level) {
      const l = clampInt(level, 0, 2);
      if (l === 0) return 2;
      if (l === 1) return 5;
      return 10;
    },

    sleepMinutesFromSeconds(v) {
      const sec = assertFiniteNumber(v, "sleepSeconds");
      const s = Math.trunc(sec);
      if (s <= 0 || s !== sec) {
        throw new ProtocolError("sleepSeconds must be a positive integer", "BAD_PARAM", { sleepSeconds: v });
      }
      if (s % 60 !== 0) {
        throw new ProtocolError("sleepSeconds must be a multiple of 60", "BAD_PARAM", { sleepSeconds: v });
      }
      const min = s / 60;
      if (min < 1 || min > 15) {
        throw new ProtocolError("sleepSeconds out of range (1~15 min)", "BAD_PARAM", { sleepSeconds: v });
      }
      return toU8(min);
    },

    slotCountU8(v) {
      return clampInt(assertFiniteNumber(v, "currentSlotCount"), 1, 4);
    },

    dpiIndexU8(v, state) {
      const count = clampInt(Number(state?.currentSlotCount ?? 1), 1, 4);
      return clampInt(assertFiniteNumber(v, "currentDpiIndex"), 0, count - 1);
    },

    dpiValuePayload(v, profile) {
      const cap = profile?.capabilities || DEFAULT_PROFILE.capabilities;
      const n = clampNumber(assertFiniteNumber(v, "dpi"), cap.dpiMin, cap.dpiMax, cap.dpiMin);
      const intPart = Math.trunc(n);
      const decimalTenth = clampInt(Math.round((n - intPart) * 10), 0, 9);
      return [...u16leBytes(intPart), decimalTenth];
    },

    ledBrightnessCode(v) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 1 && n <= 4) return clampInt(n, 1, 4);
      if (!Number.isFinite(n)) throw new ProtocolError("ledBrightness must be a number", "BAD_PARAM");
      if (n <= 25) return 0x01;
      if (n <= 50) return 0x02;
      if (n <= 75) return 0x03;
      return 0x04;
    },

    ledModeCode(v) {
      const s = String(v || "").trim().toLowerCase();
      if (s === "static" || s === "solid" || s === "on") return 0x01;
      if (s === "marquee" || s === "running" || s === "rainbow") return 0x03;
      throw new ProtocolError(`unsupported ledMode: ${v}`, "BAD_PARAM");
    },

    ledSpeedU8(v) {
      const n = clampInt(assertFiniteNumber(v, "ledSpeed"), 0, 20);
      return toU8(20 - n); // 修正：协议值 = 20 - 设定值
    },

    ledColorBytes(v) {
      const hex = normalizeColorHex(v, "#11119a");
      const m = /^#([0-9a-f]{6})$/.exec(hex);
      if (!m) return [0x11, 0x11, 0x9a];
      const s = m[1];
      return [
        parseInt(s.slice(0, 2), 16),
        parseInt(s.slice(2, 4), 16),
        parseInt(s.slice(4, 6), 16),
      ];
    },

    keymapPayloadBytes(srcKey, action) {
      const src = clampInt(assertFiniteNumber(srcKey, "srcKey"), 1, 6);
      const fk = toU8(action?.funckey ?? action?.func ?? 0);
      const kc = clampInt(Number(action?.keycode ?? action?.code ?? 0), 0, 0xffff);

      if (fk === 0x01) {
        const mouseFn = clampInt(kc, 0, 4);
        return [src, 0x01, mouseFn, 0x00, 0x00];
      }

      if (fk === 0x02) {
        const mod = (kc >> 8) & 0xff;
        const key = kc & 0xff;
        return [src, 0x02, mod, key, 0x00];
      }

      if (fk === 0x00 && kc === 0x0000) {
        return [src, 0x02, 0x00, 0x00, 0x00];
      }

      throw new ProtocolError(`unsupported key action (${fk}, ${kc})`, "FEATURE_UNSUPPORTED");
    },
  });

  const DECODERS = Object.freeze({
    bool(v) {
      return Number(v) !== 0;
    },

    pollingHzFromCode(code) {
      const map = new Map([
        [0x01, 1000],
        [0x02, 2000],
        [0x03, 4000],
        [0x04, 8000],
      ]);
      return map.get(toU8(code)) ?? 1000;
    },

    lodHeightFromCode(code) {
      const c = toU8(code);
      if (c === 0x00) return "ultra";
      if (c === 0x01) return "low";
      return "mid";
    },

    performanceModeFromCode(code) {
      const c = toU8(code);
      if (c === 0x01) return "sport";
      if (c === 0x02) return "oc";
      return "hp";
    },

    debounceFromReadByte(code) {
      const c = toU8(code);
      if (c <= 0x02) {
        const level = c === 0 ? "low" : (c === 1 ? "mid" : "high");
        return { debounceLevel: level, debounceMs: TRANSFORMERS.debounceMsFromLevel(c) };
      }
      const ms = c;
      const level = ms <= 3 ? "low" : (ms <= 7 ? "mid" : "high");
      return { debounceLevel: level, debounceMs: ms };
    },

    sleepSecondsFromMinutes(code) {
      return clampInt(code, 1, 15) * 60;
    },

    ledBrightnessFromCode(code) {
      const c = toU8(code);
      if (c === 0x01) return 25;
      if (c === 0x02) return 50;
      if (c === 0x03) return 75;
      return 100;
    },

    ledModeFromCode(code) {
      return toU8(code) === 0x03 ? "marquee" : "static";
    },

    ledSpeedFromCode(code) {
      return clampInt(20 - toU8(code), 0, 20);
    },

    keymapAction(bytes) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      if (u8.length < 4) return { srcKey: 0, funckey: 0, keycode: 0 };
      const src = toU8(u8[0]);
      const type = toU8(u8[1]);
      const d1 = toU8(u8[2]);
      const d2 = toU8(u8[3]);

      if (type === 0x01) {
        return { srcKey: src, funckey: 0x01, keycode: d1 };
      }
      if (type === 0x02) {
        if (d1 === 0x00 && d2 === 0x00) return { srcKey: src, funckey: 0x00, keycode: 0x0000 };
        return { srcKey: src, funckey: 0x02, keycode: (d1 << 8) | d2 };
      }
      return { srcKey: src, funckey: 0x00, keycode: 0x0000 };
    },
  });

  // ============================================================
  // 6) SPEC table (configuration-driven)
  // ============================================================
  const SPEC = Object.freeze({
    protocolProfileId: {
      key: "protocolProfileId",
      kind: "direct",
      priority: 5,
      encode(value) {
        return {
          cmd: CMD.PROFILE_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.profileIdU8(value)],
        };
      },
    },

    pollingHz: {
      key: "pollingHz",
      kind: "direct",
      priority: 10,
      validate(patch, nextState, profile) {
        const hz = Number(nextState.pollingHz);
        const allowed = profile?.capabilities?.pollingRates || [];
        if (!allowed.includes(hz)) {
          throw new ProtocolError(`unsupported pollingHz: ${hz}`, "FEATURE_UNSUPPORTED", { allowed });
        }
      },
      encode(value) {
        return {
          cmd: CMD.POLLING_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.pollingHzCode(value)],
        };
      },
    },

    performanceMode: {
      key: "performanceMode",
      kind: "direct",
      priority: 20,
      encode(value) {
        return {
          cmd: CMD.PERF_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.performanceModeCode(value)],
        };
      },
    },

    lodHeight: {
      key: "lodHeight",
      kind: "direct",
      priority: 30,
      encode(value) {
        return {
          cmd: CMD.LOD_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.lodHeightCode(value)],
        };
      },
    },

    debounceLevel: {
      key: "debounceLevel",
      kind: "direct",
      priority: 35,
      encode(value) {
        return {
          cmd: CMD.DEBOUNCE_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.debounceLevelCode(value)],
        };
      },
    },

    debounceMs: {
      key: "debounceMs",
      kind: "virtual",
      priority: 36,
      triggers: ["debounceMs"],
      plan(patch, nextState) {
        if (!("debounceMs" in patch)) return [];
        const levelCode = TRANSFORMERS.debounceLevelCode(nextState.debounceMs);
        return [{
          cmd: CMD.DEBOUNCE_W,
          lenOrIdx: 0x01,
          dataBytes: [levelCode],
        }];
      },
    },

    hyperClick: {
      key: "hyperClick",
      kind: "direct",
      priority: 40,
      encode(value) {
        return {
          cmd: CMD.HYPER_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.boolU8(!!value)],
        };
      },
    },

    burstEnabled: {
      key: "burstEnabled",
      kind: "direct",
      priority: 41,
      encode(value) {
        return {
          cmd: CMD.BURST_W,
          lenOrIdx: 0x01,
          dataBytes: [value ? 0x01 : 0x00], // 修正：开启发送 0x01
        };
      },
    },

    sleepSeconds: {
      key: "sleepSeconds",
      kind: "direct",
      priority: 45,
      validate(patch, nextState) {
        TRANSFORMERS.sleepMinutesFromSeconds(nextState.sleepSeconds);
      },
      encode(value) {
        return {
          cmd: CMD.SLEEP_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.sleepMinutesFromSeconds(value)],
        };
      },
    },

    currentSlotCount: {
      key: "currentSlotCount",
      kind: "direct",
      priority: 50,
      validate(patch, nextState, profile) {
        const max = profile?.capabilities?.dpiSlotMax ?? 4;
        const count = clampInt(nextState.currentSlotCount, 1, max);
        if (count < 1 || count > max) {
          throw new ProtocolError("currentSlotCount out of range", "BAD_PARAM", { count, max });
        }
      },
      encode(value) {
        return {
          cmd: CMD.DPI_COUNT_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.slotCountU8(value)],
        };
      },
    },

    currentDpiIndex: {
      key: "currentDpiIndex",
      kind: "direct",
      priority: 51,
      encode(value, nextState) {
        return {
          cmd: CMD.DPI_INDEX_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.dpiIndexU8(value, nextState)],
        };
      },
    },

    dpiProfile: {
      key: "dpiProfile",
      kind: "virtual",
      priority: 52,
      triggers: ["dpiSlots", "dpiSlotsX", "dpiSlotsY"],
      validate(patch, nextState, profile) {
        const cap = profile?.capabilities || DEFAULT_PROFILE.capabilities;
        const count = clampInt(nextState.currentSlotCount, 1, cap.dpiSlotMax);
        const slotsX = Array.isArray(nextState.dpiSlotsX) ? nextState.dpiSlotsX : [];
        for (let i = 0; i < count; i++) {
          const v = Number(slotsX[i]);
          if (!Number.isFinite(v) || v < cap.dpiMin || v > cap.dpiMax) {
            throw new ProtocolError("dpiSlotsX contains out-of-range value", "BAD_PARAM", {
              index: i,
              value: slotsX[i],
              min: cap.dpiMin,
              max: cap.dpiMax,
            });
          }
        }
      },
      plan(patch, nextState, ctx) {
          const profile = ctx?.profile || DEFAULT_PROFILE;
          const cap = profile.capabilities || DEFAULT_PROFILE.capabilities;
          const count = clampInt(nextState.currentSlotCount, 1, cap.dpiSlotMax);
          const slotsX = Array.isArray(nextState.dpiSlotsX) ? nextState.dpiSlotsX : [];

          const out = [];
          for (let i = 0; i < count; i++) {
              const bytes = TRANSFORMERS.dpiValuePayload(slotsX[i], profile);
              out.push({
                  cmd: CMD.DPI_VALUE_W,
                  lenOrIdx: 0x04,
                  dataBytes: [i, ...bytes],
                  sensitive: true,
              });
          }
          return out;
      },
    },

    ledEnabled: {
      key: "ledEnabled",
      kind: "direct",
      priority: 60,
      encode(value) {
        return {
          cmd: CMD.LED_ENABLED_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.boolU8(!!value)],
        };
      },
    },

    ledBrightness: {
      key: "ledBrightness",
      kind: "direct",
      priority: 61,
      encode(value) {
        return {
          cmd: CMD.LED_BRIGHTNESS_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.ledBrightnessCode(value)],
        };
      },
    },

    ledMode: {
      key: "ledMode",
      kind: "direct",
      priority: 62,
      encode(value) {
        return {
          cmd: CMD.LED_MODE_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.ledModeCode(value)],
        };
      },
    },

    ledSpeed: {
      key: "ledSpeed",
      kind: "direct",
      priority: 63,
      encode(value) {
        return {
          cmd: CMD.LED_SPEED_W,
          lenOrIdx: 0x01,
          dataBytes: [TRANSFORMERS.ledSpeedU8(value)],
        };
      },
    },

    ledColor: {
      key: "ledColor",
      kind: "direct",
      priority: 64,
      encode(value) {
        return {
          cmd: CMD.LED_COLOR_W,
          lenOrIdx: 0x03,
          dataBytes: TRANSFORMERS.ledColorBytes(value),
        };
      },
    },

    ledProfile: {
      key: "ledProfile",
      kind: "virtual",
      priority: 80,
      triggers: ["ledBrightness", "ledMode", "ledSpeed", "ledColor"],
      plan(patch) {
        const touched = (
          ("ledBrightness" in patch) ||
          ("ledMode" in patch) ||
          ("ledSpeed" in patch) ||
          ("ledColor" in patch)
        );
        if (!touched) return [];
        // Native driver does not send a dedicated LED commit command.
        return [];
      },
    },

    buttonMapping: {
      key: "buttonMapping",
      kind: "virtual",
      priority: 90,
    },
  });

  // ============================================================
  // 7) Planner layer
  // ============================================================
  class CommandPlanner {
    constructor(profile) {
      this.profile = profile || DEFAULT_PROFILE;
    }

    _assertKnownPatchKeys(patch) {
      for (const k of Object.keys(patch)) {
        if (!KNOWN_PATCH_KEYS.has(k)) {
          throw new ProtocolError(`feature is not supported by Ninjutso driver: ${k}`, "FEATURE_UNSUPPORTED", { key: k });
        }
      }
    }

    _expandDependencies(patch, prevState) {
      const out = { ...patch };

      if ("performanceMode" in out) out.performanceMode = String(out.performanceMode || "").toLowerCase();
      if ("lodHeight" in out) out.lodHeight = String(out.lodHeight || "").toLowerCase();
      if ("ledMode" in out) out.ledMode = String(out.ledMode || "").toLowerCase();

      if ("debounceMs" in out && !("debounceLevel" in out)) {
        out.debounceLevel = TRANSFORMERS.debounceLevelCode(out.debounceMs);
      }
      if ("debounceLevel" in out && !("debounceMs" in out)) {
        out.debounceMs = TRANSFORMERS.debounceMsFromLevel(TRANSFORMERS.debounceLevelCode(out.debounceLevel));
      }

      const dpiTouched = (
        ("dpiSlots" in out) ||
        ("dpiSlotsX" in out) ||
        ("dpiSlotsY" in out)
      );
      if (dpiTouched) out.dpiProfile = true;

      const ledTouched = (
        ("ledBrightness" in out) ||
        ("ledMode" in out) ||
        ("ledSpeed" in out) ||
        ("ledColor" in out)
      );
      if (ledTouched) out.ledProfile = true;

      if ("pollingHz" in out) {
        const hz = Number(out.pollingHz);
        const allowed = this.profile?.capabilities?.pollingRates || [1000, 2000, 4000, 8000];
        if (!allowed.includes(hz)) {
          throw new ProtocolError(`unsupported pollingHz: ${hz}`, "FEATURE_UNSUPPORTED", { allowed });
        }
      }

      const nextCount = ("currentSlotCount" in out)
        ? clampInt(out.currentSlotCount, 1, this.profile.capabilities.dpiSlotMax)
        : clampInt(prevState?.currentSlotCount ?? 1, 1, this.profile.capabilities.dpiSlotMax);
      if ("currentDpiIndex" in out) {
        out.currentDpiIndex = clampInt(out.currentDpiIndex, 0, nextCount - 1);
      }

      return out;
    }

    _normalizeDpiSlots(next, prevState) {
      const cap = this.profile?.capabilities || DEFAULT_PROFILE.capabilities;
      const maxSlots = clampInt(cap.dpiSlotMax ?? 4, 1, 4);
      const min = clampInt(cap.dpiMin ?? 100, 1, 65535);
      const max = clampInt(cap.dpiMax ?? 26000, min, 65535);

      const prevX = Array.isArray(prevState?.dpiSlotsX)
        ? prevState.dpiSlotsX.slice(0, maxSlots)
        : (Array.isArray(prevState?.dpiSlots) ? prevState.dpiSlots.slice(0, maxSlots) : []);
      const prevY = Array.isArray(prevState?.dpiSlotsY)
        ? prevState.dpiSlotsY.slice(0, maxSlots)
        : prevX.slice(0);

      const rawX = Array.isArray(next.dpiSlotsX)
        ? next.dpiSlotsX.slice(0, maxSlots)
        : (Array.isArray(next.dpiSlots) ? next.dpiSlots.slice(0, maxSlots) : prevX.slice(0));
      const rawY = Array.isArray(next.dpiSlotsY)
        ? next.dpiSlotsY.slice(0, maxSlots)
        : (Array.isArray(next.dpiSlots) ? next.dpiSlots.slice(0, maxSlots) : prevY.slice(0));

      while (rawX.length < maxSlots) rawX.push(prevX[rawX.length] ?? 800);
      while (rawY.length < maxSlots) rawY.push(prevY[rawY.length] ?? rawX[rawY.length] ?? 800);

      next.dpiSlotsX = rawX.map((v, i) => {
        const x = clampNumber(v, min, max, NaN);
        return Number.isFinite(x) ? x : (prevX[i] ?? 800);
      });
      next.dpiSlotsY = rawY.map((v, i) => {
        const y = clampNumber(v, min, max, NaN);
        return Number.isFinite(y) ? y : (prevY[i] ?? next.dpiSlotsX[i] ?? 800);
      });
      next.dpiSlots = next.dpiSlotsX.slice(0);

      const count = clampInt(Number(next.currentSlotCount ?? 1), 1, maxSlots);
      next.currentSlotCount = count;
      next.currentDpiIndex = clampInt(Number(next.currentDpiIndex ?? 0), 0, count - 1);
      next.currentDpi = next.dpiSlotsX[next.currentDpiIndex] ?? next.dpiSlotsX[0] ?? 800;
    }

    _buildNextState(prevState, patch) {
      const next = { ...(prevState || {}), ...patch };
      this._normalizeDpiSlots(next, prevState || {});

      if ("protocolProfileId" in next) {
        next.protocolProfileId = TRANSFORMERS.profileIdU8(next.protocolProfileId);
      }

      if (typeof next.performanceMode === "string") next.performanceMode = next.performanceMode.toLowerCase();
      if (typeof next.lodHeight === "string") next.lodHeight = next.lodHeight.toLowerCase();
      if (typeof next.ledMode === "string") next.ledMode = next.ledMode.toLowerCase();

      if ("debounceLevel" in next) {
        const code = TRANSFORMERS.debounceLevelCode(next.debounceLevel);
        next.debounceLevel = code === 0 ? "low" : (code === 1 ? "mid" : "high");
        if (!("debounceMs" in patch)) next.debounceMs = TRANSFORMERS.debounceMsFromLevel(code);
      } else if ("debounceMs" in next) {
        const code = TRANSFORMERS.debounceLevelCode(next.debounceMs);
        next.debounceLevel = code === 0 ? "low" : (code === 1 ? "mid" : "high");
      }

      next.ledColor = normalizeColorHex(next.ledColor, prevState?.ledColor || "#11119a");
      next.ledSpeed = clampInt(Number(next.ledSpeed ?? 0), 0, 20);
      next.ledBrightness = clampInt(Number(next.ledBrightness ?? 100), 1, 100);

      return next;
    }

    _collectSpecKeys(expandedPatch) {
      const keys = new Set();

      for (const k of Object.keys(expandedPatch)) {
        if (SPEC[k]) keys.add(k);
      }

      for (const item of Object.values(SPEC)) {
        if (item?.kind !== "virtual") continue;
        const triggers = item?.triggers || [];
        if (item.key in expandedPatch || triggers.some((t) => t in expandedPatch)) {
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

    _extractWriteKey(cmd) {
      try {
        const rid = Number(cmd?.rid ?? HID_CONST.MAIN_RID);
        if (rid !== HID_CONST.MAIN_RID) return null;
        const hex = String(cmd?.hex || "");
        const u8 = hexToU8(hex);
        if (u8.length < 8) return null;
        const opcode = u8[0];
        const lenOrIdx = u8[5];
        const data0 = u8[7];

        if (opcode === CMD.KEYMAP_W) return `${rid}:${opcode}:${data0}`;
        if (opcode === CMD.DPI_VALUE_W) return `${rid}:${opcode}:${data0}`;
        return `${rid}:${opcode}:${lenOrIdx}`;
      } catch (_) {
        return null;
      }
    }

    _dedupeCommands(commands) {
      const parsed = commands.map((c, i) => ({ c, i, key: this._extractWriteKey(c) }));
      const lastByKey = new Map();
      for (const p of parsed) {
        if (p.key) lastByKey.set(p.key, p.i);
      }
      return parsed
        .filter((p) => !p.key || lastByKey.get(p.key) === p.i)
        .map((p) => p.c);
    }

    _injectSecurityGate(commands, prevState = {}) {
      const keymapNeedsGate = prevState?.wireless !== false;
      const hasSensitive = commands.some((c) => {
        if (c?.sensitive) return true;
        const opcode = toU8(c?.cmd ?? 0xff);
        if (opcode === CMD.DPI_VALUE_W) return true;
        if (opcode === CMD.KEYMAP_W) return keymapNeedsGate;
        return false;
      });
      if (!hasSensitive) return commands;

      const wait = this.profile?.timings?.secureGateWaitMs ?? 10;
      return [
        {
          rid: HID_CONST.SECURE_RID,
          hex: ProtocolCodec.secureUnlockPacket(),
          waitMs: wait,
          cmd: 0x1b,
          gate: true,
        },
        ...commands,
        {
          rid: HID_CONST.SECURE_RID,
          hex: ProtocolCodec.secureLockPacket(),
          waitMs: wait,
          cmd: 0x1c,
          gate: true,
        },
      ];
    }

    plan(prevState, externalPayload, { profileId = HID_CONST.DEFAULT_PROFILE_ID } = {}) {
      const patch0 = normalizePayload(externalPayload);
      this._assertKnownPatchKeys(patch0);

      const patch = this._expandDependencies(patch0, prevState || {});
      const nextState = this._buildNextState(prevState || {}, patch);
      const specKeys = this._collectSpecKeys(patch);
      const baseProfileId = toU8(profileId);
      const targetProfileId = ("protocolProfileId" in patch)
        ? TRANSFORMERS.profileIdU8(patch.protocolProfileId)
        : baseProfileId;

      for (const k of specKeys) {
        const item = SPEC[k];
        if (typeof item?.validate === "function") {
          item.validate(patch, nextState, this.profile);
        }
      }

      const ordered = this._topoSort(specKeys);
      const commands = [];
      const ctx = { profile: this.profile, prevState: prevState || {} };

      for (const item of ordered) {
        if (!item) continue;

        if (typeof item.plan === "function") {
          const seq = item.plan(patch, nextState, ctx);
          const arr = Array.isArray(seq) ? seq : [];
          for (const w of arr) {
            if (!w) continue;
            const hex = ProtocolCodec.write({
              cmd: w.cmd,
              lenOrIdx: w.lenOrIdx,
              profileId: (w.profileId == null ? targetProfileId : toU8(w.profileId)),
              dataBytes: w.dataBytes || [],
            });
            commands.push({
              rid: w.rid ?? HID_CONST.MAIN_RID,
              hex,
              waitMs: w.waitMs,
              cmd: w.cmd,
              sensitive: !!w.sensitive,
            });
          }
          continue;
        }

        if (typeof item.encode === "function") {
          const value = patch[item.key];
          const enc = item.encode(value, nextState, this.profile);
          const writes = Array.isArray(enc) ? enc : [enc];
          for (const w of writes) {
            if (!w) continue;
            const hex = ProtocolCodec.write({
              cmd: w.cmd,
              lenOrIdx: w.lenOrIdx,
              profileId: (w.profileId == null ? targetProfileId : toU8(w.profileId)),
              dataBytes: w.dataBytes || [],
            });
            commands.push({
              rid: w.rid ?? HID_CONST.MAIN_RID,
              hex,
              waitMs: w.waitMs,
              cmd: w.cmd,
              sensitive: !!w.sensitive,
            });
          }
        }
      }

      const gated = this._injectSecurityGate(commands, prevState || {});
      const optimized = this._dedupeCommands(gated);
      return { patch, nextState, commands: optimized };
    }
  }

  // ============================================================
  // 8) ProtocolApi exports: static helpers
  // ============================================================
  const ProtocolApi = (window.ProtocolApi = window.ProtocolApi || {});

  ProtocolApi.NINJUTSO_HID = Object.freeze({
    defaultFilters: [
      { vendorId: HID_CONST.VID, productId: HID_CONST.PID, usagePage: 0xff01 },
      { vendorId: HID_CONST.VID, productId: HID_CONST.PID, usagePage: 0xff00 },
      { vendorId: HID_CONST.VID, productId: HID_CONST.PID },
    ],
    usagePage: 0xff01,
    usagePageSecure: 0xff00,
    mainReportId: HID_CONST.MAIN_RID,
    secureReportId: HID_CONST.SECURE_RID,
  });
  ProtocolApi.MOUSE_HID = ProtocolApi.NINJUTSO_HID;

  ProtocolApi.resolveMouseDisplayName = function resolveMouseDisplayName(vendorId, productId, productName) {
    const pn = productName ? String(productName) : "";
    if (pn) return pn;
    if (Number(vendorId) === HID_CONST.VID && Number(productId) === HID_CONST.PID) return "Ninjutso Mouse";
    return "Ninjutso Device";
  };

  ProtocolApi.uint8ToVersion = function uint8ToVersion(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v ?? "");
    const major = (n >> 4) & 0x0f;
    const minor = n & 0x0f;
    return `${major}.${minor}`;
  };

  ProtocolApi.versionBytesToHex = function versionBytesToHex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!u8.length) return "-";
    return Array.from(u8)
      .map((b) => toU8(b).toString(16).padStart(2, "0"))
      .reverse()
      .join("");
  };

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

    add("左键", "mouse", 0x01, 0x0000);
    add("右键", "mouse", 0x01, 0x0001);
    add("中键", "mouse", 0x01, 0x0002);
    add("后退", "mouse", 0x01, 0x0003);
    add("前进", "mouse", 0x01, 0x0004);


    for (let i = 0; i < 26; i++) {
      add(String.fromCharCode(65 + i), "keyboard", 0x02, (0x00 << 8) | (0x04 + i));
    }
    const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
    for (let i = 0; i < digits.length; i++) {
      add(digits[i], "keyboard", 0x02, (0x00 << 8) | (0x1e + i));
    }
    add("回车", "keyboard", 0x02, (0x00 << 8) | 0x28);
    add("ESC", "keyboard", 0x02, (0x00 << 8) | 0x29);
    add("Tab", "keyboard", 0x02, (0x00 << 8) | 0x2b);
    add("空格", "keyboard", 0x02, (0x00 << 8) | 0x2c);

    add("剪切", "keyboard", 0x02, (0x01 << 8) | 0x1b);
    add("撤销", "keyboard", 0x02, (0x01 << 8) | 0x1d);
    add("重做", "keyboard", 0x02, (0x01 << 8) | 0x1c);
    add("全选", "keyboard", 0x02, (0x01 << 8) | 0x04);
    add("保存", "keyboard", 0x02, (0x01 << 8) | 0x16);
    add("打开", "keyboard", 0x02, (0x01 << 8) | 0x12);
    add("新建", "keyboard", 0x02, (0x01 << 8) | 0x11);
    add("切换窗口", "system", 0x02, (0x04 << 8) | 0x2b);

    add("Backspace", "keyboard", 0x02, (0x00 << 8) | 0x2a);
    add("Delete", "keyboard", 0x02, (0x00 << 8) | 0x4c);
    add("Insert", "keyboard", 0x02, (0x00 << 8) | 0x49);
    add("Home", "keyboard", 0x02, (0x00 << 8) | 0x4a);
    add("End", "keyboard", 0x02, (0x00 << 8) | 0x4d);
    add("Page Up", "keyboard", 0x02, (0x00 << 8) | 0x4b);
    add("Page Down", "keyboard", 0x02, (0x00 << 8) | 0x4e);
    add("Up Arrow", "keyboard", 0x02, (0x00 << 8) | 0x52);
    add("Down Arrow", "keyboard", 0x02, (0x00 << 8) | 0x51);
    add("Left Arrow", "keyboard", 0x02, (0x00 << 8) | 0x50);
    add("Right Arrow", "keyboard", 0x02, (0x00 << 8) | 0x4f);


    for (let i = 1; i <= 12; i++) {
      add(`F${i}`, "keyboard", 0x02, (0x00 << 8) | (0x39 + i));
    }


    add("显示桌面", "system", 0x02, (0x08 << 8) | 0x07);
    add("锁定电脑", "system", 0x02, (0x08 << 8) | 0x0f);
    add("打开资源管理器", "system", 0x02, (0x08 << 8) | 0x08);
    add("运行", "system", 0x02, (0x08 << 8) | 0x15);
    add("搜索", "system", 0x02, (0x08 << 8) | 0x16);
    add("任务管理器", "system", 0x02, (0x03 << 8) | 0x29);
    add("截图", "system", 0x02, (0x0a << 8) | 0x16);

    return Object.freeze(actions);
  })();

  ProtocolApi.KEYMAP_ACTIONS = KEYMAP_ACTIONS;

  const LABEL_TO_PROTOCOL_ACTION = Object.freeze(
    Object.fromEntries(
      Object.entries(KEYMAP_ACTIONS).map(([label, a]) => [label, { funckey: a.funckey, keycode: a.keycode }])
    )
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

  const BUTTON_TO_SRC = Object.freeze({
    2: 1, // 右键
    3: 2, // 中键
    4: 4, // 
    5: 3, // 
  });
  const SRC_TO_BUTTON = Object.freeze({
    1: 2,
    2: 3,
    3: 5,
    4: 4,
  });

  // ============================================================
  // 9) Public API class
  // ============================================================
  class MouseMouseHidApi {
    constructor({ profile = DEFAULT_PROFILE } = {}) {
      this._profile = profile || DEFAULT_PROFILE;
      this._planner = new CommandPlanner(this._profile);
      this._driver = new UniversalHidDriver();
      this._driver.defaultInterCmdDelayMs = this._profile.timings.interCmdDelayMs ?? 12;

      this._device = null;
      this._protocolProfileId = HID_CONST.DEFAULT_PROFILE_ID;
      this._opQueue = new SendQueue();
      this._onConfigCbs = [];
      this._onBatteryCbs = [];
      this._onRawReportCbs = [];
      this._boundInputHandler = null;
      this._cfg = this._makeDefaultCfg();
    }

    set device(dev) {
      this._device = dev || null;
      this._driver.setDevice(this._device);
      if (!this._device) this._protocolProfileId = HID_CONST.DEFAULT_PROFILE_ID;
    }

    get device() {
      return this._device;
    }

    get capabilities() {
      const cap = this._profile?.capabilities || {};
      return deepClone({
        ...cap,
        dpiSlotCount: cap.dpiSlotMax ?? 4,
        maxDpi: cap.dpiMax ?? 26000,
        dpiStep: cap.dpiStep ?? 1,
        pollingRates: Array.isArray(cap.pollingRates) ? cap.pollingRates.slice(0) : [1000, 2000, 4000, 8000],
      });
    }

    getCachedConfig() {
      return deepClone(this._cfg);
    }

    _ensureInputBound() {
      if (!this.device || this._boundInputHandler) return;
      this._boundInputHandler = (evt) => {
        try {
          const reportId = Number(evt?.reportId);
          const dv = evt?.data;
          const u8 = dv ? new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength) : new Uint8Array(0);
          this._handleInputReport(reportId, u8);
          for (const cb of this._onRawReportCbs.slice()) {
            try { cb({ reportId, data: u8, event: evt }); } catch (_) {}
          }
        } catch (_) {}
      };
      try { this.device.addEventListener("inputreport", this._boundInputHandler); } catch (_) {}
    }

    async _initializeSecurityGate() {
      try {
        await this._driver.unlockGate();
        await sleep(this._profile.timings.secureGateWaitMs ?? 10);
        await this._driver.lockGate();
      } catch (e) {
        console.warn("[Ninjutso] security gate handshake warning:", e);
      }
    }

    async open() {
      if (!this.device) throw new ProtocolError("open() requires hidApi.device", "NO_DEVICE");
      this._ensureInputBound();
      if (this.device.opened) {
        await this._initializeSecurityGate();
        return;
      }

      try {
        await this.device.open();
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.toLowerCase().includes("already open")) {
          try { await this.device.close(); } catch (_) {}
          await sleep(80);
          await this.device.open();
        } else {
          throw new ProtocolError(`failed to open device: ${msg}`, "OPEN_FAIL");
        }
      }

      this._ensureInputBound();
      await sleep(80);
      await this._initializeSecurityGate();
    }

    async close() {
      const dev = this.device;
      if (!dev) return;

      try {
        if (this._boundInputHandler) {
          dev.removeEventListener("inputreport", this._boundInputHandler);
        }
      } catch (_) {}
      this._boundInputHandler = null;

      try { if (dev.opened) await dev.close(); } catch (_) {}
      this.device = null;
    }

    async dispose() {
      await this.close();
      this._onConfigCbs.length = 0;
      this._onBatteryCbs.length = 0;
      this._onRawReportCbs.length = 0;
      this._cfg = null;
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
        const i = this._onConfigCbs.indexOf(cb);
        if (i >= 0) this._onConfigCbs.splice(i, 1);
      };
    }

    onBattery(cb) {
      if (typeof cb !== "function") return () => {};
      this._onBatteryCbs.push(cb);
      return () => {
        const i = this._onBatteryCbs.indexOf(cb);
        if (i >= 0) this._onBatteryCbs.splice(i, 1);
      };
    }

    onRawReport(cb) {
      if (typeof cb !== "function") return () => {};
      this._onRawReportCbs.push(cb);
      return () => {
        const i = this._onRawReportCbs.indexOf(cb);
        if (i >= 0) this._onRawReportCbs.splice(i, 1);
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

    waitForNextBattery(timeoutMs = 1200) {
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

    _isRetriableReadError(err) {
      const code = String(err?.code || "");
      if (!code) return false;
      return code === "IO_TIMEOUT"
        || code === "IO_READ_FAIL"
        || code === "IO_CMD_MISMATCH";
    }

    async _decodeReadWithDrain(featureU8, { expectedCmd, expectedLen }) {
      try {
        return decodeReadData(featureU8, { expectedCmd, expectedLen });
      } catch (e) {
        // Strict frame parser stays unchanged; drain only handles stale/shifted frames.
        if (e?.code !== "IO_CMD_MISMATCH") throw e;
      }

      const maxDrain = clampInt(this._profile?.timings?.configReadDrainReads ?? 2, 0, 8);
      const timeoutMs = clampInt(this._profile?.timings?.configReadDrainTimeoutMs ?? 140, 20, 2000);
      let lastErr = null;

      for (let i = 0; i < maxDrain; i++) {
        let driftU8;
        try {
          driftU8 = await this._driver.receiveFeatureReport(HID_CONST.MAIN_RID, { timeoutMs });
        } catch (e) {
          lastErr = e;
          break;
        }

        try {
          return decodeReadData(driftU8, { expectedCmd, expectedLen });
        } catch (e) {
          lastErr = e;
          if (e?.code !== "IO_CMD_MISMATCH") break;
        }
      }

      throw (lastErr || new ProtocolError("failed to recover from stale response frame", "IO_READ_FAIL", {
        expectedCmd: expectedCmd == null ? null : toU8(expectedCmd),
      }));
    }

    async _readCmdBytesWithRetry({ cmd, lenOrIdx, dataBytes, expectedLen }) {
      const waitMs = this._profile.timings.configReadDelayMs ?? this._profile.timings.interCmdDelayMs ?? 12;
      const retries = clampInt(this._profile?.timings?.configReadRetries ?? 4, 1, 8);
      const readCmd = toU8(cmd);
      let lastErr = null;

      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const hex = ProtocolCodec.read({
            cmd: readCmd,
            lenOrIdx,
            profileId: this._protocolProfileId,
            dataBytes,
          });
          const featureU8 = await this._driver.sendAndReceiveFeature({
            rid: HID_CONST.MAIN_RID,
            hex,
            featureRid: HID_CONST.MAIN_RID,
            waitMs,
          });
          return await this._decodeReadWithDrain(featureU8, {
            expectedCmd: readCmd,
            expectedLen,
          });
        } catch (e) {
          lastErr = e;
          const isLastAttempt = attempt >= retries - 1;
          if (isLastAttempt) break;
          if (!this._isRetriableReadError(e)) break;
        }
      }

      throw (lastErr || new ProtocolError(`read command failed: 0x${readCmd.toString(16).padStart(2, "0")}`, "IO_READ_FAIL", {
        cmd: readCmd,
      }));
    }

    async _readCmdBytes(cmd, { lenOrIdx = 0x00, dataBytes = [], expectedLen = null } = {}) {
      return this._readCmdBytesWithRetry({
        cmd,
        lenOrIdx,
        dataBytes,
        expectedLen,
      });
    }

    async _readCmdU8(cmd, { lenOrIdx = 0x00, dataBytes = [] } = {}) {
      const bytes = await this._readCmdBytes(cmd, { lenOrIdx, dataBytes, expectedLen: 1 });
      return bytes[0] ?? 0x00;
    }

    async _readBatteryPercent() {
      const b = await this._readCmdU8(CMD.BATTERY_R, { lenOrIdx: 0x00 });
      return clampInt(b, 0, 100);
    }

    async _readDpiValueByIndex(index) {
      const idx = clampInt(index, 0, 3);
      const bytes = await this._readCmdBytes(CMD.DPI_VALUE_R, {
        lenOrIdx: 0x01,
        dataBytes: [idx],
        expectedLen: null,
      });
      if (bytes.length < 2) return 800;
      const base = (toU8(bytes[1]) << 8) | toU8(bytes[0]);
      const decimalTenth = toU8(bytes[2] ?? 0);

      if (decimalTenth > 0 && decimalTenth <= 9) {
        return base + decimalTenth / 10;
      }

      // Older protocol variants encode DPI as (value + 1) * 50.
      const useLegacyScale50 = this._profile?.compat?.dpiDecodeLegacyScale50 === true;
      if (useLegacyScale50 && base > 0 && base < 100) {
        return (base + 1) * 50;
      }

      return base;
    }

    async _readButtonMappingByIndex(buttonIndex) {
      const idx = clampInt(buttonIndex, 0, 6);

      const bytes = await this._readCmdBytes(CMD.KEYMAP_R, {
        lenOrIdx: 0x01,
        dataBytes: [idx],
        expectedLen: 4,
      });

      const funcType = toU8(bytes[0]);
      const funcParam = toU8(bytes[1]);

      if (funcType === 0x01) {
        return {
          buttonIndex: idx,
          funckey: 0x01,
          keycode: funcParam,
        };
      }

      if (funcType === 0x02) {
        const d1 = toU8(bytes[1]);
        const d2 = toU8(bytes[2]);
        if (d1 === 0x00 && d2 === 0x00) {
          return { buttonIndex: idx, funckey: 0x00, keycode: 0x0000 };
        }
        return { buttonIndex: idx, funckey: 0x02, keycode: (d1 << 8) | d2 };
      }

      if (funcType === 0x00 && funcParam === 0x00) {
        return { buttonIndex: idx, funckey: 0x00, keycode: 0x0000 };
      }

      return { buttonIndex: idx, funckey: funcType, keycode: funcParam };
    }

    async _readButtonMappingBySrc(srcKey) {
      const src = clampInt(srcKey, 1, 6);

      const decodeStrict = (rawBytes) => {
        const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || []);
        if (u8.length < 4) {
          throw new ProtocolError("keymap payload too short", "IO_READ_FAIL", {
            src,
            len: u8.length,
            raw: bytesToHex(u8),
          });
        }

        const funcType = toU8(u8[0]);
        const funcParam = toU8(u8[1]);

        if (funcType === 0x01) {
          return {
            srcKey: src,
            funckey: 0x01,
            keycode: funcParam,
          };
        }

        if (funcType === 0x02) {
          const d1 = toU8(u8[1]);
          const d2 = toU8(u8[2]);
          if (d1 === 0x00 && d2 === 0x00) {
            return { srcKey: src, funckey: 0x00, keycode: 0x0000 };
          }
          return { srcKey: src, funckey: 0x02, keycode: (d1 << 8) | d2 };
        }

        return { srcKey: src, funckey: 0x00, keycode: 0x0000 };
      };

      const bytes = await this._readCmdBytes(CMD.KEYMAP_R, {
        lenOrIdx: 0x01,
        dataBytes: [src],
        expectedLen: 4,
      });
      return decodeStrict(bytes);
    }

    async _readDeviceConfigSnapshot() {
      const cap = this._profile.capabilities || DEFAULT_PROFILE.capabilities;
      const maxSlots = clampInt(cap.dpiSlotMax ?? 4, 1, 4);
      const snapshot = {};

      const prf = await this._readCmdBytes(CMD.PROFILE_R, {
        lenOrIdx: 0x00,
        dataBytes: [],
        expectedLen: 1,
      });
      this._protocolProfileId = toU8(prf[0] ?? HID_CONST.DEFAULT_PROFILE_ID);
      snapshot.protocolProfileId = this._protocolProfileId;

      snapshot.batteryPercent = await this._readBatteryPercent();

      const pollingBytes = await this._readCmdBytes(CMD.POLLING_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.pollingHz = DECODERS.pollingHzFromCode(pollingBytes[0] ?? 0);

      const lodBytes = await this._readCmdBytes(CMD.LOD_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.lodHeight = DECODERS.lodHeightFromCode(lodBytes[0] ?? 0);

      const perfBytes = await this._readCmdBytes(CMD.PERF_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.performanceMode = DECODERS.performanceModeFromCode(perfBytes[0] ?? 0);

      const d = DECODERS.debounceFromReadByte(await this._readCmdU8(CMD.DEBOUNCE_R, { lenOrIdx: 0x01 }));
      snapshot.debounceLevel = d.debounceLevel;
      snapshot.debounceMs = d.debounceMs;

      const hyperBytes = await this._readCmdBytes(CMD.HYPER_R, {
        lenOrIdx: 0x00,
        dataBytes: [],
        expectedLen: 1,
      });
      snapshot.hyperClick = DECODERS.bool(hyperBytes[0] ?? 0);

      const burstBytes = await this._readCmdBytes(CMD.BURST_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.burstEnabled = (toU8(burstBytes[0] ?? 0) === 0x01);

      const sleepBytes = await this._readCmdBytes(CMD.SLEEP_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.sleepSeconds = DECODERS.sleepSecondsFromMinutes(sleepBytes[0] ?? 1);

      const countBytes = await this._readCmdBytes(CMD.DPI_COUNT_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      const currentSlotCount = clampInt(countBytes[0] ?? maxSlots, 1, maxSlots);
      const idxBytes = await this._readCmdBytes(CMD.DPI_INDEX_R, {
        lenOrIdx: 0x00,
        dataBytes: [],
        expectedLen: 1,
      });
      const currentDpiIndex = clampInt(idxBytes[0] ?? 0, 0, currentSlotCount - 1);

      const dpiSlotsX = [];
      const dpiSlotsY = [];
      for (let i = 0; i < maxSlots; i++) {
        if (i < currentSlotCount) {
          const dpi = await this._readDpiValueByIndex(i);
          dpiSlotsX.push(dpi);
          dpiSlotsY.push(dpi);
        } else {
          dpiSlotsX.push(800);
          dpiSlotsY.push(800);
        }
      }
      snapshot.currentSlotCount = currentSlotCount;
      snapshot.currentDpiIndex = currentDpiIndex;
      snapshot.dpiSlotsX = dpiSlotsX;
      snapshot.dpiSlotsY = dpiSlotsY;
      snapshot.dpiSlots = dpiSlotsX.slice(0);
      snapshot.currentDpi = dpiSlotsX[currentDpiIndex] ?? dpiSlotsX[0] ?? 800;

      const defaultButtonMappings = this._makeDefaultCfg().buttonMappings || [];
      const buttonMappings = Array.from({ length: 7 }, (_, idx) => {
        const base = defaultButtonMappings[idx] || { funckey: 0x00, keycode: 0x0000 };
        return {
          funckey: toU8(base.funckey),
          keycode: clampInt(base.keycode, 0, 0xffff),
        };
      });
      for (const [srcText, btnId] of Object.entries(SRC_TO_BUTTON)) {
        const src = Number(srcText);
        const btnIdx = Number(btnId) - 1;
        if (!Number.isFinite(src) || !Number.isFinite(btnIdx) || btnIdx < 0 || btnIdx >= buttonMappings.length) continue;
        const mapped = await this._readButtonMappingBySrc(src);
        buttonMappings[btnIdx] = {
          funckey: toU8(mapped.funckey),
          keycode: clampInt(mapped.keycode, 0, 0xffff),
        };
      }
      snapshot.buttonMappings = buttonMappings;

      const ledEnBytes = await this._readCmdBytes(CMD.LED_ENABLED_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.ledEnabled = DECODERS.bool(ledEnBytes[0] ?? 0);
      const ledBrBytes = await this._readCmdBytes(CMD.LED_BRIGHTNESS_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.ledBrightness = DECODERS.ledBrightnessFromCode(ledBrBytes[0] ?? 0);
      const ledMdBytes = await this._readCmdBytes(CMD.LED_MODE_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.ledMode = DECODERS.ledModeFromCode(ledMdBytes[0] ?? 0);
      const ledSpBytes = await this._readCmdBytes(CMD.LED_SPEED_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 1 });
      snapshot.ledSpeed = DECODERS.ledSpeedFromCode(ledSpBytes[0] ?? 20);
      const rgb = await this._readCmdBytes(CMD.LED_COLOR_R, { lenOrIdx: 0x00, dataBytes: [], expectedLen: 3 });
      snapshot.ledColor = normalizeColorHex([rgb[0], rgb[1], rgb[2]], "#11119a");

      const vm = await this._readCmdBytes(CMD.VERSION_R, {
        lenOrIdx: 0x01,
        dataBytes: [0x00],
        expectedLen: 3,
      });
      snapshot.mouseFwBytes = Array.from(vm || []);
      snapshot.mouseFwRaw = Number.isFinite(Number(vm?.[0])) ? toU8(vm[0]) : null;
      snapshot.mouseFwHex = ProtocolApi.versionBytesToHex(vm);

      const vr = await this._readCmdBytes(CMD.VERSION_R, {
        lenOrIdx: 0x01,
        dataBytes: [0x01],
        expectedLen: 3,
      });
      snapshot.receiverFwBytes = Array.from(vr || []);
      snapshot.receiverFwRaw = Number.isFinite(Number(vr?.[0])) ? toU8(vr[0]) : null;
      snapshot.receiverFwHex = ProtocolApi.versionBytesToHex(vr);

      const color = await this._readCmdBytes(CMD.COLOR_R, { lenOrIdx: 0x00, expectedLen: null });
      snapshot.infoA = Array.from(color || []);

      const pid = await this._readCmdBytes(CMD.PAIR_PID_R, { lenOrIdx: 0x00, expectedLen: null });
      snapshot.infoB = Array.from(pid || []);

      snapshot.deviceName = String(this.device?.productName || "Ninjutso Mouse");
      snapshot.capabilities = {
        dpiSlotCount: cap.dpiSlotMax,
        maxDpi: cap.dpiMax,
        dpiStep: cap.dpiStep,
        pollingRates: (cap.pollingRates || []).slice(0),
      };

      return snapshot;
    }

    _handleInputReport(reportId, u8) {
      const rid = Number(reportId);
      if (rid !== HID_CONST.MAIN_RID && rid !== 0) return;
      if (!(u8 instanceof Uint8Array) || u8.length < 2) return;

      try {
        const cmd0 = toU8(u8[0]);
        const cmd1 = toU8(u8[1]);
        if (cmd0 === CMD.BATTERY_R || cmd1 === CMD.BATTERY_R) {
          const payload = (u8[0] === HID_CONST.MAIN_RID)
            ? u8
            : (() => {
              const merged = new Uint8Array(u8.length + 1);
              merged[0] = HID_CONST.MAIN_RID;
              merged.set(u8, 1);
              return merged;
            })();
          const frame = parseMainResponseFrame(payload, CMD.BATTERY_R);
          const p = clampInt(frame.data?.[0] ?? this._cfg?.batteryPercent ?? -1, 0, 100);
          if (Number(this._cfg?.batteryPercent) !== p) {
            this._cfg.batteryPercent = p;
            this._emitBattery({ batteryPercent: p });
          }
        }
      } catch (_) {}
    }

    async requestConfig() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestConfig() requires hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const snapshot = await this._readDeviceConfigSnapshot();
        this._cfg = Object.assign({}, this._cfg || this._makeDefaultCfg(), snapshot);
        this._protocolProfileId = toU8(this._cfg.protocolProfileId ?? this._protocolProfileId);

        if (typeof this._cfg.mouseFwHex === "string" && this._cfg.mouseFwHex) {
          this._cfg.mouseFw = this._cfg.mouseFwHex;
        } else if (this._cfg.mouseFwRaw != null) {
          this._cfg.mouseFw = ProtocolApi.uint8ToVersion(this._cfg.mouseFwRaw);
        }
        if (typeof this._cfg.receiverFwHex === "string" && this._cfg.receiverFwHex) {
          this._cfg.receiverFw = this._cfg.receiverFwHex;
        } else if (this._cfg.receiverFwRaw != null) {
          this._cfg.receiverFw = ProtocolApi.uint8ToVersion(this._cfg.receiverFwRaw);
        }

        this._emitConfig();
      });
    }

    async requestConfiguration() { return this.requestConfig(); }
    async getConfig() { return this.requestConfig(); }
    async readConfig() { return this.requestConfig(); }
    async requestDeviceConfig() { return this.requestConfig(); }
    async read() { return this.requestConfig(); }

    async requestBattery() {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("requestBattery() requires hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const percent = await this._readBatteryPercent();
        this._cfg = this._cfg || this._makeDefaultCfg();
        this._cfg.batteryPercent = percent;
        this._emitBattery({ batteryPercent: percent, batteryIsCharging: false });
      });
    }

    async setFeature(key, value) {
      const k = String(key || "");
      if (!k) throw new ProtocolError("setFeature() requires key", "BAD_PARAM");
      return this.setBatchFeatures({ [k]: value });
    }

    async setBatchFeatures(obj) {
      const externalPayload = isObject(obj) ? obj : {};
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("setBatchFeatures() requires hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const base = this._cfg || this._makeDefaultCfg();
        const { patch, nextState, commands } = this._planner.plan(base, externalPayload, {
          profileId: this._protocolProfileId,
        });

        await this._driver.runSequence(commands);

        this._cfg = Object.assign({}, base, nextState);
        this._protocolProfileId = toU8(this._cfg.protocolProfileId ?? this._protocolProfileId);
        this._emitConfig();
        return { patch, commands };
      });
    }

    async apply(patch) {
      return this.setBatchFeatures(patch);
    }

    async setProtocolProfileId(profileId) {
      return this.setBatchFeatures({ protocolProfileId: profileId });
    }

    async setProfile(profileId) {
      return this.setProtocolProfileId(profileId);
    }

    getProtocolProfileId() {
      return toU8(this._protocolProfileId);
    }

    async setDpi(slot, value, opts = {}) {
      const cap = this._profile?.capabilities || DEFAULT_PROFILE.capabilities;
      const maxSlots = clampInt(Number(cap.dpiSlotMax ?? 4), 1, 4);
      const s = clampInt(assertFiniteNumber(slot, "slot"), 1, maxSlots);
      const valueObj = isObject(value) ? value : null;
      const dpiX = clampNumber(
        assertFiniteNumber(valueObj ? (valueObj.x ?? valueObj.X ?? valueObj.y ?? valueObj.Y) : value, "dpiX"),
        cap.dpiMin,
        cap.dpiMax
      );
      const dpiY = clampNumber(
        assertFiniteNumber(valueObj ? (valueObj.y ?? valueObj.Y ?? dpiX) : dpiX, "dpiY"),
        cap.dpiMin,
        cap.dpiMax
      );

      const baseX = Array.isArray(this._cfg?.dpiSlotsX)
        ? this._cfg.dpiSlotsX.slice(0)
        : (Array.isArray(this._cfg?.dpiSlots) ? this._cfg.dpiSlots.slice(0) : []);
      const baseY = Array.isArray(this._cfg?.dpiSlotsY)
        ? this._cfg.dpiSlotsY.slice(0)
        : baseX.slice(0);

      while (baseX.length < maxSlots) baseX.push(800);
      while (baseY.length < maxSlots) baseY.push(baseX[baseY.length] ?? 800);

      baseX[s - 1] = dpiX;
      baseY[s - 1] = dpiY;

      const patch = {
        dpiSlotsX: baseX.slice(0, maxSlots),
        dpiSlotsY: baseY.slice(0, maxSlots),
        dpiSlots: baseX.slice(0, maxSlots),
      };
      if (opts && opts.select) patch.currentDpiIndex = s - 1;
      return this.setBatchFeatures(patch);
    }

    async setSlotCount(n) {
      const maxSlots = clampInt(this._profile?.capabilities?.dpiSlotMax ?? 4, 1, 4);
      const count = clampInt(assertFiniteNumber(n, "slotCount"), 1, maxSlots);
      return this.setBatchFeatures({ currentSlotCount: count });
    }

    async setDpiSlotCount(n) {
      return this.setSlotCount(n);
    }

    async setCurrentDpiIndex(index) {
      const currentCount = clampInt(
        this._cfg?.currentSlotCount ?? this._profile?.capabilities?.dpiSlotMax ?? 1,
        1,
        this._profile?.capabilities?.dpiSlotMax ?? 4
      );
      const idx = clampInt(assertFiniteNumber(index, "index"), 0, currentCount - 1);
      return this.setBatchFeatures({ currentDpiIndex: idx });
    }

    async setButtonMappingBySelect(btnId, labelOrObj) {
      return this._opQueue.enqueue(async () => {
        if (!this.device) throw new ProtocolError("setButtonMappingBySelect() requires hidApi.device", "NO_DEVICE");
        if (!this.device.opened) await this.open();

        const b = clampInt(assertFiniteNumber(btnId, "btnId"), 1, 6);
        if (b === 6) {
          throw new ProtocolError("Btn6 mapping is not supported on Ninjutso", "FEATURE_UNSUPPORTED", { btnId: b });
        }
        const src = BUTTON_TO_SRC[b];
        if (!src) {
          throw new ProtocolError(`Btn${b} mapping is not supported`, "FEATURE_UNSUPPORTED", { btnId: b });
        }

        let action;
        if (typeof labelOrObj === "string") {
          action = LABEL_TO_PROTOCOL_ACTION[labelOrObj];
          if (!action) {
            throw new ProtocolError(`unknown key action label: ${labelOrObj}`, "BAD_PARAM", { label: labelOrObj });
          }
        } else if (isObject(labelOrObj)) {
          action = {
            funckey: Number(labelOrObj.funckey ?? labelOrObj.func ?? 0),
            keycode: Number(labelOrObj.keycode ?? labelOrObj.code ?? 0),
          };
        } else {
          throw new ProtocolError("key action must be label string or {funckey,keycode}", "BAD_PARAM");
        }

        const dataBytes = TRANSFORMERS.keymapPayloadBytes(src, action);
        const writeHex = ProtocolCodec.write({
          cmd: CMD.KEYMAP_W,
          lenOrIdx: 0x05,
          profileId: this._protocolProfileId,
          dataBytes,
        });

        const gateWait = this._profile.timings.secureGateWaitMs ?? 10;
        const gateEnabled = this._cfg?.wireless !== false;
        const seq = gateEnabled
          ? [
            {
              rid: HID_CONST.SECURE_RID,
              hex: ProtocolCodec.secureUnlockPacket(),
              waitMs: gateWait,
              cmd: 0x1b,
              gate: true,
            },
            {
              rid: HID_CONST.MAIN_RID,
              hex: writeHex,
              waitMs: this._profile.timings.interCmdDelayMs ?? 12,
              cmd: CMD.KEYMAP_W,
              sensitive: true,
            },
            {
              rid: HID_CONST.SECURE_RID,
              hex: ProtocolCodec.secureLockPacket(),
              waitMs: gateWait,
              cmd: 0x1c,
              gate: true,
            },
          ]
          : [
            {
              rid: HID_CONST.MAIN_RID,
              hex: writeHex,
              waitMs: this._profile.timings.interCmdDelayMs ?? 12,
              cmd: CMD.KEYMAP_W,
              sensitive: true,
            },
          ];

        await this._driver.runSequence(seq);

        if (!this._cfg || !isObject(this._cfg)) this._cfg = this._makeDefaultCfg();
        if (!Array.isArray(this._cfg.buttonMappings)) {
          this._cfg.buttonMappings = Array.from({ length: 7 }, () => ({ funckey: 0x00, keycode: 0x0000 }));
        }
        while (this._cfg.buttonMappings.length < 7) {
          this._cfg.buttonMappings.push({ funckey: 0x00, keycode: 0x0000 });
        }
        this._cfg.buttonMappings[b - 1] = {
          funckey: toU8(action.funckey),
          keycode: clampInt(action.keycode, 0, 0xffff),
        };
        this._emitConfig();
      });
    }

    _makeDefaultCfg() {
      const cap = this._profile?.capabilities || DEFAULT_PROFILE.capabilities;
      const slotMax = clampInt(cap.dpiSlotMax ?? 4, 1, 4);
      const defaults = [800, 1200, 1600, 2400].slice(0, slotMax);
      while (defaults.length < slotMax) defaults.push(defaults[defaults.length - 1] ?? 800);

      return {
        capabilities: {
          dpiSlotCount: slotMax,
          maxDpi: cap.dpiMax ?? 26000,
          dpiStep: cap.dpiStep ?? 1,
          pollingRates: Array.isArray(cap.pollingRates) ? cap.pollingRates.slice(0) : [1000, 2000, 4000, 8000],
        },
        protocolProfileId: this._protocolProfileId,
        dpiSlotsX: defaults.slice(0),
        dpiSlotsY: defaults.slice(0),
        dpiSlots: defaults.slice(0),
        currentSlotCount: slotMax,
        currentDpiIndex: 0,
        currentDpi: defaults[0] ?? 800,

        pollingHz: (cap.pollingRates && cap.pollingRates[0]) || 1000,
        performanceMode: "hp",
        lodHeight: "low",
        debounceLevel: "mid",
        debounceMs: 5,
        hyperClick: false,
        burstEnabled: false,
        sleepSeconds: 300,

        ledEnabled: false,
        ledBrightness: 100,
        ledMode: "static",
        ledSpeed: 0,
        ledColor: "#11119a",

        buttonMappings: [
          { funckey: 0x01, keycode: 0x0000 },  // btn0: left click
          { funckey: 0x01, keycode: 0x0001 },  // btn1: right click
          { funckey: 0x01, keycode: 0x0002 },  // btn2: middle click
          { funckey: 0x01, keycode: 0x0004 },  // btn3: forward (UI btn4)
          { funckey: 0x01, keycode: 0x0003 },  // btn4: back (UI btn5)
          { funckey: 0x01, keycode: 0x0005 },  // btn5
          { funckey: 0x01, keycode: 0x0006 },  // btn6
        ],

        batteryPercent: -1,
        batteryIsCharging: false,
        wireless: true,

        infoA: [],
        infoB: [],
        mouseFwBytes: [],
        receiverFwBytes: [],
        mouseFwRaw: null,
        receiverFwRaw: null,
        mouseFwHex: "-",
        receiverFwHex: "-",
        mouseFw: "-",
        receiverFw: "-",
        deviceName: "Ninjutso Mouse",
      };
    }

    _emitConfig() {
      const cfg = this._cfg;
      for (const cb of this._onConfigCbs.slice()) {
        try { cb(cfg); } catch (_) {}
      }
    }

    _emitBattery(battery) {
      const b = battery || {
        batteryPercent: Number(this._cfg?.batteryPercent ?? -1),
        batteryIsCharging: !!this._cfg?.batteryIsCharging,
      };
      for (const cb of this._onBatteryCbs.slice()) {
        try { cb(b); } catch (_) {}
      }
    }
  }

  ProtocolApi.MouseMouseHidApi = MouseMouseHidApi;
})();
