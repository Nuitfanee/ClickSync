# Razer Viper V3 Pro SE Protocol Reference

## Device Info
- **VID**: 0x1532
- **PID**: 0x00de (Wired), 0x00df (Wireless)
- **Transport**: Legacy V3
- **Report ID**: 0x00
- **Report Size**: 90 bytes

## Command Format

### Packet Structure
```
Byte 0:   Status (0x00=request, 0x02=success, 0x03=error)
Byte 1:   Transaction ID (0x1f)
Byte 2-4: Reserved (0x00)
Byte 5:   Data Size (high byte)
Byte 6:   Data Size (low byte)
Byte 7:   Command Class
Byte 8:   Command ID
Byte 9+:  Arguments
Byte 88:  Checksum (XOR of bytes 2-87)
Byte 89:  0x00
```

### Response Format
Same as request, with:
- Byte 0: Status (0x02 = success)
- Bytes 8+: Echo of class/cmd + response data

---

## Class 0x00 - General

### Get Firmware Version
- **Command**: class=0x00, cmd=0x81, dataSize=0x02
- **Response**: [major, minor]
- **Example**: [0x01, 0x00] = v1.0

### Get Serial Number
- **Command**: class=0x00, cmd=0x82, dataSize=0x16
- **Response**: ASCII string (22 bytes)
- **Example**: "PM2550H30701767"

### Get Polling Rate
- **Command**: class=0x00, cmd=0x85, dataSize=0x01
- **Response**: [polling_code]
- **Codes**: 0x01=1000Hz, 0x02=500Hz, 0x08=125Hz

### Set Polling Rate
- **Command**: class=0x00, cmd=0x05, dataSize=0x01
- **Arguments**: [polling_code]
- **Codes**: 0x01=1000Hz, 0x02=500Hz, 0x08=125Hz

---

## Class 0x04 - DPI

### Get DPI Stages
- **Command**: class=0x04, cmd=0x86, dataSize=0x50
- **Arguments**: [profileId=0x01]
- **Response**: DPI stage data

### Set DPI Stages
- **Command**: class=0x04, cmd=0x06, dataSize=0x50
- **Arguments**: DPI stage data

### DPI Range
- **Min**: 100
- **Max**: 35000

---

## Class 0x07 - Battery & Power

### Get Battery Level
- **Command**: class=0x07, cmd=0x80, dataSize=0x02
- **Response**: [profileId, level]
- **Level**: 0x00-0xff (0-255), convert to percent: level * 100 / 255

### Get Charging Status
- **Command**: class=0x07, cmd=0x84, dataSize=0x02
- **Response**: [profileId, status]
- **Status**: 0x00=not charging, 0x01=charging

### Get Sleep Time
- **Command**: class=0x07, cmd=0x83, dataSize=0x02
- **Response**: [high_byte, low_byte]
- **Value**: (high << 8) | low = seconds
- **Example**: [0x01, 0x2c] = 300 seconds = 5 minutes

### Get Low Battery Threshold
- **Command**: class=0x07, cmd=0x81, dataSize=0x01
- **Response**: [raw_value]
- **Formula**: percent = floor(raw / 255 * 100)
- **Max**: 100%
- **Example**: raw=128 → percent = floor(128/255*100) = floor(50.19) = 50%

### Set Low Battery Threshold
- **Command**: class=0x07, cmd=0x01, dataSize=0x01
- **Arguments**: [raw_value]
- **Formula**: raw = ceil(percent / 100 * 255)
- **Max**: 100% (raw=255)
- **Example**: 15% → raw = ceil(15/100*255) = ceil(38.25) = 39

---

## Class 0x0b - Sensor Features

### Get Dynamic Sensitivity State
- **Command**: class=0x0b, cmd=0x90, dataSize=0x02
- **Arguments**: [profileId=0x01]
- **Response**: [profileId, enabled]
- **Enabled**: 0x00=off, 0x01=on

### Set Dynamic Sensitivity State
- **Command**: class=0x0b, cmd=0x10, dataSize=0x02
- **Arguments**: [profileId=0x01, enabled]
- **Enabled**: 0x00=off, 0x01=on

### Get Dynamic Sensitivity Mode
- **Command**: class=0x0b, cmd=0x91, dataSize=0x02
- **Arguments**: [profileId=0x01]
- **Response**: [profileId, mode]
- **Mode**: 0x00=classic, 0x01=natural, 0x02=jump

### Set Dynamic Sensitivity Mode
- **Command**: class=0x0b, cmd=0x11, dataSize=0x02
- **Arguments**: [profileId=0x01, mode]
- **Mode**: 0x00=classic, 0x01=natural, 0x02=jump

### Get Sensor Angle
- **Command**: class=0x0b, cmd=0x94, dataSize=0x03
- **Arguments**: [profileId=0x01]
- **Response**: [profileId, ???, angle]
- **Angle**: signed int8, range -44 to +44 degrees
- **Note**: arguments[2] = angle value

