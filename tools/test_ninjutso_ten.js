const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..");
const protocolPath = path.join(rootDir, "src", "protocols", "protocol_api_ninjutso.js");
const runtimePath = path.join(rootDir, "src", "core", "device_runtime.js");
const refactorCorePath = path.join(rootDir, "src", "refactor", "refactor.core.js");

function loadProtocolApi() {
  const context = {
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
  };
  context.window = { ProtocolApi: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(protocolPath, "utf8"), context, { filename: protocolPath });
  return context.window.ProtocolApi;
}

function makeDevice(productId, productName) {
  return {
    vendorId: 0x093a,
    productId,
    productName,
    opened: true,
    addEventListener() {},
    removeEventListener() {},
  };
}

function hexBytes(hex) {
  return String(hex).match(/.{2}/g).map((byte) => Number.parseInt(byte, 16));
}

function loadRuntime() {
  const storage = new Map([["device.selected", "ninjutso_ten"]]);
  const context = {
    console,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    navigator: {
      hid: {
        getDevices: async () => [],
        requestDevice: async () => [],
      },
    },
    setTimeout,
    clearTimeout,
    URL,
  };
  context.window = {
    ProtocolApi: {
      MouseMouseHidApi: function MouseMouseHidApi() {},
    },
    __DEVICE_PROTOCOL_DEVICE__: "ninjutso_ten",
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(runtimePath, "utf8"), context, { filename: runtimePath });
  return context.window.DeviceRuntime;
}

function loadRefactorCore() {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(refactorCorePath, "utf8"), context, { filename: refactorCorePath });
  return context.window.AppConfig;
}

async function testRuntimePidIdentification() {
  const runtime = loadRuntime();

  assert.equal(
    runtime.identifyDeviceType(makeDevice(0xe010, "Ninjutso Sora V3")),
    "ninjutso",
  );
  assert.equal(
    runtime.identifyDeviceType(makeDevice(0xeb02, "Ninjutso Sora V3")),
    "ninjutso",
  );
  assert.equal(runtime.identifyDeviceType(makeDevice(0xe020, "Ninjutso Ten")), "ninjutso_ten");
  assert.equal(runtime.identifyDeviceType(makeDevice(0xea01, "Ninjutso Ten Receiver")), "ninjutso_ten");
}

function testSlamClickUiConfiguration() {
  const config = loadRefactorCore();

  for (const deviceId of ["ninjutso", "ninjutso_ten"]) {
    const deviceConfig = config.ranges[deviceId];
    assert.deepEqual(Array.from(deviceConfig.power.debounceMs), [0, 1, 2]);
    assert.equal(deviceConfig.texts.debounce.title, "防误触发");
    assert.deepEqual(
      Array.from(deviceConfig.texts.debounce.labels, (item) => item.label),
      ["低", "中", "高"],
    );
  }
}

async function testProfileResetAndDpiEncoding() {
  const ProtocolApi = loadProtocolApi();
  const Api = ProtocolApi.MouseMouseHidApi;
  const api = new Api();

  api.device = makeDevice(0xe020, "Ninjutso Ten");
  assert.equal(api._profile.isTenProfile, true);
  assert.equal(api._profile.isTenWired, true);
  assert.equal(api._profile.gateStrategy, "session");

  let commands = [];
  api._driver.runSequence = async (nextCommands) => {
    commands = nextCommands;
  };
  await api.setBatchFeatures({
    dpiSlotsX: [100, 800, 1600, 26000],
  });
  const tenDpiCommand = commands.find((command) => command.cmd === 0x03 && hexBytes(command.hex)[7] === 3);
  assert.ok(tenDpiCommand, "TEN slot 4 DPI command should be generated");
  assert.deepEqual(hexBytes(tenDpiCommand.hex).slice(8, 11), [0x07, 0x02, 0x00]);

  api.device = makeDevice(0xe010, "Ninjutso Sora V3");
  assert.equal(api._profile.isTenProfile, undefined);
  assert.equal(api._profile.isTenWired, undefined);
  assert.equal(api._profile.gateStrategy, "atomic");
  assert.equal(api._profile.compat.dpiDecodeLegacyScale50, false);
  assert.deepEqual(Array.from(api._profile.capabilities.performanceModes), ["hp", "sport", "oc"]);

  commands = [];
  await api.setBatchFeatures({
    dpiSlotsX: [100, 800, 1600, 26000],
  });
  const soraDpiCommand = commands.find((command) => command.cmd === 0x03 && hexBytes(command.hex)[7] === 3);
  assert.ok(soraDpiCommand, "Sora V3 slot 4 DPI command should be generated");
  assert.deepEqual(hexBytes(soraDpiCommand.hex).slice(8, 11), [0x90, 0x65, 0x00]);
}

