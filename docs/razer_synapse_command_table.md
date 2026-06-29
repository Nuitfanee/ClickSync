# Razer Synapse Desktop Command Table (V3 PRO SE)

逆向来源：RazerAppEngine 4.0.683 `app.asar` → CDP dump → `6120.pretty.js`

Uint8Array 格式：`[dataSize, commandClass, commandId]`

---

## Class 0x00 — General

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| (unnamed) | `[80, 0, 128]` | 0x00 | 0x80 | — |
| (unnamed) | `[80, 0, 0]` | 0x00 | 0x00 | — |
| Get Firmware Version | `[2, 0, 129]` | 0x00 | 0x81 | `getFirmwareVersion` |
| Get Serial Number | `[22, 0, 130]` | 0x00 | 0x82 | `getSerialNumber` |
| Set Serial Number | `[22, 0, 2]` | 0x00 | 0x02 | — |
| Get Protocol Version | `[2, 0, 131]` | 0x00 | 0x83 | — |
| (unnamed) | `[2, 0, 3]` | 0x00 | 0x03 | — |
| Get Device Mode | `[2, 0, 132]` | 0x00 | 0x84 | `getDeviceMode` |
| Set Device Mode | `[2, 0, 4]` | 0x00 | 0x04 | `setDeviceMode` |
| Get Device Polling Period | `[1, 0, 133]` | 0x00 | 0x85 | `getPollingRate` |
| Set Device Polling Period | `[1, 0, 5]` | 0x00 | 0x05 | `setPollingRate` |
| Get Edition Information | `[3, 0, 134]` | 0x00 | 0x86 | — |
| Set Edition Information | `[3, 0, 6]` | 0x00 | 0x06 | — |
| Get Extended Firmware Version | `[4, 0, 135]` | 0x00 | 0x87 | — |
| (unnamed) | `[4, 0, 136]` | 0x00 | 0x88 | — |
| (unnamed) | `[4, 0, 8]` | 0x00 | 0x08 | — |
| Get Game Mode State | `[4, 0, 136]` | 0x00 | 0x88 | — |
| Set Game Mode State | `[4, 0, 8]` | 0x00 | 0x08 | — |
| (unnamed) | `[1, 0, 137]` | 0x00 | 0x89 | — |
| (unnamed) | `[1, 0, 9]` | 0x00 | 0x09 | — |
| (unnamed) | `[2, 0, 138]` | 0x00 | 0x8a | — |
| (unnamed) | `[2, 0, 10]` | 0x00 | 0x0a | — |
| Set Device Reset | `[1, 0, 11]` | 0x00 | 0x0b | — |
| (unnamed) | `[2, 0, 140]` | 0x00 | 0x8c | — |
| (unnamed) | `[2, 0, 12]` | 0x00 | 0x0c | — |
| (unnamed) | `[4, 0, 141]` | 0x00 | 0x8d | — |
| (unnamed) | `[4, 0, 13]` | 0x00 | 0x0d | — |
| (unnamed) | `[2, 0, 142]` | 0x00 | 0x8e | — |
| Get Device Profile Polling Period | `[2, 0, 14]` | 0x00 | 0x0e | — |
| (unnamed) | `[2, 0, 145]` | 0x00 | 0x91 | — |
| Get Dock Firmware Version | `[2, 0, 145]` | 0x00 | 0x91 | — |
| Get Dock Serial Number | `[22, 0, 146]` | 0x00 | 0x92 | — |
| (unnamed) | `[22, 0, 18]` | 0x00 | 0x12 | — |
| Get Dock Extended Firmware Version | `[4, 0, 147]` | 0x00 | 0x93 | — |
| (unnamed) | `[80, 0, 148]` | 0x00 | 0x94 | — |
| (unnamed) | `[6, 0, 149]` | 0x00 | 0x95 | — |
| (unnamed) | `[6, 0, 21]` | 0x00 | 0x15 | — |
| (unnamed) | `[1, 0, 150]` | 0x00 | 0x96 | — |
| (unnamed) | `[1, 0, 22]` | 0x00 | 0x16 | — |
| (unnamed) | `[1, 0, 23]` | 0x00 | 0x17 | — |
| (unnamed) | `[4, 0, 159]` | 0x00 | 0x9f | — |
| (unnamed) | `[1, 0, 160]` | 0x00 | 0xa0 | — |
| (unnamed) | `[1, 0, 32]` | 0x00 | 0x20 | — |
| (unnamed) | `[1, 0, 162]` | 0x00 | 0xa2 | — |
| (unnamed) | `[2, 0, 163]` | 0x00 | 0xa3 | — |
| (unnamed) | `[6, 0, 164]` | 0x00 | 0xa4 | — |
| (unnamed) | `[6, 0, 36]` | 0x00 | 0x24 | — |
| (unnamed) | `[1, 0, 179]` | 0x00 | 0xb3 | — |
| Get Device Ambidextrous Information | `[1, 0, 51]` | 0x00 | 0x33 | — |
| (unnamed) | `[80, 0, 180]` | 0x00 | 0xb4 | — |
| (unnamed) | `[80, 0, 52]` | 0x00 | 0x34 | — |
| (unnamed) | `[80, 0, 181]` | 0x00 | 0xb5 | — |
| Get Device HW Info | `[80, 0, 181]` | 0x00 | 0xb5 | — |
| (unnamed) | `[80, 0, 54]` | 0x00 | 0x36 | — |
| Set Device HW Info Force Check | `[80, 0, 54]` | 0x00 | 0x36 | — |
| (unnamed) | `[1, 0, 183]` | 0x00 | 0xb7 | — |
| (unnamed) | `[1, 0, 55]` | 0x00 | 0x37 | — |
| Get Device External Power Supply Status | `[1, 0, 184]` | 0x00 | 0xb8 | — |
| Set Device External Power Supply Status | `[1, 0, 56]` | 0x00 | 0x38 | — |
| Get Device Wireless Connection Status | `[1, 0, 185]` | 0x00 | 0xb9 | — |
| Get Mouse Side Pad Connection Status | `[1, 0, 187]` | 0x00 | 0xbb | — |
| Get Device On Dock Charging Status | `[3, 0, 188]` | 0x00 | 0xbc | — |
| (unnamed) | `[3, 0, 60]` | 0x00 | 0x3c | — |
| Get Dock Edition Information | `[3, 0, 60]` | 0x00 | 0x3c | — |
| Set Dock Edition Information | `[3, 0, 60]` | 0x00 | 0x3c | — |
| (unnamed) | `[80, 0, 191]` | 0x00 | 0xbf | — |
| Get Multiple Device Wireless Connection Status V2 | `[80, 0, 191]` | 0x00 | 0xbf | — |
| (unnamed) | `[2, 0, 192]` | 0x00 | 0xc0 | — |
| (unnamed) | `[2, 0, 64]` | 0x00 | 0x40 | — |
| Get USB High Speed Polling Period | `[2, 0, 192]` | 0x00 | 0xc0 | — |
| Set USB High Speed Polling Period | `[2, 0, 64]` | 0x00 | 0x40 | — |
| (unnamed) | `[3, 0, 65]` | 0x00 | 0x41 | — |
| Set Device Pairing Mode | `[3, 0, 65]` | 0x00 | 0x41 | — |
| (unnamed) | `[2, 0, 66]` | 0x00 | 0x42 | — |
| Set Device Unpair | `[2, 0, 66]` | 0x00 | 0x42 | — |
| (unnamed) | `[1, 0, 70]` | 0x00 | 0x46 | — |
| Set Device Scan | `[1, 0, 70]` | 0x00 | 0x46 | — |
| (unnamed) | `[4, 0, 195]` | 0x00 | 0xc3 | — |
| Get Falcon Protocol Version | `[4, 0, 195]` | 0x00 | 0xc3 | — |
| (unnamed) | `[1, 0, 196]` | 0x00 | 0xc4 | — |
| (unnamed) | `[1, 0, 68]` | 0x00 | 0x44 | — |
| Get Hardware Auto Detect Ctrl | `[1, 0, 196]` | 0x00 | 0xc4 | — |
| Set Hardware Auto Detect Ctrl | `[1, 0, 68]` | 0x00 | 0x44 | — |
| (unnamed) | `[3, 0, 197]` | 0x00 | 0xc5 | — |
| Get Multiple Device Primary Device | `[3, 0, 197]` | 0x00 | 0xc5 | — |
| (unnamed) | `[2, 0, 199]` | 0x00 | 0xc7 | — |
| (unnamed) | `[2, 0, 71]` | 0x00 | 0x47 | — |
| Get Active Wireless Connection State | `[2, 0, 199]` | 0x00 | 0xc7 | — |
| Set Active Wireless Connection State | `[2, 0, 71]` | 0x00 | 0x47 | — |
| (unnamed) | `[1, 0, 213]` | 0x00 | 0xd5 | — |
| (unnamed) | `[1, 0, 85]` | 0x00 | 0x55 | — |
| Get Device Auto Pairing Status | `[1, 0, 213]` | 0x00 | 0xd5 | — |
| Set Device Auto Pairing Status | `[1, 0, 85]` | 0x00 | 0x55 | — |
| (unnamed) | `[1, 0, 215]` | 0x00 | 0xd7 | — |
| Get Device Power Button Status | `[1, 0, 215]` | 0x00 | 0xd7 | — |
| (unnamed) | `[80, 0, 216]` | 0x00 | 0xd8 | — |
| (unnamed) | `[80, 0, 88]` | 0x00 | 0x58 | — |
| Get Multiple Device Wired Connection Status | `[80, 0, 216]` | 0x00 | 0xd8 | — |
| Set Multiple Device Wired Connection Status | `[80, 0, 88]` | 0x00 | 0x58 | — |
| (unnamed) | `[3, 0, 217]` | 0x00 | 0xd9 | — |
| (unnamed) | `[3, 0, 89]` | 0x00 | 0x59 | — |
| (unnamed) | `[1, 7, 150]` | 0x07 | 0x96 | — |
| Get Dongle Connection Quality Status | `[2, 0, 218]` | 0x00 | 0xda | — |
| (unnamed) | `[2, 0, 90]` | 0x00 | 0x5a | — |
| Get Device Game Mode Selection | `[2, 0, 218]` | 0x00 | 0xda | — |
| Set Device Game Mode Selection | `[2, 0, 90]` | 0x00 | 0x5a | — |

