// Estado de la review, checkpoints, helpers de formato y la barra de
// proyecto/rama, más el explorador de carpetas.
// ── Review state ───────────────────────────────────────────────────────────────

let reviewSse=null;

let currentPR=null;

let reviewSessionId=null;
// Identifies the review in flight. Shared by the saves it makes as it goes,
// and new for the next one — without it a second review of the same branch
// overwrote the first, taking its report and its resumable session.
let reviewRunId=null;

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
    if(reviewRunId){body.run_id=reviewRunId;}
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
    // "desfasada" = la rama se movió desde que se hizo; el informe habla de
    // otro código. Lo decide el daemon, igual para los tres clientes.
    info.innerHTML='<span class="rv-hist-chip-branch">'+esc(item.branch||item.base)+'</span>'
      +(item.saved_at?'<span class="rv-hist-chip-date">'+esc(fmtRelDate(item.saved_at))+'</span>':'')
      +(item.stale?'<span class="rv-hist-chip-stale" title="La rama se movió desde esta review">desfasada</span>':'');
    info.onclick=()=>{
      document.getElementById('rv-base').value=item.base;
      // This run, not the branch's newest: several reviews of one branch are
      // kept now, so asking by base alone would always reopen the last.
      void restoreReviewCheckpoint(dir,item.base,item.run_id,item.stale);
      void renderReviewHistory(dir);
    };
    const del=document.createElement('button');
    del.className='rv-hist-chip-del';
    del.textContent='×';
    del.title='Eliminar review';
    del.onclick=async ev=>{
      ev.stopPropagation();
      // Naming the run matters: by base alone the delete missed the file and
      // the chip came back on the next listing.
      const run=item.run_id?'&run_id='+encodeURIComponent(item.run_id):'';
      try{await fetch('/api/review/checkpoint'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(item.base)+run,{method:'DELETE'});}catch(_){}
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

async function restoreReviewCheckpoint(dir,base,runId,stale){
  const out=document.getElementById('rv-output');
  if(!out)return;
  try{
    const res=await fetch('/api/review/checkpoint'+q+'&cwd='+encodeURIComponent(dir)+'&base='+encodeURIComponent(base)
      +(runId?'&run_id='+encodeURIComponent(runId):''));
    if(!res.ok){
      hideChat();
      out.className='empty-state';
      out.innerHTML='<div class="rv-placeholder">Elige un proyecto y una rama base<br>para iniciar la revisión.</div>';
      return;
    }
    const cp=await res.json();
    out.className='rv-md';
    // Lo mismo que dice el chip en el historial, repetido aquí: es al leer el
    // informe cuando importa que hable de otro código.
    const warning=stale?'<div class="rv-stale">Esta review es de un commit que la rama ya dejó atrás.</div>':'';
    out.innerHTML=warning+mdToHtml(cp.content||'');
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

// ── Resaltado ────────────────────────────────────────────────────────────────
// Las mismas palabras que el escritorio y la CLI, para que un fichero se lea
// igual en los tres. Aquí no hay dónde meter una librería: los ficheros del
// teléfono van embebidos en el daemon y sin empaquetador.
const KW={
  ts:'const let var function return if else for while class import export from default async await new this typeof null undefined true false void type interface enum extends implements public private protected readonly static abstract switch case break continue try catch finally throw delete in of instanceof',
  rs:'fn let mut const struct enum impl trait use pub mod return if else for while match Some None Ok Err true false self Self super crate async await move where type ref loop break continue',
  py:'def class return if else elif for while import from as with in not and or is None True False pass break continue try except finally raise yield async await lambda global nonlocal',
  go:'func var const return if else for range go select case default break continue type struct interface import package nil true false defer make new len cap chan map switch',
};
const EXT_LANG={ts:'ts',tsx:'ts',js:'ts',jsx:'ts',mjs:'ts',cjs:'ts',rs:'rs',py:'py',go:'go'};

function highlight(code, path){
  const ext=(path||'').split('.').pop().toLowerCase();
  const lang=EXT_LANG[ext];
  if(!lang)return esc(code);
  const words=new Set(KW[lang].split(' '));
  const comment=lang==='py'?'#':'//';
  let out='',i=0;
  while(i<code.length){
    if(code.startsWith(comment,i)){out+=`<span class="sh-comment">${esc(code.slice(i))}</span>`;break}
    const c=code[i];
    if(c==='"'||c==="'"||c==='`'){
      let j=i+1;
      while(j<code.length){ if(code[j]==='\\'){j+=2;continue} if(code[j]===c){j++;break} j++ }
      out+=`<span class="sh-string">${esc(code.slice(i,j))}</span>`;i=j;continue;
    }
    if(c>='0'&&c<='9'){
      let j=i;while(j<code.length&&/[\w.]/.test(code[j]))j++;
      out+=`<span class="sh-number">${esc(code.slice(i,j))}</span>`;i=j;continue;
    }
    if(/[A-Za-z_$]/.test(c)){
      let j=i;while(j<code.length&&/[\w$]/.test(code[j]))j++;
      const word=code.slice(i,j);
      out+=words.has(word)?`<span class="sh-keyword">${esc(word)}</span>`:esc(word);
      i=j;continue;
    }
    out+=esc(c);i++;
  }
  return out;
}

// El fichero al que pertenece cada línea del diff, para saber de qué lenguaje
// es. Un diff de varios ficheros los va anunciando con `diff --git`.
function renderDiff(text, path){
  let file=path||'',line=0,inHunk=false;
  return text.split('\n').map(raw=>{
    const match=raw.match(/^diff --git .* b\/(.+)$/);
    if(match){file=match[1];inHunk=false;return `<span class="dl dl-hdr">${esc(raw)}</span>`}
    if(raw.startsWith('+++')||raw.startsWith('---'))return `<span class="dl dl-hdr">${esc(raw)}</span>`;
    if(raw.startsWith('@@')){
      const at=raw.match(/\+(\d+)/);
      line=at?parseInt(at[1],10):0;inHunk=true;
      return `<span class="dl dl-hunk">${esc(raw)}</span>`;
    }
    // El número de la línea nueva, como en el escritorio: sin él no se sabe de
    // qué línea hablar al comentar.
    const no=(inHunk&&!raw.startsWith('-'))?String(line++):'';
    const gutter=`<span class="dl-no">${no}</span>`;
    if(!inHunk)return `<span class="dl dl-ctx">${gutter}${esc(raw)}</span>`;
    const sign=raw.slice(0,1),code=raw.slice(1);
    const body=`${esc(sign)}${highlight(code,file)}`;
    if(raw.startsWith('+'))return `<span class="dl dl-add">${gutter}${body}</span>`;
    if(raw.startsWith('-'))return `<span class="dl dl-del">${gutter}${body}</span>`;
    return `<span class="dl dl-ctx">${gutter}${body}</span>`;
  }).join('');
}

// El mismo diff en dos columnas: lo viejo a la izquierda y lo nuevo a la
// derecha, con los borrados y los añadidos emparejados en la misma fila. Es lo
// que hacen el escritorio y el cli; en el móvil la tabla se desplaza a lo
// ancho, que es lo único que cambia cuando la pantalla no da.
function renderDiffSplit(text, path){
  let file=path||'',oldNo=0,newNo=0,inHunk=false;
  const entries=[];
  for(const raw of text.split('\n')){
    const match=raw.match(/^diff --git .* b\/(.+)$/);
    if(match){file=match[1];inHunk=false;entries.push({kind:'hdr',text:raw});continue}
    if(raw.startsWith('+++')||raw.startsWith('---')){entries.push({kind:'hdr',text:raw});continue}
    if(raw.startsWith('@@')){
      const at=raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if(at){oldNo=parseInt(at[1],10)-1;newNo=parseInt(at[2],10)-1}
      inHunk=true;entries.push({kind:'hunk',text:raw});continue;
    }
    if(!inHunk){entries.push({kind:'hdr',text:raw});continue}
    if(raw.startsWith('-')){entries.push({kind:'del',no:++oldNo,code:raw.slice(1),file});continue}
    if(raw.startsWith('+')){entries.push({kind:'add',no:++newNo,code:raw.slice(1),file});continue}
    entries.push({kind:'ctx',oldNo:++oldNo,no:++newNo,code:raw.slice(1),file});
  }

  // El lado nuevo lleva a qué fichero y a qué línea corresponde: es lo que
  // necesita quien comente sin tener que contar filas desde arriba.
  const cell=(side,extra,no,code,file,anchor)=>{
    const at=anchor?` data-file="${esc(file)}" data-line="${no}"`:'';
    return `<div class="split-cell split-${side}${extra}"${at}><span class="dl-no">${no}</span>${highlight(code,file)}</div>`;
  };
  const empty=side=>`<div class="split-cell split-${side} split-empty"></div>`;

  const out=[];
  for(let i=0;i<entries.length;){
    const entry=entries[i];
    if(entry.kind==='hdr'){out.push(`<div class="dl dl-hdr">${esc(entry.text)}</div>`);i++;continue}
    if(entry.kind==='hunk'){out.push(`<div class="dl dl-hunk">${esc(entry.text)}</div>`);i++;continue}
    if(entry.kind==='ctx'){
      out.push(`<div class="split-row">${cell('left','',entry.oldNo,entry.code,entry.file)}`+
        `${cell('right',' split-ctx-right',entry.no,entry.code,entry.file,true)}</div>`);
      i++;continue;
    }
    // Un bloque de borrados seguido de sus añadidos: emparejados por orden,
    // que es lo que deja la línea vieja al lado de la que la sustituye.
    const dels=[],adds=[];
    while(i<entries.length&&entries[i].kind==='del')dels.push(entries[i++]);
    while(i<entries.length&&entries[i].kind==='add')adds.push(entries[i++]);
    for(let j=0;j<Math.max(dels.length,adds.length);j++){
      const del=dels[j],add=adds[j];
      const left=del?cell('left',' split-del',del.no,del.code,del.file):empty('left');
      const right=add?cell('right',' split-add',add.no,add.code,add.file,true):empty('right');
      out.push(`<div class="split-row">${left}${right}</div>`);
    }
  }
  return out.join('');
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
