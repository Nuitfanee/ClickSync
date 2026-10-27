// Allowlisted Viper V3 Pro configuration/status commands through Windows HID.
// Packet layout: OpenRazer razer_report; native access approach also documented
// by https://github.com/damianyoko/viper-tray (no code copied).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class RazerBatteryReader {
    [StructLayout(LayoutKind.Sequential)]
    struct InterfaceData { public int Size; public Guid ClassGuid; public int Flags; public IntPtr Reserved; }
    [StructLayout(LayoutKind.Sequential)]
    struct Attributes { public int Size; public ushort VendorId, ProductId, Version; }
    [StructLayout(LayoutKind.Sequential)]
    struct Caps {
        public ushort Usage, UsagePage, InputLength, OutputLength, FeatureLength;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=17)] public ushort[] Reserved;
        public ushort LinkNodes, InputButtons, InputValues, InputIndices, OutputButtons,
            OutputValues, OutputIndices, FeatureButtons, FeatureValues, FeatureIndices;
    }
    public class Result {
        public bool ok;
        public int productId;
        public int batteryPercent = -1;
        public bool? batteryIsCharging;
        public string source = "windows-hid";
        public string error;
        public byte[] response;
        public List<string> attempts = new List<string>();
    }
    [DllImport("hid.dll")] static extern void HidD_GetHidGuid(out Guid guid);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr SetupDiGetClassDevs(ref Guid guid, IntPtr enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr info, ref Guid guid, uint index, ref InterfaceData data);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr set, ref InterfaceData data, IntPtr detail, uint size, out uint required, IntPtr info);
    [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_GetAttributes(SafeFileHandle h, ref Attributes attributes);
    [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr data);
    [DllImport("hid.dll")] static extern bool HidD_FreePreparsedData(IntPtr data);
    [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr data, ref Caps caps);
    [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_SetFeature(SafeFileHandle h, byte[] buffer, int length);
    [DllImport("hid.dll", SetLastError=true)] static extern bool HidD_GetFeature(SafeFileHandle h, byte[] buffer, int length);

    public static void ValidatePacket(byte[] packet) {
        if (packet==null || packet.Length!=90 || packet[0]!=0 || packet[2]!=0 || packet[3]!=0
            || packet[4]!=0 || packet[5]>80 || packet[89]!=0
            || (packet[1]!=0x1f && packet[1]!=0xff)) throw new ArgumentException("Invalid Razer packet");
        byte crc=0; for (int i=2;i<88;i++) crc^=packet[i];
        if (crc!=packet[88]) throw new ArgumentException("Invalid packet checksum");
        string key=packet[6].ToString("x2")+packet[7].ToString("x2");
        string[] allowed={"0081","0082","0085","00c0","0005","0040",
            "0485","0486","0405","0406","0780","0784","0783","0781","0790",
            "0703","0701","0710","0b90","0b91","0b94","0b85","0b8b",
            "0b10","0b11","0b14","0b03","0b05","0b0b","028c","020c"};
        if (Array.IndexOf(allowed,key)<0) throw new ArgumentException("Command not allowlisted: "+key);
    }

    static byte[] Query(SafeFileHandle handle, byte command) {
        if (command != 0x80 && command != 0x84) throw new ArgumentException("Read command required");
        byte[] request = new byte[91];
        request[2] = 0x1f; request[6] = 2; request[7] = 7; request[8] = command;
        for (int i=3; i<=88; i++) request[89] ^= request[i];
        return ExchangeOnHandle(handle,request);
    }

    static byte[] ExchangeOnHandle(SafeFileHandle handle, byte[] request) {
        for (int attempt=0; attempt<3; attempt++) {
            if (!HidD_SetFeature(handle, request, request.Length))
                throw new InvalidOperationException("SetFeature Win32=" + Marshal.GetLastWin32Error());
            Thread.Sleep(80);
            byte[] response = new byte[91];
            if (!HidD_GetFeature(handle, response, response.Length))
                throw new InvalidOperationException("GetFeature Win32=" + Marshal.GetLastWin32Error());
            byte crc = 0;
            for (int i=3; i<=88; i++) crc ^= response[i];
            if (response[0]!=0 || response[2]!=request[2] || response[7]!=request[7] || response[8]!=request[8] || response[6]>80 || response[89]!=crc)
                throw new InvalidOperationException("Response validation failed for command " + request[8]);
            if (response[1]==2) return response;
            if (response[1]!=1) throw new InvalidOperationException("Device status=" + response[1]);
            Thread.Sleep(80);
        }
        throw new InvalidOperationException("Device busy");
    }

    public static Result Read(int productId) {
        return ReadCore(productId,null);
    }
    public static Result Exchange(int productId, string base64) {
        byte[] packet=Convert.FromBase64String(base64);
        ValidatePacket(packet);
        byte[] request=new byte[91]; Array.Copy(packet,0,request,1,90);
        return ReadCore(productId,request);
    }

    static Result ReadCore(int productId, byte[] request) {
        if (productId!=0x00c0 && productId!=0x00c1) throw new ArgumentException("Only Viper V3 Pro is supported");
        Result result = new Result(); result.productId = productId;
        Guid guid; HidD_GetHidGuid(out guid);
        IntPtr set = SetupDiGetClassDevs(ref guid, IntPtr.Zero, IntPtr.Zero, 0x12);
        if (set==new IntPtr(-1)) { result.error="HID enumeration failed: " + Marshal.GetLastWin32Error(); return result; }
        try {
            for (uint i=0; ; i++) {
                InterfaceData data = new InterfaceData(); data.Size=Marshal.SizeOf(typeof(InterfaceData));
                if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref guid, i, ref data)) {
                    int error=Marshal.GetLastWin32Error();
                    if (error!=259) result.attempts.Add("Enumerate Win32=" + error);
                    break;
                }
                uint required;
                SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out required, IntPtr.Zero);
                if (required<8) continue;
                IntPtr detail=Marshal.AllocHGlobal((int)required);
                try {
                    Marshal.WriteInt32(detail, IntPtr.Size==8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetail(set, ref data, detail, required, out required, IntPtr.Zero)) continue;
                    string devicePath=Marshal.PtrToStringUni(IntPtr.Add(detail,4));
                    string lower=devicePath.ToLowerInvariant();
                    if (!lower.Contains("vid_1532&pid_" + productId.ToString("x4"))) continue;
                    using (SafeFileHandle handle=CreateFile(devicePath,0,3,IntPtr.Zero,3,0,IntPtr.Zero)) {
                        if (handle.IsInvalid) { result.attempts.Add("Open Win32=" + Marshal.GetLastWin32Error()); continue; }
                        Attributes attr=new Attributes(); attr.Size=Marshal.SizeOf(typeof(Attributes));
                        if (!HidD_GetAttributes(handle,ref attr) || attr.VendorId!=0x1532 || attr.ProductId!=productId) continue;
                        IntPtr preparsed;
                        if (!HidD_GetPreparsedData(handle,out preparsed)) continue;
                        Caps caps=new Caps(); caps.Reserved=new ushort[17];
                        int status;
                        try { status=HidP_GetCaps(preparsed,ref caps); }
                        finally { HidD_FreePreparsedData(preparsed); }
                        if (status!=0x00110000 || caps.UsagePage!=1 || caps.Usage!=2) continue;
                        try {
                            if (request!=null) {
                                byte[] raw=ExchangeOnHandle(handle,request);
                                result.response=new byte[90]; Array.Copy(raw,1,result.response,0,90);
                                result.ok=true; return result;
                            }
                            byte[] response=Query(handle,0x80);
                            result.batteryPercent=(int)Math.Round(response[10]*100.0/255);
                            result.ok=true;
                            try { result.batteryIsCharging=Query(handle,0x84)[10]!=0; }
                            catch (Exception ex) { result.attempts.Add("Charging: " + ex.Message); }
                            return result;
                        } catch (Exception ex) { result.attempts.Add(ex.Message); }
                    }
                } finally { Marshal.FreeHGlobal(detail); }
            }
        } finally { SetupDiDestroyDeviceInfoList(set); }
        result.error="No readable Viper V3 Pro mouse control interface; close Synapse and reconnect the receiver";
        return result;
    }
}