---

## Class 0x02 — Button Mapping

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| (unnamed) | `[80, 2, 128]` | 0x02 | 0x80 | `getButtonMapping` (REP4) |
| (unnamed) | `[80, 2, 0]` | 0x02 | 0x00 | `setButtonMapping` (REP4) |
| (unnamed) | `[2, 2, 129]` | 0x02 | 0x81 | — |
| (unnamed) | `[2, 2, 130]` | 0x02 | 0x82 | — |
| (unnamed) | `[2, 2, 2]` | 0x02 | 0x02 | — |
| (unnamed) | `[4, 2, 130]` | 0x02 | 0x82 | — |
| (unnamed) | `[4, 2, 2]` | 0x02 | 0x02 | — |
| (unnamed) | `[80, 2, 131]` | 0x02 | 0x83 | — |
| (unnamed) | `[80, 2, 3]` | 0x02 | 0x03 | — |
| (unnamed) | `[80, 2, 132]` | 0x02 | 0x84 | — |
| (unnamed) | `[2, 2, 133]` | 0x02 | 0x85 | — |
| (unnamed) | `[2, 2, 5]` | 0x02 | 0x05 | — |
| (unnamed) | `[2, 2, 134]` | 0x02 | 0x86 | — |
| (unnamed) | `[2, 2, 135]` | 0x02 | 0x87 | — |
| (unnamed) | `[2, 2, 7]` | 0x02 | 0x07 | — |
| (unnamed) | `[2, 2, 136]` | 0x02 | 0x88 | — |
| (unnamed) | `[80, 2, 12]` | 0x02 | 0x0c | — |
| (unnamed) | `[80, 2, 141]` | 0x02 | 0x8d | — |
| (unnamed) | `[80, 2, 13]` | 0x02 | 0x0d | — |
| (unnamed) | `[80, 2, 142]` | 0x02 | 0x8e | — |
| (unnamed) | `[80, 2, 143]` | 0x02 | 0x8f | — |
| (unnamed) | `[80, 2, 15]` | 0x02 | 0x0f | — |
| Get Key Assignment List | `[80, 2, 15]` | 0x02 | 0x0f | — |
| (unnamed) | `[5, 2, 145]` | 0x02 | 0x91 | — |
| (unnamed) | `[5, 2, 17]` | 0x02 | 0x11 | — |
| (unnamed) | `[80, 2, 146]` | 0x02 | 0x92 | — |
| (unnamed) | `[80, 2, 18]` | 0x02 | 0x12 | — |
| (unnamed) | `[2, 2, 148]` | 0x02 | 0x94 | — |
| (unnamed) | `[2, 2, 20]` | 0x02 | 0x14 | — |
| (unnamed) | `[5, 2, 149]` | 0x02 | 0x95 | — |
| (unnamed) | `[5, 2, 21]` | 0x02 | 0x15 | — |
| (unnamed) | `[2, 2, 150]` | 0x02 | 0x96 | — |
| (unnamed) | `[2, 2, 22]` | 0x02 | 0x16 | — |