async function testDebounceEncoding() {
  const ProtocolApi = loadProtocolApi();
  const api = new ProtocolApi.MouseMouseHidApi();

  for (const [productId, productName] of [
    [0xe020, "Ninjutso Ten"],
    [0xe010, "Ninjutso Sora V3"],
  ]) {
    api.device = makeDevice(productId, productName);
    let commands = [];
    api._driver.runSequence = async (nextCommands) => {
      commands = nextCommands;
    };

    for (const debounceMs of [0, 1, 2]) {
      commands = [];
      await api.setBatchFeatures({ debounceMs });
      const debounceCommand = commands.find((command) => command.cmd === 0x29);
      assert.ok(debounceCommand, `${productName} debounce command should be generated`);
      assert.equal(hexBytes(debounceCommand.hex)[7], debounceMs);
    }
  }
}

function installSnapshotStubs(api, commandLog, debounceMs = 0) {
  api._readBatteryPercent = async () => 75;
  api._readCmdU8 = async (cmd) => (cmd === 0x2a ? debounceMs : 0);
  api._readDpiValueByIndex = async () => 800;
  api._readButtonMappingBySrc = async () => ({ funckey: 1, keycode: 0 });
  api._readCmdBytes = async (cmd, options = {}) => {
    commandLog.push({
      cmd,
      dataBytes: Array.from(options.dataBytes || []),
    });
    if (cmd === 0x10) return new Uint8Array([1]);
    if (cmd === 0x1e) return new Uint8Array([1]);
    if (cmd === 0x1c) return new Uint8Array([0]);
    if (cmd === 0x15) return new Uint8Array([1, 2, 3]);
    if (cmd === 0xa3) return new Uint8Array([0]);
    if (options.expectedLen === 4) return new Uint8Array([1, 0, 0, 0]);
    if (options.expectedLen === 3) return new Uint8Array([1, 2, 3]);
    return new Uint8Array([0]);
  };
}

async function testWiredSnapshotSkipsReceiverCommands() {
  const ProtocolApi = loadProtocolApi();
  const api = new ProtocolApi.MouseMouseHidApi();
  const commandLog = [];

  api.device = makeDevice(0xe020, "Ninjutso Ten");
  installSnapshotStubs(api, commandLog, 1);
  const snapshot = await api._readDeviceConfigSnapshot();

  assert.equal(snapshot.wireless, false);
  assert.equal(snapshot.capabilities.wired, true);
  assert.equal(snapshot.debounceMs, 1);
  assert.equal(snapshot.debounceLevel, "mid");
  assert.deepEqual(Array.from(snapshot.receiverFwBytes), []);
  assert.deepEqual(Array.from(snapshot.infoB), []);
  assert.equal(commandLog.some((entry) => entry.cmd === 0xa7), false);
  assert.equal(
    commandLog.some((entry) => entry.cmd === 0x15 && entry.dataBytes[0] === 1),
    false,
  );
  for (const ledReadCommand of [0x20, 0x22, 0x26, 0x28, 0x30]) {
    assert.equal(commandLog.some((entry) => entry.cmd === ledReadCommand), false);
  }
}

async function testDebounceReadbackNormalization() {
  const ProtocolApi = loadProtocolApi();

  for (const [rawValue, expectedValue, expectedLevel] of [
    [5, 1, "mid"],
    [10, 2, "high"],
  ]) {
    const api = new ProtocolApi.MouseMouseHidApi();
    api.device = makeDevice(0xe020, "Ninjutso Ten");
    installSnapshotStubs(api, [], rawValue);
    const snapshot = await api._readDeviceConfigSnapshot();
    assert.equal(snapshot.debounceMs, expectedValue);
    assert.equal(snapshot.debounceLevel, expectedLevel);
  }
}

async function testSecurityGateAlwaysCloses() {
  const ProtocolApi = loadProtocolApi();
  const api = new ProtocolApi.MouseMouseHidApi();
  const events = [];

  api.device = makeDevice(0xe020, "Ninjutso Ten");
  api._driver.unlockGate = async () => {
    events.push("unlock");
  };
  api._driver.lockGate = async () => {
    events.push("lock");
  };
  api._readDeviceConfigSnapshot = async () => {
    events.push("read");
    throw new Error("simulated read failure");
  };

  await assert.rejects(api.requestConfig(), /simulated read failure/);
  assert.deepEqual(events, ["unlock", "read", "lock"]);

  events.length = 0;
  api._readBatteryPercent = async () => {
    events.push("battery");
    return 75;
  };
  await api.requestBattery();
  assert.deepEqual(events, ["unlock", "battery", "lock"]);
}

(async () => {
  await testRuntimePidIdentification();
  testSlamClickUiConfiguration();
  await testProfileResetAndDpiEncoding();
  await testDebounceEncoding();
  await testWiredSnapshotSkipsReceiverCommands();
  await testDebounceReadbackNormalization();
  await testSecurityGateAlwaysCloses();
  console.log("Ninjutso TEN protocol tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
