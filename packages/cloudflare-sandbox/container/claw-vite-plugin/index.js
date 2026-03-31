/**
 * @claw-for-cloudflare/vite-plugin
 *
 * Configures Vite for the CLAW sandbox preview proxy.
 * Injects <base> tag and console capture script.
 * Outside the sandbox (no AGENT_ID), this is a no-op.
 *
 * Important: We do NOT set Vite's `base` config because the container proxy
 * strips the preview prefix before forwarding to Vite. Vite must serve from
 * "/" (its default). Instead we inject a <base href> tag so the browser
 * resolves relative URLs through the preview path.
 */

const CONSOLE_CAPTURE_SCRIPT = `(function(){
  var orig={error:console.error,warn:console.warn,log:console.log,info:console.info};
  var count=0,lastReset=Date.now();
  function throttle(){var now=Date.now();if(now-lastReset>1000){count=0;lastReset=now}return ++count<=10}
  function report(level,args){
    if(!throttle())return;
    var msg=Array.from(args).map(function(a){return typeof a==='object'?JSON.stringify(a):String(a)}).join(' ');
    try{parent.postMessage({type:'claw:console',level:level,text:msg,ts:Date.now()},'*')}catch(e){}
  }
  console.error=function(){report('error',arguments);orig.error.apply(console,arguments)};
  console.warn=function(){report('warn',arguments);orig.warn.apply(console,arguments)};
  console.log=function(){report('log',arguments);orig.log.apply(console,arguments)};
  console.info=function(){report('info',arguments);orig.info.apply(console,arguments)};
  window.addEventListener('error',function(e){report('error',[(e.message||'Error')+' at '+(e.filename||'unknown')+':'+(e.lineno||0)])});
  window.addEventListener('unhandledrejection',function(e){report('error',['Unhandled rejection: '+(e.reason&&e.reason.message||e.reason)])});
})();`;

export function clawForCloudflare(options) {
  let active = false;
  let resolvedBase = "";

  return {
    name: "claw-for-cloudflare",

    config(_userConfig, { command }) {
      if (command !== "serve") return;

      const base =
        options?.base ??
        process.env.CLAW_PREVIEW_BASE ??
        (process.env.AGENT_ID ? `/preview/${process.env.AGENT_ID}/` : null);

      if (!base) return;

      active = true;
      resolvedBase = base.endsWith("/") ? base : `${base}/`;
      const port = options?.port ?? (Number(process.env.CLAW_PREVIEW_PORT) || 3000);

      return {
        server: {
          host: true,
          port,
          strictPort: true,
        },
      };
    },

    configResolved(config) {
      if (active) {
        console.log(`[claw] Preview proxy base: ${resolvedBase}`);
        console.log(`[claw] Dev server: http://localhost:${config.server.port}`);
      }
    },

    transformIndexHtml() {
      if (!active) return [];

      const tags = [
        {
          tag: "base",
          attrs: { href: resolvedBase },
          injectTo: "head-prepend",
        },
      ];

      if (options?.consoleCapture !== false) {
        tags.push({
          tag: "script",
          children: CONSOLE_CAPTURE_SCRIPT,
          injectTo: "head-prepend",
        });
      }

      return tags;
    },
  };
}