---

## Class 0x04 — DPI

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| (unnamed) | `[1, 4, 128]` | 0x04 | 0x80 | — |
| (unnamed) | `[1, 4, 0]` | 0x04 | 0x00 | — |
| (unnamed) | `[3, 4, 129]` | 0x04 | 0x81 | — |
| (unnamed) | `[3, 4, 1]` | 0x04 | 0x01 | — |
| (unnamed) | `[8, 4, 130]` | 0x04 | 0x82 | — |
| (unnamed) | `[8, 4, 2]` | 0x04 | 0x02 | — |
| (unnamed) | `[38, 4, 131]` | 0x04 | 0x83 | — |
| (unnamed) | `[38, 4, 3]` | 0x04 | 0x03 | — |
| (unnamed) | `[2, 4, 132]` | 0x04 | 0x84 | — |
| (unnamed) | `[2, 4, 4]` | 0x04 | 0x04 | — |
| Get Profile Active DPI Setting | `[7, 4, 133]` | 0x04 | 0x85 | `getActiveDpiStageIndex` |
| Set Profile Active DPI Setting | `[7, 4, 5]` | 0x04 | 0x05 | `setActiveDpiStageIndex` |
| Get Profile DPI Class Data | `[80, 4, 134]` | 0x04 | 0x86 | `getDpiStages` |
| Set Profile DPI Class Data | `[80, 4, 6]` | 0x04 | 0x06 | `setDpiStages` |
| (unnamed) | `[3, 4, 144]` | 0x04 | 0x90 | — |
| (unnamed) | `[3, 4, 16]` | 0x04 | 0x10 | — |
| (unnamed) | `[3, 4, 145]` | 0x04 | 0x91 | — |
| (unnamed) | `[3, 4, 17]` | 0x04 | 0x11 | — |
| (unnamed) | `[3, 4, 146]` | 0x04 | 0x92 | — |
| (unnamed) | `[3, 4, 18]` | 0x04 | 0x12 | — |

