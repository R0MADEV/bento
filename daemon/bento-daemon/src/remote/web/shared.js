const token=new URLSearchParams(location.search).get('token')||'';
const q='?token='+encodeURIComponent(token);

function esc(s){
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── Main tab switching ─────────────────────────────────────────────────────────

function switchTab(name){
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',i===(name==='review'?1:0)));
  const pt=document.getElementById('page-terminals');
  const pr=document.getElementById('page-review');
  if(name==='review'){
    pt.style.display='none';
    pr.style.display='flex';
    loadProjects().then(()=>{const dir=cwd();if(dir)loadBranches(dir)});
  } else {
    pr.style.display='none';
    pt.style.display='flex';
    load();
  }
}
