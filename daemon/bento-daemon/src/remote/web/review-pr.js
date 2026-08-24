// Pull requests: diff, comentarios y enviar una review.
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
    const at=c=>c.created_at||c.submitted_at||'';
    const all=[...comments,...reviews].sort((a,b)=>new Date(at(a))-new Date(at(b)));

    if(!all.length){el.innerHTML='<div class="empty">Sin comentarios aún.</div>';return}

    el.innerHTML=all.map(c=>{
      const author=c.user?.login||'unknown';
      const date=at(c)?fmtDate(at(c)):'';
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