---

## Class 0x07 — Battery & Power

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| Get Battery Level | `[2, 7, 128]` | 0x07 | 0x80 | `getBatteryLevel` |
| Get Battery Critical Level | `[1, 7, 129]` | 0x07 | 0x81 | `getLowBatteryThreshold` |
| Set Battery Critical Level | `[1, 7, 1]` | 0x07 | 0x01 | `setLowBatteryThreshold` |
| Get LED Max Brightness on Battery Mode | `[1, 7, 130]` | 0x07 | 0x82 | — |
| Set LED Max Brightness on Battery Mode | `[1, 7, 2]` | 0x07 | 0x02 | — |
| Get Time to Sleep Mode on Battery Mode | `[2, 7, 131]` | 0x07 | 0x83 | `getIdle` |
| Set Time to Sleep Mode on Battery Mode | `[2, 7, 3]` | 0x07 | 0x03 | `setIdle` |
| Get Device Charging Status | `[2, 7, 132]` | 0x07 | 0x84 | `getChargingStatus` |
| (unnamed) | `[3, 7, 133]` | 0x07 | 0x85 | — |
| (unnamed) | `[3, 7, 134]` | 0x07 | 0x86 | — |
| (unnamed) | `[3, 7, 6]` | 0x07 | 0x06 | — |
| Get Auto Sleep Mode | `[1, 7, 135]` | 0x07 | 0x87 | — |
| Set Auto Sleep Mode | `[1, 7, 7]` | 0x07 | 0x07 | — |
| (unnamed) | `[2, 7, 136]` | 0x07 | 0x88 | — |
| (unnamed) | `[2, 7, 8]` | 0x07 | 0x08 | — |
| (unnamed) | `[3, 7, 137]` | 0x07 | 0x89 | — |
| (unnamed) | `[3, 7, 9]` | 0x07 | 0x09 | — |
| (unnamed) | `[2, 7, 138]` | 0x07 | 0x8a | — |
| (unnamed) | `[2, 7, 10]` | 0x07 | 0x0a | — |
| (unnamed) | `[5, 7, 139]` | 0x07 | 0x8b | — |
| Get Time To Dim | `[5, 7, 139]` | 0x07 | 0x8b | — |
| Set Time To Dim | `[5, 7, 11]` | 0x07 | 0x0b | — |
| (unnamed) | `[2, 7, 140]` | 0x07 | 0x8c | — |
| Get Adapter Wattage Level | `[3, 7, 142]` | 0x07 | 0x8e | — |
| Get Power Security Status | `[1, 7, 143]` | 0x07 | 0x8f | — |
| Get CPU Boost Control | `[1, 7, 143]` | 0x07 | 0x8f | — |
| Set CPU Boost Control | `[1, 7, 15]` | 0x07 | 0x0f | — |
| Get Power Mode Control | `[1, 7, 144]` | 0x07 | 0x90 | — |
| Set Power Mode Control | `[1, 7, 16]` | 0x07 | 0x10 | — |
| Get Indicator Led Configuration | `[1, 7, 145]` | 0x07 | 0x91 | — |
| Set Indicator Led Configuration | `[1, 7, 17]` | 0x07 | 0x11 | — |
| (unnamed) | `[1, 7, 146]` | 0x07 | 0x92 | — |
| (unnamed) | `[1, 7, 18]` | 0x07 | 0x12 | — |
| Get Battery Charge Limiter Control | `[3, 7, 147]` | 0x07 | 0x93 | — |
| Set Battery Charge Limiter Control | `[3, 7, 19]` | 0x07 | 0x13 | — |
| Get Smart illumination Control | `[1, 7, 148]` | 0x07 | 0x94 | — |
| Set Smart illumination Control | `[1, 7, 20]` | 0x07 | 0x14 | — |
| Get Battery Discharge Curve | `[3, 7, 149]` | 0x07 | 0x95 | — |
| Set Battery Discharge Curve | `[3, 7, 21]` | 0x07 | 0x15 | — |
| Get indicator LEDs Configuration | `[1, 7, 149]` | 0x07 | 0x95 | — |
| Set indicator LEDs Configuration | `[1, 7, 21]` | 0x07 | 0x15 | — |
| Get Low Power Mode State | `[1, 7, 150]` | 0x07 | 0x96 | — |

