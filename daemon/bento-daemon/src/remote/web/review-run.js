// Elegir agentes, correr y parar la review, y la lista de archivos cambiados.
let reviewTimer=null;

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

    if(data==='[DONE]'){
      reviewSse.close();reviewSse=null;
      if(batchBuf.trim())agentReports.push(batchBuf);
      if(!hasSynthesis){
        finalBuf=agentReports[agentReports.length-1]||batchBuf;
        out.className='rv-md';
        out.innerHTML=mdToHtml(finalBuf);
      }
      saveReviewCheckpoint(dir,base,finalBuf);
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

    const batchMatch=data.match(/^\[BATCH:(\d+)\/(\d+)\]$/);
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
    const r=await fetch('/api/review/files'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base));
    if(!r.ok){el.innerHTML='<div class="empty err-msg">'+esc(await r.text())+'</div>';info.style.display='none';return}
    const files=await r.json();
    if(!files.length){el.innerHTML='<div class="empty">Sin cambios respecto a <strong>'+esc(base)+'</strong>.</div>';return}

    el.innerHTML=files.map(f=>{
      const badge=f.status||'M';
      const add=f.added>0?`<span class="stat-add">+${f.added}</span>`:'';
      const del=f.deleted>0?`<span class="stat-del"> -${f.deleted}</span>`:'';
      return `<div class="file-item" onclick="openFileDiff(${esc(JSON.stringify(f.path))},${esc(JSON.stringify(base))})">
        <span class="file-badge badge-${badge}">${esc(badge)}</span>
        <span class="file-path">${esc(f.path)}</span>
        <span class="file-stat">${add}${del}</span>
      </div>`;
    }).join('');
  }catch(e){el.innerHTML='<div class="empty err-msg">Error de conexión.</div>'}
}

async function openFileDiff(path, base){
  const dir=cwd();
  const overlay=document.getElementById('rv-file-view');
  document.getElementById('rv-file-title').textContent=path;
  document.getElementById('rv-diff-content').innerHTML='<span class="dl dl-ctx">Cargando&#8230;</span>';
  overlay.classList.add('on');

  try{
    const r=await fetch('/api/review/file'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)+'&path='+encodeURIComponent(path));
    const text=await r.text();
    document.getElementById('rv-diff-content').innerHTML=r.ok ? renderDiff(text) : `<span class="dl dl-del">${esc(text)}</span>`;
  }catch(e){
    document.getElementById('rv-diff-content').innerHTML='<span class="dl dl-del">Error de conexión.</span>';
  }
}

function closeFileDiff(){
  document.getElementById('rv-file-view').classList.remove('on');
}
