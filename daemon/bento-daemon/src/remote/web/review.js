// ── Review state ───────────────────────────────────────────────────────────────
let reviewSse=null;
let currentPR=null;
let reviewSessionId=null;
let reviewSessionAgent=null;

function fmtRelDate(iso){
  try{
    const diff=Date.now()-new Date(iso).getTime();
    const mins=Math.floor(diff/60000);
    if(mins<1)return 'ahora';
    if(mins<60)return mins+'m';
    const hrs=Math.floor(mins/60);
    if(hrs<24)return hrs+'h';
    const days=Math.floor(hrs/24);
    if(days<30)return days+'d';
    return new Date(iso).toLocaleDateString([],{day:'numeric',month:'short'});
  }catch(_){return '';}
}
async function saveReviewCheckpoint(dir,base,buf){
  if(!buf.trim())return;
  try{
    const body={cwd:dir,base,content:buf,saved_at:new Date().toISOString()};
    if(reviewSessionId){body.session_id=reviewSessionId;}
    if(reviewSessionAgent){body.session_agent=reviewSessionAgent;}
    await fetch('/api/review/checkpoint'+q,{
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    await renderReviewHistory(dir);
  }catch(_){}
}
async function renderReviewHistory(dir){
  const hist=document.getElementById('rv-history');
  if(!hist)return;
  let items=[];
  try{
    const res=await fetch('/api/review/checkpoints'+q+'&cwd='+encodeURIComponent(dir));
    if(res.ok)items=await res.json();
  }catch(_){}
  if(!items.length){hist.style.display='none';return;}
  const currentBase=(document.getElementById('rv-base').value||'').trim()||'main';
  hist.innerHTML='';
  hist.style.display='flex';
  items.forEach(item=>{
    const chip=document.createElement('div');
    chip.className='rv-hist-chip'+(item.base===currentBase?' active':'');
    chip.style.cursor='pointer';
    const info=document.createElement('div');
    info.className='rv-hist-chip-info';
    info.innerHTML='<span class="rv-hist-chip-branch">'+esc(item.base)+'</span>'
      +(item.saved_at?'<span class="rv-hist-chip-date">'+esc(fmtRelDate(item.saved_at))+'</span>':'');
    info.onclick=()=>{
      document.getElementById('rv-base').value=item.base;
      void restoreReviewCheckpoint(dir,item.base);
      void renderReviewHistory(dir);
    };
    const del=document.createElement('button');
    del.className='rv-hist-chip-del';
    del.textContent='×';
    del.title='Eliminar review';
    del.onclick=async ev=>{
      ev.stopPropagation();
      try{await fetch('/api/review/checkpoint'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(item.base),{method:'DELETE'});}catch(_){}
      if(item.base===currentBase){
        const out=document.getElementById('rv-output');
        if(out){out.className='empty-state';out.innerHTML='<div class="rv-placeholder">Elige un proyecto y una rama base<br>para iniciar la revisión.</div>';}
      }
      await renderReviewHistory(dir);
    };
    chip.append(info,del);
    hist.append(chip);
  });
}
async function restoreReviewCheckpoint(dir,base){
  const out=document.getElementById('rv-output');
  if(!out)return;
  try{
    const res=await fetch('/api/review/checkpoint'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base));
    if(!res.ok){
      hideChat();
      out.className='empty-state';
      out.innerHTML='<div class="rv-placeholder">Elige un proyecto y una rama base<br>para iniciar la revisión.</div>';
      return;
    }
    const cp=await res.json();
    out.className='rv-md';
    out.innerHTML=mdToHtml(cp.content||'');
    showChat();
  }catch(_){}
}

function cwd(){return document.getElementById('rv-project').value}

// ── Output expand ──────────────────────────────────────────────────────────────
function toggleOutputExpand(){
  const wrap=document.getElementById('rv-output-wrap');
  const btn=document.getElementById('rv-expand-btn');
  const expanded=wrap.classList.toggle('expanded');
  btn.textContent=expanded?'✕':'⤢';
}

// ── Chat / follow-up ask ───────────────────────────────────────────────────────
let askSse=null;

function showChat(){
  const chat=document.getElementById('rv-chat');
  if(chat)chat.style.display='flex';
}
function hideChat(){
  const chat=document.getElementById('rv-chat');
  if(chat)chat.style.display='none';
  const msgs=document.getElementById('rv-chat-msgs');
  if(msgs)msgs.innerHTML='';
}

function onAskKey(e){
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAsk();}
}

