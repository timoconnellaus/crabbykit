/**
 * Console capture script injected into the preview iframe.
 * Intercepts console.log/warn/error/info and posts messages to the parent
 * frame so the agent can read them via the get_console_logs tool.
 */
export const CONSOLE_CAPTURE_SCRIPT = `(function(){
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
