// Elegir agentes, correr y parar la review, y la lista de archivos cambiados.
let reviewTimer=null;

// El documento que manda el motor, si esta línea es esa. El marcador solo
// cuenta al principio del trozo: el informe puede mencionarlo.
function reviewDocumentFrom(data){
  const marker='[DOCUMENT]\n';
  return (typeof data==='string'&&data.startsWith(marker))?data.slice(marker.length):null;
}

function toggleProgressStream(){
  const s=document.getElementById('rv-progress-stream');
  const t=document.getElementById('rv-progress-toggle');
  const collapsed=s.classList.toggle('collapsed');
  t.textContent=collapsed?'▶':'▼';
}

// La lista de agentes la sirve el daemon en /agents.js, generada desde
// `bento_review::agents`: aquí estaba escrita otra vez, y en el HTML tres más.
const AGENTS=window.BENTO_AGENTS||[];

const AGENT_TYPES=AGENTS.map(a=>a.id);

function agentLabel(a){const found=AGENTS.find(x=>x.id===a);return found?found.label:a;}

// Rellena los tres selectores; los opcionales conservan su "Ninguno".
function fillAgentSelects(){
  for(const id of ['rv-agent','rv-agent-secondary','rv-agent-tertiary']){
    const select=document.getElementById(id);
    if(!select)continue;
    for(const agent of AGENTS){
      const option=document.createElement('option');
      option.value=agent.id;
      option.textContent=agent.label;
      select.appendChild(option);
    }
  }
}

fillAgentSelects();

function selectedAgents(){
  const primary=document.getElementById('rv-agent').value||'claude';
  const toggle=document.getElementById('rv-compare-toggle').checked;
  if(!toggle)return[primary];
  const sec=document.getElementById('rv-agent-secondary').value;
  const ter=document.getElementById('rv-agent-tertiary').value;
  const extras=[sec,ter].filter(v=>AGENT_TYPES.includes(v));
  return[primary,...extras];
}

function normalizeAgentSelects(){
  const primary=document.getElementById('rv-agent').value||'claude';
  const sec=document.getElementById('rv-agent-secondary');
  const ter=document.getElementById('rv-agent-tertiary');
  if(!sec.value)sec.value=primary;
  if(!ter.value)ter.value=primary;
}

function syncAgentUi(){
  const toggle=document.getElementById('rv-compare-toggle').checked;
  document.getElementById('rv-agent-secondary-row').classList.toggle('hidden',!toggle);
  document.getElementById('rv-agent-tertiary-row').classList.toggle('hidden',!toggle);
  if(toggle)normalizeAgentSelects();
  localStorage.setItem('bento.review.agent',document.getElementById('rv-agent').value);
  localStorage.setItem('bento.review.compare-agents',toggle?'1':'0');
  const sec=document.getElementById('rv-agent-secondary').value;
  const ter=document.getElementById('rv-agent-tertiary').value;
  if(sec)localStorage.setItem('bento.review.agent.secondary',sec);
  else localStorage.removeItem('bento.review.agent.secondary');
  if(ter)localStorage.setItem('bento.review.agent.tertiary',ter);
  else localStorage.removeItem('bento.review.agent.tertiary');
  const agents=selectedAgents().map(agentLabel);
  const badge=document.getElementById('rv-agent-badge');
  badge.textContent=agents.length===1?'Agente: '+agents[0]:'Agentes: '+agents.join(' + ');
  badge.style.display='block';
}

function initAgentUi(){
  const primary=localStorage.getItem('bento.review.agent')||'claude';
  const compare=localStorage.getItem('bento.review.compare-agents')==='1';
  const sec=localStorage.getItem('bento.review.agent.secondary')||'';
  const ter=localStorage.getItem('bento.review.agent.tertiary')||'';
  const agentEl=document.getElementById('rv-agent');
  const compareEl=document.getElementById('rv-compare-toggle');
  const secEl=document.getElementById('rv-agent-secondary');
  const terEl=document.getElementById('rv-agent-tertiary');
  if(agentEl&&AGENT_TYPES.includes(primary))agentEl.value=primary;
  if(compareEl)compareEl.checked=compare;
  if(secEl&&AGENT_TYPES.includes(sec))secEl.value=sec;
  if(terEl&&AGENT_TYPES.includes(ter))terEl.value=ter;
  syncAgentUi();
}

