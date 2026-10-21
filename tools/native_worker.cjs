const {spawn}=require('node:child_process');
const path=require('node:path');
const readline=require('node:readline');

// Compile once per local-server lifetime, not once per HID command. Device
// handles are still opened/disposed within each query by the C# helper.
function createNativeWorker(){
  let worker=null,pending=null;
  function stop(error){
    const child=worker;worker=null;
    if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}
    if(child)child.kill();
  }
  function start(){
    const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); try { Add-Type -Path $env:CLICKSYNC_NATIVE_SOURCE } catch { [Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress)); exit 1 }; while ($null -ne ($nativeLine=[Console]::ReadLine())) { try { $nativeRequest=$nativeLine|ConvertFrom-Json; if ($nativeRequest.packet) { $nativeResult=[RazerBatteryReader]::Exchange([int]$nativeRequest.productId,[string]$nativeRequest.packet) } else { $nativeResult=[RazerBatteryReader]::Read([int]$nativeRequest.productId) }; [Console]::Out.WriteLine(($nativeResult|ConvertTo-Json -Depth 6 -Compress)) } catch { [Console]::Out.WriteLine((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress)) } }";
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],
      env:{...process.env, CLICKSYNC_NATIVE_SOURCE:path.join(__dirname,'RazerBatteryReader.cs')},
    });
    worker=child;let stderr='';
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(worker!==child||!pending)return;
      const current=pending;pending=null;clearTimeout(current.timer);
      try{const result=JSON.parse(line.replace(/^\uFEFF/,''));if(!result.ok)throw new Error(JSON.stringify(result));current.resolve(result);}
      catch(error){current.reject(error);}
    });
    child.on('error',error=>{if(worker===child)stop(error);});
    child.on('close',code=>{lines.close();if(worker===child)stop(new Error(`Native worker exited (${code}): ${stderr}`));});
    child.stdin.on('error',error=>{if(worker===child)stop(error);});
  }
  process.once('exit',()=>{if(worker)worker.kill();});
  return {
    request(productId,packet){
      if(pending)return Promise.reject(new Error('Native worker is busy'));
      if(!worker)start();
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>stop(new Error('Native worker timeout')),12000);
        pending={resolve,reject,timer};
        worker.stdin.write(JSON.stringify({productId,packet:packet?Buffer.from(packet).toString('base64'):null})+'\n');
      });
    },
    close(){stop(new Error('Native worker closed'));},
  };
}
module.exports={createNativeWorker};