### Set Sensor Angle
- **Command**: class=0x0b, cmd=0x14, dataSize=0x03
- **Arguments**: [profileId=0x01, state=0x01, angle]
- **Angle**: signed int8, range -44 to +44 degrees
- **Convert**: raw = angle < 0 ? (0x100 + angle) & 0xff : angle & 0xff

### Get Smart Tracking Lift Setting
- **Command**: class=0x0b, cmd=0x8b, dataSize=0x04
- **Arguments**: [classId=0x00, sensorId=0x04]
- **Response**: [classId, sensorId, modeSel, trackingDistance]
- **modeSel**: 0x01=symmetric, 0x04=asymmetric
- **trackingDistance**: level value (0=high, 1=low, 2=medium)

### Set Smart Tracking Lift Setting
- **Command**: class=0x0b, cmd=0x0b, dataSize=0x04
- **Arguments**: [classId=0x00, sensorId=0x04, liftMode, liftHeight]
- **liftMode**: 0x01=symmetric, 0x04=asymmetric

### Get Smart Tracking Configuration
- **Command**: class=0x0b, cmd=0x85, dataSize=0x0a
- **Arguments**: [classId=0x00, sensorId=0x04]
- **Response**: [classId, sensorId, ???, liftOffRaw, landingRaw, ...]
- **liftOff distance**: liftOffRaw + 1
- **landing distance**: landingRaw + 1

---

## Class 0x02 - Button Mapping

### Get Button Mapping (REP4)
- **Command**: class=0x02, cmd=0x8c, dataSize=0x0a
- **Arguments**: [0x01, sourceCode_low, sourceCode_high, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

### Source Codes
| Slot | Button | Source Code |
|------|--------|-------------|
| 1 | Left Click | 0x0001 |
| 2 | Right Click | 0x0002 |
| 3 | Middle Click | 0x0003 |
| 4 | Side Forward | 0x0005 |
| 5 | Side Back | 0x0004 |
| 6 | Bottom Button | 0x0060 |

### Response Format
```
args[0] = 0x01 (header)
args[1] = sourceCode low byte
args[2] = 0x01 (profileId, NOT sourceCode high byte)
args[3] = quadlet byte 0
args[4] = quadlet byte 1
args[5] = quadlet byte 2
args[6] = quadlet byte 3
```

### Quadlet Mapping
| Quadlet | Action |
|---------|--------|
| [01,01,01,00] | Left Click (1:0) |
| [01,01,02,00] | Right Click (2:0) |
| [01,01,03,00] | Middle Click (4:0) |
| [01,01,05,00] | Back (8:0) |
| [01,01,04,00] | Forward (16:0) |
| [01,01,00,00] | Disabled (7:0) |
| [01,06,06,00] | DPI Cycle (32:5) |
| [0b,01,01,00] | DPI Clutch (1:6) |
| [01,01,09,00] | Scroll Up (1:9) |
| [01,01,0a,00] | Scroll Down (1:10) |

---

## V3 PRO vs V3 PRO SE Differences

| Feature | V3 PRO | V3 PRO SE |
|---------|--------|-----------|
| DPI Max | 45000 | 35000 |
| Polling Rate Write | cmd=0x05 | cmd=0x05 |
| Dynamic Sensitivity Read | cmd=0x90/0x91 | cmd=0x90/0x91 |
| Sensor Angle Read | cmd=0x94 | cmd=0x94 |
| Low Battery Threshold | floor(raw/255*100) | floor(raw/255*100) |
| Low Battery Write | ceil(percent/100*255) | ceil(percent/100*255) |
| Smart Tracking | Supported | Supported |
| Button Mapping | REP4 | REP4 (args[2]=profileId) |
| HyperPolling | Supported (wireless) | Not Supported |

---

## Notes

1. **Button Mapping Response**: V3 PRO SE returns args[2]=0x01 (profileId) instead of sourceCode high byte. The validator must accept this format.

2. **Smart Tracking Config**: The `parseOfficialProximitySensorConfiguration` function uses `dataSize >= 5` to detect the classId/sensorId echo. This threshold is safe — Razer's official `Proximity Sensor Configuration` command uses dataSize=10, so `>=5` correctly handles it without affecting other devices.

3. **Low Battery Threshold**: Confirmed via Razer Synapse desktop reverse engineering (RazerAppEngine 4.0.683 `6120.pretty.js` module 55052):
   - Read formula: `percent = floor(raw / 255 * 100)`
   - Write formula: `raw = ceil(percent / 100 * 255)`
   - Max: 100% (raw=255)

4. **Sleep Time**: V3 PRO SE uses class=0x07, cmd=0x83 for sleep time (not idle time). The response is [high_byte, low_byte] in seconds. Confirmed — Razer calls this "Time to Sleep Mode on Battery Mode".

5. **No HyperPolling**: V3 PRO SE does not support HyperPolling Wireless Dongle mode. Polling rates are limited to 125/500/1000Hz.

6. **Button Mapping Read**: `skipDeviceRead` logic is modified for V3 PRO SE to read button mappings on connect. This does not affect other legacy V3 devices — the condition is guarded by `isViperV3ProSe`.