function stopReview(){
  if(reviewSse){reviewSse.close();reviewSse=null;}
  if(reviewTimer){clearInterval(reviewTimer);reviewTimer=null;}
  const btn=document.getElementById('rv-start');
  const stopBtn=document.getElementById('rv-stop');
  document.getElementById('rv-progress').style.display='none';
  btn.disabled=false;btn.textContent='Iniciar revisión';
  stopBtn.style.display='none';
}

function startReview(){
  const dir=cwd();
  const base=document.getElementById('rv-base').value.trim()||'main';
  const branch=(document.getElementById('rv-branch').value||'').trim();
  const context=document.getElementById('rv-context').value.trim();
  const agents=selectedAgents();
  if(!dir)return;

  if(reviewSse){reviewSse.close();reviewSse=null;}
  if(reviewTimer){clearInterval(reviewTimer);reviewTimer=null;}

  const out=document.getElementById('rv-output');
  const progress=document.getElementById('rv-progress');
  const progressStatus=document.getElementById('rv-progress-status');
  const progressMeta=document.getElementById('rv-progress-meta');
  const progressStream=document.getElementById('rv-progress-stream');
  const btn=document.getElementById('rv-start');
  const stopBtn=document.getElementById('rv-stop');

  hideChat();
  reviewSessionId=null;
  reviewRunId=String(Date.now());
  reviewSessionAgent=null;
  out.className='empty-state';
  out.innerHTML='<div class="rv-placeholder">Esperando síntesis&#8230;</div>';
  progressStatus.textContent='Iniciando&#8230;';
  progressMeta.textContent='0s';
  progressStream.textContent='';
  progressStream.classList.remove('collapsed');
  document.getElementById('rv-progress-toggle').textContent='▼';
  progress.style.display='block';
  btn.disabled=true;
  btn.innerHTML='<span class="spinner"></span> Analizando&#8230;';
  stopBtn.style.display='block';

  // finalBuf = synthesis output (or single batch if no synthesis)
  let finalBuf='';
  // batchBuf = live text for current batch (shown in progress stream)
  let batchBuf='';
  let hasSynthesis=false;
  // agentReports keeps each completed batch so we can fall back if synthesis fails
  let agentReports=[];
  // Si llega el documento del motor, es lo que se guarda: lo de aquí es el
  // apaño para un daemon viejo que todavía no lo manda.
  let hasDocument=false;
  let startedAt=Date.now();

  reviewTimer=setInterval(()=>{
    const secs=Math.floor((Date.now()-startedAt)/1000);
    progressMeta.textContent=secs+'s';
  },500);

  const endReview=()=>{
    if(reviewTimer){clearInterval(reviewTimer);reviewTimer=null;}
    progress.style.display='none';
    btn.disabled=false;btn.textContent='Iniciar revisión';
    stopBtn.style.display='none';
  };

  let url='/api/review'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)+'&agents='+encodeURIComponent(agents.join(','));
  if(branch)url+='&branch='+encodeURIComponent(branch);
  if(context)url+='&context='+encodeURIComponent(context);
  reviewSse=new EventSource(url);

  reviewSse.onmessage=e=>{
    let data;try{data=JSON.parse(e.data);}catch(_){data=e.data;}

    // El documento entero, montado por el motor: cabecera, el informe de cada
    // agente y la verificación. Sustituye a lo que fuéramos acumulando aquí,
    // que era la versión de este cliente de la misma review.
    const document_=reviewDocumentFrom(data);
    if(document_!==null){
      finalBuf=document_;
      hasDocument=true;
      out.className='rv-md';
      out.innerHTML=mdToHtml(finalBuf);
      // Se guarda aquí y no en [DONE]: una review que se cayó también trae
      // documento, y para esa no hay [DONE].
      saveReviewCheckpoint(dir,base,finalBuf);
      return;
    }

    if(data==='[DONE]'){
      reviewSse.close();reviewSse=null;
      if(batchBuf.trim())agentReports.push(batchBuf);
      if(!hasSynthesis&&!hasDocument){
        finalBuf=agentReports[agentReports.length-1]||batchBuf;
        out.className='rv-md';
        out.innerHTML=mdToHtml(finalBuf);
      }
      if(!hasDocument)saveReviewCheckpoint(dir,base,finalBuf);
      showChat();
      endReview();
      return;
    }

    if(data.startsWith('[ERROR]')){
      out.className='rv-md';
      out.innerHTML='<p class="err-msg">'+esc(data.slice(7).trim())+'</p>';
      reviewSse.close();reviewSse=null;
      endReview();
      return;
    }

    const sessionMatch=data.match(/^\[SESSION:([^:]+):(.+)\]$/);
    if(sessionMatch){
      reviewSessionAgent=sessionMatch[1];
      reviewSessionId=sessionMatch[2];
      return;
    }

    // Las herramientas son progreso: se ven en la cabecera, no en el informe.
    if(data.startsWith('[TOOL] ')){
      progressStatus.textContent=data.slice(7).slice(0,120);
      return;
    }

    const batchMatch=data.match(/^\[BATCH:(\d+)\/(\d+)(?::([^\]]+))?\]$/);
    if(batchMatch){
      const n=parseInt(batchMatch[1]),total=parseInt(batchMatch[2]);
      if(batchBuf.trim()){agentReports.push(batchBuf);saveReviewCheckpoint(dir,base,batchBuf);}
      batchBuf='';
      startedAt=Date.now();
      const isMulti=agents.length>1;
      const label=isMulti
        ?(agentLabel(agents[n-1]||agents[0])+' · '+n+'/'+total)
        :('Batch '+n+'/'+total);
      progressStatus.textContent=label;
      progressStream.textContent='';
      return;
    }

    if(data==='[SYNTHESIS]'){
      if(batchBuf.trim()){agentReports.push(batchBuf);saveReviewCheckpoint(dir,base,batchBuf);}
      batchBuf='';
      hasSynthesis=true;
      startedAt=Date.now();
      progressStatus.textContent='Síntesis final&#8230;';
      out.className='rv-md';
      out.innerHTML='';
      return;
    }

    if(hasSynthesis){
      // Synthesis streams into the main output
      finalBuf+=data;
      appendPinned(out,()=>{out.innerHTML=mdToHtml(finalBuf);});
    } else {
      // Batch streams into the progress area (live detail)
      batchBuf+=data;
      appendPinned(progressStream,()=>{progressStream.textContent=batchBuf;});
    }
  };

  reviewSse.onerror=()=>{
    reviewSse.close();reviewSse=null;
    if(!finalBuf&&!batchBuf)out.innerHTML='<p class="err-msg">Error de conexión.</p>';
    endReview();
  };
}

