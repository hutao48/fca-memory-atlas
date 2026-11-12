// FCA Nebula Renderer — environment probe
// Verifies: Electron offscreen/onscreen WebGL2 availability, GPU renderer string,
// actual offscreen capture behavior. Run with:
//   Remove-Item Env:ELECTRON_RUN_AS_NODE
//   .cache\electron-dist\electron.exe tests\performance\nebula\probe.cjs --out artifacts\screenshots\probe.png
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.findIndex((a) => a === '--' + name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const eq = args.find((a) => a.startsWith('--' + name + '='));
  return eq ? eq.slice(name.length + 3) : def;
}
const OUT = path.resolve(ROOT, arg('out', 'artifacts/screenshots/probe.png'));
const MODE = arg('mode', 'offscreen'); // offscreen | show | show-offscreen-pos
const USE_ANGLE = arg('angle', ''); // '', d3d11, gl

if (USE_ANGLE) app.commandLine.appendSwitch('use-angle', USE_ANGLE);
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.disableHardwareAcceleration && (MODE === 'software' ? app.disableHardwareAcceleration() : null);

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#05070f;color:#cfe3ff;font:14px Consolas,monospace}
#gl{display:block}</style></head>
<body><canvas id="gl" width="480" height="320"></canvas><pre id="log"></pre>
<script>
(function(){
  const out=[];
  try{
    const c=document.getElementById('gl');
    const gl=c.getContext('webgl2',{antialias:false,alpha:false,powerPreference:'high-performance'});
    if(!gl){out.push('WEBGL2=null');}
    else{
      out.push('WEBGL2=ok');
      out.push('VERSION='+gl.getParameter(gl.VERSION));
      out.push('SHADING_LANGUAGE_VERSION='+gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
      const dbg=gl.getExtension('WEBGL_debug_renderer_info');
      out.push('UNMASKED_RENDERER='+(dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):'n/a'));
      out.push('UNMASKED_VENDOR='+(dbg?gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL):'n/a'));
      out.push('MAX_TEXTURE_SIZE='+gl.getParameter(gl.MAX_TEXTURE_SIZE));
      out.push('EXT_color_buffer_float='+!!gl.getExtension('EXT_color_buffer_float'));
      out.push('OES_texture_float_linear='+!!gl.getExtension('OES_texture_float_linear'));
      out.push('EXT_float_blend='+!!gl.getExtension('EXT_float_blend'));
      // render a test gradient with real GPU pipeline
      const vs=gl.createShader(gl.VERTEX_SHADER);gl.shaderSource(vs,'#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}');gl.compileShader(vs);
      const fs=gl.createShader(gl.FRAGMENT_SHADER);gl.shaderSource(fs,'#version 300 es\\nprecision highp float;out vec4 o;void main(){vec2 u=gl_FragCoord.xy/vec2(480.,320.);o=vec4(u.x,u.y,0.6,1.);}');gl.compileShader(fs);
      const pr=gl.createProgram();gl.attachShader(pr,vs);gl.attachShader(pr,fs);gl.linkProgram(pr);gl.useProgram(pr);
      const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
      const loc=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      gl.clearColor(0.02,0.03,0.06,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);
      const px=new Uint8Array(4);gl.readPixels(240,160,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);
      out.push('PIXEL_CENTER='+Array.from(px).join(','));
      // timing: 60 full-screen draws
      const t0=performance.now();
      for(let i=0;i<60;i++){gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,3);}
      gl.finish();const t1=performance.now();
      out.push('60_FULLSCREEN_DRAWS_MS='+(t1-t0).toFixed(2));
    }
  }catch(e){out.push('ERROR='+e.message);}
  document.getElementById('log').textContent=out.join('\\n');
  window.__probe=out.join('\\n');
  window.__probeDone=true;
})();
<\/script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 480,
    height: 400,
    show: MODE !== 'offscreen' && MODE !== 'show-offscreen-pos',
    x: MODE === 'show-offscreen-pos' ? 3000 : undefined,
    y: MODE === 'show-offscreen-pos' ? 3000 : undefined,
    webPreferences: {
      offscreen: MODE === 'offscreen' || MODE === 'show-offscreen-pos',
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (e) => {
    // Electron 38: event object with message/level props or legacy args
    const msg = e && e.message !== undefined ? e.message : arguments[1];
    console.log('[page]', msg);
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  let res = '';
  for (let i = 0; i < 100; i++) {
    try {
      res = await win.webContents.executeJavaScript('window.__probe || ""');
      if (res) break;
    } catch (err) {
      res = 'EXEC_ERR ' + err.message;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // give compositor a moment then capture
  await new Promise((r) => setTimeout(r, 400));
  let captured = false;
  try {
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, png);
    captured = png.length > 1000;
    res += '\nCAPTURE_BYTES=' + png.length + ' SAVED=' + OUT;
  } catch (err) {
    res += '\nCAPTURE_ERR=' + err.message;
  }
  console.log('===== PROBE RESULT (mode=' + MODE + ', angle=' + (USE_ANGLE || 'default') + ') =====');
  console.log(res);
  console.log('CAPTURED=' + captured);
  app.exit(0);
});