function sendAsk(){
  const input=document.getElementById('rv-ask-input');
  const question=(input.value||'').trim();
  if(!question)return;
  if(askSse){askSse.close();askSse=null;}

  const dir=cwd();
  const base=(document.getElementById('rv-base').value||'').trim()||'main';
  const agent=document.getElementById('rv-agent')?.value||'claude';

  const msgs=document.getElementById('rv-chat-msgs');
  const qEl=document.createElement('div');
  qEl.className='rv-chat-q';
  qEl.textContent=question;
  msgs.append(qEl);
  input.value='';
  input.style.height='';

  const aEl=document.createElement('div');
  aEl.className='rv-chat-a streaming';
  msgs.append(aEl);
  msgs.scrollTop=msgs.scrollHeight;

  const sendBtn=document.getElementById('rv-ask-send');
  sendBtn.disabled=true;

  let buf='';
  const url='/api/review/ask'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)
    +'&agent='+encodeURIComponent(agent)+'&question='+encodeURIComponent(question);
  askSse=new EventSource(url);
  askSse.onmessage=e=>{
    let data;try{data=JSON.parse(e.data);}catch(_){data=e.data;}
    if(data==='[DONE]'){
      askSse.close();askSse=null;
      aEl.classList.remove('streaming');
      sendBtn.disabled=false;
      return;
    }
    buf+=data;
    appendPinned(msgs,()=>{aEl.innerHTML=mdToHtml(buf);});
  };
  askSse.onerror=()=>{
    askSse.close();askSse=null;
    aEl.classList.remove('streaming');
    if(!buf)aEl.textContent='Error al conectar con el agente.';
    sendBtn.disabled=false;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Margen en px dentro del cual se considera que el usuario sigue "pegado" al fondo.
const SCROLL_PIN_SLACK=40;

function isPinnedToBottom(el){
  return el.scrollHeight-el.scrollTop-el.clientHeight<=SCROLL_PIN_SLACK;
}

// Escribe contenido nuevo y solo baja al fondo si el usuario ya estaba abajo.
// Hay que medir ANTES de mutar: al crecer scrollHeight nadie sigue "pegado".
function appendPinned(el,render){
  const wasPinned=isPinnedToBottom(el);
  render();
  if(wasPinned)el.scrollTop=el.scrollHeight;
}

function fmtDate(iso){
  const d=new Date(iso);
  return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

function renderDiff(text){
  return text.split('\n').map(line=>{
    if(line.startsWith('+++') || line.startsWith('---')) return `<span class="dl dl-hdr">${esc(line)}</span>`;
    if(line.startsWith('+')) return `<span class="dl dl-add">${esc(line)}</span>`;
    if(line.startsWith('-')) return `<span class="dl dl-del">${esc(line)}</span>`;
    if(line.startsWith('@@')) return `<span class="dl dl-hunk">${esc(line)}</span>`;
    return `<span class="dl dl-ctx">${esc(line)}</span>`;
  }).join('');
}

function mdToHtml(text){
  // Escape first so any HTML in the reviewed content (diff text, AI output) can't
  // inject markup — the markdown syntax below (#, *, `, -) survives esc() untouched.
  text=esc(text);
  text=text.replace(/```[\w]*\n([\s\S]*?)```/g,(_,c)=>'<pre><code>'+c.trim()+'</code></pre>');
  text=text.replace(/`([^`]+)`/g,(_,c)=>'<code>'+c+'</code>');
  text=text.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  text=text.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  text=text.replace(/^# (.+)$/gm,'<h2>$1</h2>');
  text=text.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  text=text.replace(/\*(.+?)\*/g,'<em>$1</em>');
  text=text.replace(/^[-*] (.+)$/gm,'<li>$1</li>');
  text=text.replace(/(<li>.*<\/li>\n?)+/g,'<ul>$&</ul>');
  text=text.replace(/^(?!<[hup]|<\/|<li)(.+)$/gm,'<p>$1</p>');
  text=text.replace(/\n{2,}/g,'');
  return text;
}

// ── Review sub-tab switching ───────────────────────────────────────────────────

function switchReviewTab(name){
  document.querySelectorAll('.rv-tab').forEach((t,i)=>{
    const names=['ai','files','prs'];
    t.classList.toggle('active',names[i]===name);
  });
  document.querySelectorAll('.rv-subpage').forEach(p=>p.classList.remove('active'));
  document.getElementById('rv-page-'+name).classList.add('active');
  if(name==='prs' && cwd()) loadPRs();
}

function onProjectChange(){
  const dir=cwd();
  if(!dir) return;
  loadBranches(dir);
  document.getElementById('rv-base').value='main';
  document.getElementById('rv-files-base').value='main';
  document.getElementById('rv-branch-info').style.display='none';
  document.getElementById('rv-files-list').innerHTML='<div class="empty">Selecciona un proyecto y pulsa Ver.</div>';
  void restoreReviewCheckpoint(dir,'main');
  void renderReviewHistory(dir);
  initAgentUi();
  const tab=document.querySelector('.rv-tab.active');
  const idx=[...document.querySelectorAll('.rv-tab')].indexOf(tab);
  if(idx===2) loadPRs();
}

async function loadBranches(dir){
  try{
    const r=await fetch('/api/review/branches'+q+'&cwd='+encodeURIComponent(dir));
    if(!r.ok) return;
    const branches=await r.json();
    const dl=document.getElementById('rv-branches-datalist');
    dl.innerHTML=branches.map(b=>`<option value="${esc(b)}">`).join('');
  }catch(_){}
}

// ── Projects loader ────────────────────────────────────────────────────────────

async function loadProjects(){
  const sel=document.getElementById('rv-project');
  try{
    const r=await fetch('/api/projects'+q);
    if(!r.ok){sel.innerHTML='<option value="">Sin proyectos</option>';return}
    const ps=await r.json();
    if(!ps.length){sel.innerHTML='<option value="">No hay terminales con cwd</option>';return}
    const prev=sel.value;
    sel.innerHTML=ps.map(p=>{
      const name=p.cwd.split('/').filter(Boolean).pop()||p.cwd;
      const label=p.branch?`${name}  ·  ${p.branch}`:name;
      return `<option value="${esc(p.cwd)}">${esc(label)}</option>`;
    }).join('');
    if(prev && [...sel.options].some(o=>o.value===prev)) sel.value=prev;
  }catch(_){sel.innerHTML='<option value="">Error al cargar</option>'}
}

// ── IA Review ──────────────────────────────────────────────────────────────────

let reviewTimer=null;

function toggleProgressStream(){
  const s=document.getElementById('rv-progress-stream');
  const t=document.getElementById('rv-progress-toggle');
  const collapsed=s.classList.toggle('collapsed');
  t.textContent=collapsed?'▶':'▼';
}

// ── Agent selector ─────────────────────────────────────────────────────────────

const AGENT_LABELS={claude:'Claude',opencode:'OpenCode',codex:'Codex'};
const AGENT_TYPES=['claude','opencode','codex'];
function agentLabel(a){return AGENT_LABELS[a]||a;}

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

// ── Archivos ───────────────────────────────────────────────────────────────────

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

// ── PRs ────────────────────────────────────────────────────────────────────────

async function loadPRs(){
  const dir=cwd();
  const el=document.getElementById('rv-prs-list');
  if(!dir){el.innerHTML='<div class="empty">Selecciona un proyecto.</div>';return}
  el.innerHTML='<div class="empty">Cargando PRs&#8230;</div>';

  try{
    const r=await fetch('/api/review/prs'+q+'&cwd='+encodeURIComponent(dir));
    if(!r.ok){el.innerHTML='<div class="empty err-msg">'+esc(await r.text())+'</div>';return}
    const prs=await r.json();
    if(!prs.length){el.innerHTML='<div class="empty">No hay PRs abiertos.</div>';return}

    el.innerHTML=prs.map(p=>`
      <div class="pr-item" onclick="openPR(${p.number},${esc(JSON.stringify(p.title))})">
        <span class="pr-number">#${p.number}</span>
        <span class="pr-title-text">${esc(p.title)}</span>
        <span class="pr-meta">${esc(p.headRefName||'')} &middot; ${esc(p.author?.login||'')}</span>
      </div>`).join('');
  }catch(e){el.innerHTML='<div class="empty err-msg">Error de conexión.</div>'}
}

async function openPR(number, title){
  currentPR=number;
  document.getElementById('rv-pr-title').textContent='#'+number+' '+title;
  document.getElementById('rv-pr-view').classList.add('on');

  // reset to Diff tab
  switchPRTab('diff');
  loadPRDiff();
}

function closePRView(){
  document.getElementById('rv-pr-view').classList.remove('on');
  currentPR=null;
}

function switchPRTab(name){
  document.querySelectorAll('.rv-pr-tab').forEach((t,i)=>{
    const names=['diff','comments','submit'];
    t.classList.toggle('active',names[i]===name);
  });
  document.querySelectorAll('.pr-subpage').forEach(p=>p.classList.remove('active'));
  document.getElementById('rv-pr-page-'+name).classList.add('active');
  if(name==='comments') loadPRComments();
}

// ── PR Diff ────────────────────────────────────────────────────────────────────

async function loadPRDiff(){
  const dir=cwd();
  const el=document.getElementById('rv-pr-diff-content');
  el.innerHTML='<span class="dl dl-ctx">Cargando diff&#8230;</span>';

  try{
    const r=await fetch('/api/review/pr/diff'+q+'&cwd='+encodeURIComponent(dir)+'&pr='+currentPR);
    const text=await r.text();
    el.innerHTML=r.ok ? renderDiff(text) : `<span class="dl dl-del">${esc(text)}</span>`;
  }catch(e){
    el.innerHTML='<span class="dl dl-del">Error de conexión.</span>';
  }
}

// ── PR Comments ────────────────────────────────────────────────────────────────

async function loadPRComments(){
  const dir=cwd();
  const el=document.getElementById('rv-comments-list');
  el.innerHTML='<div class="empty">Cargando&#8230;</div>';

  try{
    const r=await fetch('/api/review/pr/comments'+q+'&cwd='+encodeURIComponent(dir)+'&pr='+currentPR);
    if(!r.ok){el.innerHTML='<div class="empty err-msg">'+esc(await r.text())+'</div>';return}
    const data=await r.json();

    const comments=(data.comments||[]).map(c=>({...c,kind:'comment'}));
    const reviews=(data.reviews||[]).filter(r=>r.body||r.state).map(r=>({...r,kind:'review'}));
    const all=[...comments,...reviews].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));

    if(!all.length){el.innerHTML='<div class="empty">Sin comentarios aún.</div>';return}

    el.innerHTML=all.map(c=>{
      const author=c.author?.login||'unknown';
      const date=c.createdAt?fmtDate(c.createdAt):'';
      const stateTag=c.kind==='review' && c.state && c.state!=='PENDING'
        ? `<span class="comment-state state-${c.state}">${esc(c.state.replace('_',' '))}</span>` : '';
      return `<div class="comment-item">
        <div class="comment-header">
          <span class="comment-author">@${esc(author)}</span>
          <span class="comment-date">${esc(date)}</span>
          ${stateTag}
        </div>
        <div class="comment-body-text">${esc(c.body||'')}</div>
      </div>`;
    }).join('');
  }catch(e){el.innerHTML='<div class="empty err-msg">Error de conexión.</div>'}
}

async function submitComment(){
  const dir=cwd();
  const textarea=document.getElementById('rv-comment-text');
  const btn=document.getElementById('rv-comment-submit');
  const body=textarea.value.trim();
  if(!body)return;

  btn.disabled=true;btn.textContent='Enviando&#8230;';
  try{
    const r=await fetch('/api/review/pr/comment'+q+'&cwd='+encodeURIComponent(dir)+'&pr='+currentPR,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({body}),
    });
    if(r.ok){
      textarea.value='';
      loadPRComments();
    }
  }finally{
    btn.disabled=false;btn.textContent='Comentar';
  }
}

// ── Submit review ──────────────────────────────────────────────────────────────

async function submitReview(){
  const dir=cwd();
  const event=[...document.querySelectorAll('input[name=rv-event]')].find(r=>r.checked)?.value||'COMMENT';
  const body=document.getElementById('rv-submit-body').value.trim();
  const btn=document.getElementById('rv-submit-btn');

  btn.disabled=true;btn.textContent='Enviando&#8230;';
  try{
    const r=await fetch('/api/review/pr/submit'+q+'&cwd='+encodeURIComponent(dir)+'&pr='+currentPR,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({event,body:body||undefined}),
    });
    if(r.ok){
      document.getElementById('rv-submit-body').value='';
      closePRView();
    }
  }finally{
    btn.disabled=false;btn.textContent='Enviar revisión';
  }
}

// ── Folder browser ────────────────────────────────────────────────────────────

let folderCurrentPath = '';

function openFolderBrowser(){
  document.getElementById('rv-folder-view').classList.add('on');
  const startPath=cwd()||'';
  browseDir(startPath||null);
}

function closeFolderBrowser(){
  document.getElementById('rv-folder-view').classList.remove('on');
}

async function browseDir(path){
  const el=document.getElementById('rv-folder-list');
  el.innerHTML='<div class="empty">Cargando&#8230;</div>';
  try{
    const url='/api/fs/dirs'+q+(path?'&path='+encodeURIComponent(path):'');
    const r=await fetch(url);
    if(!r.ok){el.innerHTML='<div class="empty err-msg">Error al leer directorio.</div>';return}
    const data=await r.json();
    folderCurrentPath=data.path;
    document.getElementById('rv-folder-path').textContent=data.path;
    let html='';
    if(data.parent){
      html+=`<div class="dir-item dir-up" data-path="${esc(data.parent)}"><span style="font-size:18px">&#8593;</span><span class="dir-name">.. subir</span></div>`;
    }
    if(data.dirs.length){
      html+=data.dirs.map(d=>{
        const full=data.path.replace(/\/$/,'')+'/'+d;
        return `<div class="dir-item" data-path="${esc(full)}"><span style="font-size:18px">&#128193;</span><span class="dir-name">${esc(d)}</span><span class="dir-arrow">&#8250;</span></div>`;
      }).join('');
    } else {
      html+='<div class="empty" style="padding-top:20px">Sin subcarpetas.</div>';
    }
    el.innerHTML=html;
    el.querySelectorAll('.dir-item[data-path]').forEach(item=>{
      item.addEventListener('click',()=>browseDir(item.dataset.path));
    });
  }catch(e){el.innerHTML='<div class="empty err-msg">Error de conexión.</div>'}
}

function selectFolder(){
  if(!folderCurrentPath) return;
  const sel=document.getElementById('rv-project');
  let opt=[...sel.options].find(o=>o.value===folderCurrentPath);
  if(!opt){
    opt=new Option(folderCurrentPath,folderCurrentPath);
    sel.appendChild(opt);
  }
  sel.value=folderCurrentPath;
  closeFolderBrowser();
  onProjectChange();
}