// Los ficheros ya revisados de la rama que se está mirando, y el filtro por
// estado. Las marcas viven en el almacén compartido con el escritorio y la CLI,
// así que marcar aquí y seguir allí es lo mismo.
let reviewViewed=[];
let fileFilter='all';
// Por carpetas o la lista plana, como el árbol del escritorio y del cli.
let fileTree=false;
// La última lista cargada: buscar y cambiar de filtro trabajan sobre ella.
let reviewFiles=[];

function isViewed(path){return reviewViewed.includes(path)}

// Mismo criterio que `FileFilter` en la TUI y que los chips del escritorio:
// A añadido, D borrado, y todo lo demás (M, R…) modificado.
function matchesFileFilter(status,filter){
  if(filter==='all')return true;
  if(filter==='added')return status==='A';
  if(filter==='deleted')return status==='D';
  return status!=='A'&&status!=='D';
}

function setFileFilter(filter){
  fileFilter=filter;
  for(const btn of document.querySelectorAll('#rv-files-filter .chip'))
    btn.classList.toggle('active',btn.dataset.filter===filter);
  // Sin volver a pedir la lista: es la misma, sólo se enseña otra parte.
  renderFiles();
}

// Los que pasan el buscador, sea cual sea su estado. Los recuentos de los
// chips se cuentan sobre esto para que cuadren con la lista de debajo.
function searchedFiles(){
  const needle=(document.getElementById('rv-files-search')?.value||'').trim().toLowerCase();
  if(!needle)return reviewFiles;
  return reviewFiles.filter(f=>(f.path||'').toLowerCase().includes(needle));
}

