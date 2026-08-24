// Estado de la review, checkpoints, helpers de formato y la barra de
// proyecto/rama, más el explorador de carpetas.
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

// ── Agent selector ─────────────────────────────────────────────────────────────

// ── Archivos ───────────────────────────────────────────────────────────────────

// ── PRs ────────────────────────────────────────────────────────────────────────

// ── PR Diff ────────────────────────────────────────────────────────────────────

// ── PR Comments ────────────────────────────────────────────────────────────────

// ── Submit review ──────────────────────────────────────────────────────────────

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