---

## Class 0x0b — Sensor / Proximity / Smart Tracking

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| Get Proximity Sensor Calibration | `[2, 11, 128]` | 0x0b | 0x80 | — |
| Start Proximity Sensor Calibration | `[2, 11, 0]` | 0x0b | 0x00 | — |
| Get Proximity Sensor Threshold | `[8, 11, 129]` | 0x0b | 0x81 | — |
| Set Proximity Sensor Threshold | `[8, 11, 1]` | 0x0b | 0x01 | — |
| Get Proximity Sensor State | `[3, 11, 131]` | 0x0b | 0x83 | `getProximitySensorState` |
| Set Proximity Sensor State | `[3, 11, 3]` | 0x0b | 0x03 | `setProximitySensorState` |
| Get Proximity Sensor Hardware | `[6, 11, 132]` | 0x0b | 0x84 | — |
| Set Proximity Sensor Hardware | `[6, 11, 4]` | 0x0b | 0x04 | — |
| Get Proximity Sensor Configuration | `[10, 11, 133]` | 0x0b | 0x85 | `getProximitySensorConfiguration` |
| Set Proximity Sensor Configuration | `[10, 11, 5]` | 0x0b | 0x05 | `setProximitySensorConfiguration` |
| Get Proximity Sensor Manual Calibration | `[7, 11, 134]` | 0x0b | 0x86 | — |
| Get Proximity Sensor Accuracy | `[3, 11, 135]` | 0x0b | 0x87 | — |
| Set Proximity Sensor Accuracy | `[3, 11, 7]` | 0x0b | 0x07 | — |
| Get Proximity Sensor Calibration Data | `[50, 11, 136]` | 0x0b | 0x88 | — |
| Set Proximity Sensor Calibration Data | `[50, 11, 8]` | 0x0b | 0x08 | — |
| Get Proximity Sensor Control | `[4, 11, 137]` | 0x0b | 0x89 | — |
| Set Proximity Sensor Control | `[4, 11, 9]` | 0x0b | 0x09 | — |
| Get Proximity Sensor Lifted Indicator | `[3, 11, 138]` | 0x0b | 0x8a | — |
| Set Proximity Sensor Lifted Indicator | `[3, 11, 10]` | 0x0b | 0x0a | — |
| Get Proximity Sensor Lift Setting | `[4, 11, 139]` | 0x0b | 0x8b | `getProximitySensorLiftSetting` |
| Set Proximity Sensor Lift Setting | `[4, 11, 11]` | 0x0b | 0x0b | `setProximitySensorLiftSetting` |
| Set Proximity Sensor Lift To Track Calibration Data | `[18, 11, 140]` | 0x0b | 0x8c | — |
| Set Proximity Sensor Lift To Track Calibration Data (write) | `[18, 11, 12]` | 0x0b | 0x0c | — |
| Set Proximity Sensor Track To Lift Calibration Data | `[18, 11, 141]` | 0x0b | 0x8d | — |
| Set Proximity Sensor Track To Lift Calibration Data (write) | `[18, 11, 13]` | 0x0b | 0x0d | — |
| Get Proximity Sensor Acceleration State | `[2, 11, 144]` | 0x0b | 0x90 | `getProximitySensorAccelerationState` |
| Set Proximity Sensor Acceleration State | `[2, 11, 16]` | 0x0b | 0x10 | `setProximitySensorAccelerationState` |
| Get Proximity Sensor Acceleration Mode | `[2, 11, 145]` | 0x0b | 0x91 | `getProximitySensorAccelerationMode` |
| Set Proximity Sensor Acceleration Mode | `[2, 11, 17]` | 0x0b | 0x11 | `setProximitySensorAccelerationMode` |
| Get Proximity Sensor Acceleration Curve Setting | `[3, 11, 146]` | 0x0b | 0x92 | — |
| Set Proximity Sensor Acceleration Curve Setting | `[3, 11, 18]` | 0x0b | 0x12 | — |
| Get Proximity Sensor Acceleration Curve Data | `[37, 11, 147]` | 0x0b | 0x93 | — |
| Set Proximity Sensor Acceleration Curve Data | `[37, 11, 19]` | 0x0b | 0x13 | — |
| Get Proximity Sensor Angle Tune | `[3, 11, 148]` | 0x0b | 0x94 | `getSensorAngle` |
| Set Proximity Sensor Angle Tune | `[3, 11, 20]` | 0x0b | 0x14 | `setSensorAngle` |