// Por carpetas, con la misma regla que el árbol del cli: la carpeta es todo
// lo que va antes de la última barra, ordenadas por nombre, y lo que está en
// la raíz no lleva cabecera —sería una línea en blanco.
function groupedFiles(files){
  const dirs=[];
  for(const file of files){
    const path=file.path||'';
    const cut=path.lastIndexOf('/');
    const dir=cut<0?'':path.slice(0,cut);
    const found=dirs.find(d=>d.dir===dir);
    if(found)found.files.push(file);else dirs.push({dir,files:[file]});
  }
  dirs.sort((a,b)=>a.dir<b.dir?-1:a.dir>b.dir?1:0);
  return dirs.flatMap(({dir,files})=>[
    ...(dir?[{dir}]:[]),
    ...files.map(file=>({file})),
  ]);
}

// El nombre sin la carpeta, que ya está en su cabecera.
function leafName(path){const cut=path.lastIndexOf('/');return cut<0?path:path.slice(cut+1)}

function toggleFileTree(){
  fileTree=!fileTree;
  document.getElementById('rv-files-tree')?.classList.toggle('active',fileTree);
  renderFiles();
}

function renderFiles(){
  const el=document.getElementById('rv-files-list');
  const base=document.getElementById('rv-files-base').value.trim()||'main';
  const searched=searchedFiles();
  // Cuántos hay de cada tipo, como el escritorio: cambiar de chip a ciegas no
  // dice si no hay nada de ese estado o si el filtro se comió la lista.
  for(const btn of document.querySelectorAll('#rv-files-filter .chip')){
    const count=searched.filter(f=>matchesFileFilter(f.status||'M',btn.dataset.filter)).length;
    btn.textContent=btn.dataset.label+' '+count;
  }
  document.getElementById('rv-files-count').textContent=
    searched.filter(f=>isViewed(f.path)).length+'/'+reviewFiles.length;
  if(!reviewFiles.length){el.innerHTML='<div class="empty">Sin cambios respecto a <strong>'+esc(base)+'</strong>.</div>';return}

  const shown=searched.filter(f=>matchesFileFilter(f.status||'M',fileFilter));
  if(!shown.length){el.innerHTML='<div class="empty">Ningún fichero con ese estado.</div>';return}
  const fileRow=f=>{
    const badge=f.status||'M';
    const add=f.added>0?`<span class="stat-add">+${f.added}</span>`:'';
    const del=f.deleted>0?`<span class="stat-del"> -${f.deleted}</span>`:'';
    const path=esc(JSON.stringify(f.path));
    const mark=isViewed(f.path)?'✓':'○';
    const name=fileTree?leafName(f.path||''):(f.path||'');
    return `<div class="file-item${isViewed(f.path)?' file-viewed':''}${fileTree?' file-in-tree':''}" onclick="openFileDiff(${path},${esc(JSON.stringify(base))})">
      <span class="file-viewed-mark" onclick="toggleViewed(${path},event)">${mark}</span>
      <span class="file-badge badge-${badge}">${esc(badge)}</span>
      <span class="file-path">${esc(name)}</span>
      <span class="file-stat">${add}${del}</span>
    </div>`;
  };
  el.innerHTML=fileTree
    ? groupedFiles(shown).map(row=>row.dir!==undefined
        ? `<div class="file-dir">${esc(row.dir)}</div>`
        : fileRow(row.file)).join('')
    : shown.map(fileRow).join('');
}

