const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const runtimePath = path.join(__dirname, "..", "src", "core", "device_runtime.js");
const runtimeSource = fs.readFileSync(runtimePath, "utf8");

const modelByPid = new Map([
  [0x00b3, "hyperpolling"],
  [0x00c0, "viper-v3"],
  [0x00c1, "viper-v3"],
  [0x00c5, "deathadder-v3-hyperspeed"],
  [0x00e5, "viper-v4"],
  [0x00e6, "viper-v4"],
]);

const storage = new Map([["device.selected", "razer"]]);
const localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
};

const ProtocolApi = {
  MouseMouseHidApi: function MouseMouseHidApi() {},
  RAZER_HID: {
    getTransportMeta(productId) {
      const pid = Number(productId);
      return {
        pid,
        modelKey: modelByPid.get(pid) || `pid-${pid}`,
        controlUsagePage: 0x0c,
        webhidReportId: 0,
      };
    },
  },
};

const context = {
  console,
  localStorage,
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
  ProtocolApi,
  __DEVICE_PROTOCOL_DEVICE__: "razer",
};

vm.createContext(context);
vm.runInContext(runtimeSource, context, { filename: runtimePath });

const runtime = context.window.DeviceRuntime;

function device(productId, productName, collections) {
  return {
    vendorId: 0x1532,
    productId,
    productName,
    collections,
  };
}

function inputCollection(usagePage = 0x01, usage = 0x02) {
  return {
    usagePage,
    usage,
    inputReports: [{ reportId: 5 }],
  };
}

function featureCollection(usagePage = 0xff00, usage = 0x01, reportId = 0) {
  return {
    usagePage,
    usage,
    featureReports: [{ reportId }],
  };
}

{
  const multiCollection = device(0x00e5, "Viper V4", [
    inputCollection(),
    featureCollection(),
  ]);
  const result = runtime.resolveRazerConnectionPlans([multiCollection], {
    primaryDevice: multiCollection,
  });

  assert.equal(result.connectionPlanError, null);
  assert.equal(result.connectionPlans[0].controlDevice, multiCollection);
  assert.equal(result.connectionPlans[0].eventMode, "shared");
  assert.equal(result.connectionPlans[0].controlSummary.hasFeatureReportZero, true);
}

{
  const control = device(0x00e6, "Viper V4", [featureCollection(0xff01)]);
  const event = device(0x00e6, "Viper V4", [inputCollection()]);
  const result = runtime.resolveRazerConnectionPlans([event, control], {
    primaryDevice: event,
  });

  assert.equal(result.connectionPlanError, null);
  assert.equal(result.connectionPlans[0].controlDevice, control);
  assert.equal(result.connectionPlans[0].eventDevice, event);
  assert.equal(result.connectionPlans[0].eventMode, "separate");
}

{
  const implicitReportZero = device(0x00c5, "DeathAdder V3 HyperSpeed", [
    inputCollection(),
  ]);
  const result = runtime.resolveRazerConnectionPlans([implicitReportZero], {
    primaryDevice: implicitReportZero,
  });

  assert.equal(result.connectionPlanError, null);
  assert.equal(result.connectionPlans[0].controlSummary.hasFeatureReports, false);
  assert.equal(result.connectionPlans[0].controlSummary.canTryFeatureReportZero, true);
}

{
  const inputOnly = device(0x00e5, "Viper V4", [inputCollection()]);
  const result = runtime.resolveRazerConnectionPlans([inputOnly], {
    primaryDevice: inputOnly,
  });

  assert.equal(result.connectionPlans.length, 0);
  assert.equal(result.connectionPlanError.code, "MISSING_RAZER_CONTROL_INTERFACE");
}

{
  const viperV3 = device(0x00c1, "Viper V3", [inputCollection()]);
  const result = runtime.resolveRazerConnectionPlans([viperV3], {
    primaryDevice: viperV3,
  });

  assert.equal(result.connectionPlanError, null);
  assert.equal(result.connectionPlans[0].transportMode, "legacy-v3");
}

{
  const selected = device(0x00e5, "Viper V4", [
    inputCollection(),
    featureCollection(),
  ]);
  let requestedFilters = null;
  context.navigator.hid.requestDevice = async ({ filters }) => {
    requestedFilters = filters;
    return [selected];
  };
  context.navigator.hid.getDevices = async () => [];

  runtime.connect(true).then((result) => {
    const viperV4Filters = requestedFilters.filter((filter) => (
      filter.vendorId === 0x1532 && filter.productId === 0x00e5
    ));
    assert.equal(viperV4Filters.length, 1);
    assert.equal(viperV4Filters[0].vendorId, 0x1532);
    assert.equal(viperV4Filters[0].productId, 0x00e5);
    assert.equal("usagePage" in viperV4Filters[0], false);
    assert.equal(result.connectionPlanError, null);
    console.log("Razer connection-plan tests passed");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
