// Preguntar sobre una review ya hecha: el chat de seguimiento.
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