async function toggleViewed(path,event){
  event.stopPropagation();
  const dir=cwd();
  const base=document.getElementById('rv-files-base').value.trim()||'main';
  reviewViewed=isViewed(path)?reviewViewed.filter(p=>p!==path):[...reviewViewed,path];
  try{
    await fetch('/api/review/viewed'+q,{
      method:'PUT',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({cwd:dir,base,paths:reviewViewed}),
    });
  }catch(_){}
  // La lista ya está en memoria: repintar en vez de volver a pedirla, que
  // recargar borraba la búsqueda escrita.
  renderFiles();
}

async function loadFiles(){
  const dir=cwd();
  const base=document.getElementById('rv-files-base').value.trim()||'main';
  if(!dir)return;

  const el=document.getElementById('rv-files-list');
  el.innerHTML='<div class="empty">Cargando&#8230;</div>';

  // Show branch indicator
  const info=document.getElementById('rv-branch-info');
  const selOpt=[...document.getElementById('rv-project').selectedOptions][0];
  const optLabel=selOpt?.textContent||'';
  const branchMatch=optLabel.match(/·\s*(.+)$/);
  const currentBranch=branchMatch?branchMatch[1].trim():'HEAD';
  document.getElementById('rv-branch-current').textContent=currentBranch;
  document.getElementById('rv-branch-base').textContent=base;
  info.style.display='flex';

  try{
    // La rama que se está revisando, si hay una: sin ella el listado son tus
    // cambios sin commitear, aunque hayas elegido rama para correr la review.
    const branch=(document.getElementById('rv-branch').value||'').trim();
    const forBranch=branch?'&branch='+encodeURIComponent(branch):'';
    const [filesRes,viewedRes]=await Promise.all([
      fetch('/api/review/files'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)+forBranch),
      fetch('/api/review/viewed'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)),
    ]);
    if(!filesRes.ok){el.innerHTML='<div class="empty err-msg">'+esc(await filesRes.text())+'</div>';info.style.display='none';return}
    reviewFiles=await filesRes.json();
    reviewViewed=viewedRes.ok?await viewedRes.json():[];
    document.getElementById('rv-files-filter').style.display='flex';
    renderFiles();
  }catch(e){el.innerHTML='<div class="empty err-msg">Error de conexión.</div>'}
}

// En una columna o en dos. Lo que se está viendo se guarda para repintarlo
// sin volver a pedir el diff al daemon.
let splitView=false,openDiff=null;

function toggleSplit(){
  splitView=!splitView;
  for(const id of ['rv-split-toggle','rv-pr-split-toggle']){
    document.getElementById(id)?.classList.toggle('active',splitView);
  }
  if(openDiff)paintDiff(openDiff.text,openDiff.path);
  if(prDiffText)paintPRDiff(prDiffText);
}

function paintDiff(text,path){
  openDiff={text,path};
  document.getElementById('rv-diff-content').innerHTML=
    splitView?renderDiffSplit(text,path):renderDiff(text,path);
}

async function openFileDiff(path, base){
  const dir=cwd();
  const overlay=document.getElementById('rv-file-view');
  document.getElementById('rv-file-title').textContent=path;
  document.getElementById('rv-diff-content').innerHTML='<span class="dl dl-ctx">Cargando&#8230;</span>';
  overlay.classList.add('on');

  try{
    const branch=(document.getElementById('rv-branch').value||'').trim();
    const r=await fetch('/api/review/file'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)
      +'&path='+encodeURIComponent(path)+(branch?'&branch='+encodeURIComponent(branch):''));
    const text=await r.text();
    if(r.ok)paintDiff(text,path);
    else{openDiff=null;document.getElementById('rv-diff-content').innerHTML=`<span class="dl dl-del">${esc(text)}</span>`}
  }catch(e){
    document.getElementById('rv-diff-content').innerHTML='<span class="dl dl-del">Error de conexión.</span>';
  }
}

function closeFileDiff(){
  document.getElementById('rv-file-view').classList.remove('on');
}
