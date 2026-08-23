// ── Terminal state ─────────────────────────────────────────────────────────────
let ws,term,fit,ro,reconnTimer,reconnDelay,activeId,activeTitle,leaving=false;

// ── Terminals ─────────────────────────────────────────────────────────────────

function s(d){if(ws&&ws.readyState===1)ws.send(d)}

function sendInp(){
  const inp=document.getElementById('inp');
  s(inp.value+'\r');inp.value='';inp.focus();
}

document.getElementById('inp').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();sendInp()}
});

async function load(){
  const el=document.getElementById('list');
  try{
    const r=await fetch('/api/terminals'+q);
    if(!r.ok){el.innerHTML='<div class="empty err-msg">Token inválido.</div>';return}
    const ts=await r.json();
    if(!ts.length){el.innerHTML='<div class="empty">No hay terminales abiertos.<br>Abre un agente o terminal en Bento.</div>';return}
    el.innerHTML='<div class="list-head">Terminales activos</div>';
    ts.forEach(t=>{
      const b=document.createElement('button');
      b.className='tb';
      const sub=t.branch?'⎷ '+t.branch+(t.cwd?' · '+t.cwd:''):t.cwd||'';
      b.innerHTML='<span class="tb-ico">&#11035;</span><div class="tb-info"><div class="tb-name">'+esc(t.title||t.id)+'</div><div class="tb-cwd">'+esc(sub)+'</div></div><span class="tb-arrow">&#8250;</span>';
      b.onclick=()=>attach(t.id,t.title||t.id);
      el.appendChild(b);
    });
  }catch(e){el.innerHTML='<div class="empty err-msg">No se pudo conectar al daemon.</div>'}
}

function sendResize(){
  if(ws&&ws.readyState===1&&term)
    ws.send(JSON.stringify({type:'resize',rows:term.rows,cols:term.cols}));
}

function connect(id){
  if(leaving)return;
  const dot=document.getElementById('dot');
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws/'+id+q);
  ws.onopen=()=>{dot.className='';reconnDelay=1000;sendResize()};
  ws.onmessage=e=>{
    if(typeof e.data==='string'){
      try{
        const msg=JSON.parse(e.data);
        if(msg.type==='title'){activeTitle=msg.value;document.getElementById('ttitle').textContent=msg.value;return}
        if(msg.type==='exit'){goBack();return}
      }catch(_){}
      term&&term.write(e.data);
    }else{term&&term.write(new Uint8Array(e.data))}
  };
  ws.onclose=()=>{
    if(leaving)return;
    dot.className='off';
    term&&term.write('\r\n\x1b[33m[reconectando en '+(reconnDelay/1000)+'s…]\x1b[0m\r\n');
    reconnTimer=setTimeout(()=>connect(id),reconnDelay);
    reconnDelay=Math.min(reconnDelay*2,16000);
  };
}

// En móvil no existe el evento `wheel`, único que xterm traduce, así que el dedo
// no movía nada. No reimplementamos el scroll: xterm ya decide bien según el caso
// (scrollback normal, flechas en alt-screen respetando applicationCursorKeys, o
// eventos SGR si la TUI captura el ratón), y acumula el desplazamiento parcial.
// Basta con sintetizar el wheel que el navegador no emite.
function enableTouchScroll(el){
  let lastY=null;
  el.addEventListener('touchstart',e=>{
    if(e.touches.length!==1)return;
    lastY=e.touches[0].clientY;
  },{passive:true});
  el.addEventListener('touchmove',e=>{
    const isTrackingOneFinger=lastY!==null&&e.touches.length===1;
    if(!isTrackingOneFinger||!term||!term.element)return;
    const t=e.touches[0];
    // Dedo hacia arriba (y decrece) = deltaY positivo = scroll hacia abajo.
    const deltaY=lastY-t.clientY;
    lastY=t.clientY;
    if(!deltaY)return;
    // Se despacha en el nodo más interno para que alcance a todos sus ancestros:
    // el listener de xterm cuelga del contenedor y los eventos solo burbujean.
    const target=term.element.querySelector('.xterm-screen')||term.element;
    target.dispatchEvent(new WheelEvent('wheel',{
      deltaY,deltaMode:0,bubbles:true,cancelable:true,
      clientX:t.clientX,clientY:t.clientY,
    }));
    e.preventDefault();
  },{passive:false});
  const stop=()=>{lastY=null};
  el.addEventListener('touchend',stop,{passive:true});
  el.addEventListener('touchcancel',stop,{passive:true});
}

function attach(id,title){
  leaving=false;activeId=id;activeTitle=title;reconnDelay=1000;
  document.getElementById('page-terminals').style.display='none';
  document.getElementById('tabbar').style.display='none';
  const viewEl=document.getElementById('view');
  viewEl.style.display='flex';
  document.getElementById('ttitle').textContent=title;
  document.getElementById('dot').className='off';

  const con=document.getElementById('tcon');
  con.innerHTML='';
  term=new Terminal({fontSize:13,fontFamily:'Menlo,Monaco,"Cascadia Code",monospace',theme:{background:'#000000',foreground:'#e2e8f8',cursor:'#a78bfa',selectionBackground:'#3a3a5c'},convertEol:false,cursorBlink:true,scrollback:2000});
  fit=new FitAddon.FitAddon();
  term.loadAddon(fit);term.open(con);fit.fit();
  enableTouchScroll(con);
  term.onData(d=>s(d));
  ro=new ResizeObserver(()=>{if(fit){fit.fit();sendResize()}});
  ro.observe(con);
  connect(id);
}

function goBack(){
  leaving=true;clearTimeout(reconnTimer);
  if(ro){ro.disconnect();ro=null}
  if(ws){ws.close();ws=null}
  if(term){term.dispose();term=null}
  document.getElementById('view').style.display='none';
  document.getElementById('tabbar').style.display='flex';
  document.getElementById('page-terminals').style.display='flex';
  const nb=document.getElementById('newbtn');
  nb.textContent='+ Nueva terminal';nb.disabled=false;
  load();
}

async function killTerminal(){
  if(!activeId)return;
  if(!confirm('&#191;Cerrar "'+activeTitle+'"?'))return;
  try{await fetch('/api/terminals/'+encodeURIComponent(activeId)+q,{method:'DELETE'})}catch(_){}
  goBack();
}

async function newTerminal(){
  const btn=document.getElementById('newbtn');
  btn.textContent='Abriendo…';btn.disabled=true;
  try{
    const r=await fetch('/api/terminals'+q,{method:'POST'});
    if(!r.ok){btn.textContent='+ Nueva terminal';btn.disabled=false;return}
    const {id}=await r.json();
    await load();attach(id,id);
  }catch(e){btn.textContent='+ Nueva terminal';btn.disabled=false}
}

// ── Init ───────────────────────────────────────────────────────────────────────
load();
setInterval(()=>{
  if(document.getElementById('page-terminals').style.display!=='none') load();
},3000);