---

## Class 0x0d — Thermal Fan (笔记本散热)

| 雷云名 | Uint8Array | class | cmd | ClickSync 函数 |
|---|---|---|---|---|
| Get Thermal Fan Id List | `[80, 13, 128]` | 0x0d | 0x80 | — |
| Get Thermal Fan Speed | `[3, 13, 129]` | 0x0d | 0x81 | — |
| Set Thermal Fan Speed | `[3, 13, 1]` | 0x0d | 0x01 | — |
| Get Thermal Fan Mode | `[4, 13, 130]` | 0x0d | 0x82 | — |
| Set Thermal Fan Mode | `[4, 13, 2]` | 0x0d | 0x02 | — |
| Get Thermal Fan Information | `[12, 13, 131]` | 0x0d | 0x83 | — |
| Set Thermal Fan Table | `[80, 13, 132]` | 0x0d | 0x84 | — |
| Get Thermal Reading | `[80, 13, 133]` | 0x0d | 0x85 | — |
| Get Thermal Active Core Radio Limit | `[7, 13, 134]` | 0x0d | 0x86 | — |
| Get Thermal Advance Fan Mode | `[3, 13, 135]` | 0x0d | 0x87 | — |
| Set Thermal Advance Fan Mode | `[3, 13, 7]` | 0x0d | 0x07 | — |
| Get Thermal Advance Fan Mode Wattage | `[3, 13, 135]` | 0x0d | 0x87 | — |
| Set Thermal Advance Fan Mode Wattage | `[3, 13, 7]` | 0x0d | 0x07 | — |
| Get Thermal Fan Current Speed | `[3, 13, 136]` | 0x0d | 0x88 | — |
| Get VGA Configure Setting | `[2, 13, 137]` | 0x0d | 0x89 | — |
| Set VGA Configure Setting | `[2, 13, 9]` | 0x0d | 0x09 | — |
| Get Thermal Fan Cooling Mode | `[3, 13, 144]` | 0x0d | 0x90 | — |
| Set Thermal Fan Cooling Mode | `[3, 13, 16]` | 0x0d | 0x10 | — |
| Get Thermal Fan Duty Cycle | `[1, 13, 142]` | 0x0d | 0x8e | — |
| Set Thermal Fan Duty Cycle | `[1, 13, 14]` | 0x0d | 0x0e | — |
| Get Mini LED Panel Resolution | `[1, 13, 143]` | 0x0d | 0x8f | — |
| Set Mini LED Panel Resolution | `[1, 13, 15]` | 0x0d | 0x0f | — |
| Get SKU hardware configuration | `[2, 13, 138]` | 0x0d | 0x8a | — |

---

## 命令编号规律

- **Get 命令**：cmd = 0x80 + N（如 0x80, 0x81, 0x82...）
- **Set 命令**：cmd = N（如 0x00, 0x01, 0x02...）
- **dataSize**：命令参数字节数（不含 class/cmd 本身）
- **class**：功能域（0x00=General, 0x02=Button, 0x04=DPI, 0x07=Battery, 0x0b=Sensor, 0x0d=Thermal）

## 雷云报文布局 vs ClickSync

| 字段 | 雷云 Protocol 2.5 | ClickSync/OpenRazer |
|---|---|---|
| [0] | status | status |
| [1] | transactionId | transactionId |
| [2-4] | reserved | reserved |
| [5] | dataSize (单字节) | dataSize high byte |
| [6] | commandClass | dataSize low byte |
| [7] | commandId | commandClass |
| [8+] | arguments | commandId |
| [88] | checksum | arguments |
| [89] | 0x00 | checksum + reserved |

**注意**：雷云 Protocol 2.5 的 dataSize 是单字节（[5]），而 ClickSync/OpenRazer 用双字节 big-endian（[5-6]）。class/cmd 位置因此偏移 1 字节。
