let state={user:null,products:[],categories:[],movements:[]};
const $=s=>document.querySelector(s);
async function api(url,opts={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||"Erro");return d}
async function init(){
  const me=await api("/api/me"); if(!me.user){$("#login").classList.remove("hidden");$("#app").classList.add("hidden");return}
  state.user=me.user;$("#login").classList.add("hidden");$("#app").classList.remove("hidden");
  $("#userName").textContent=state.user.username;$("#roleBadge").textContent=state.user.role==="admin"?"ADMINISTRADOR":"PROJETO";
  $("#permission").textContent=state.user.role==="admin"?"Você pode abastecer e dar baixa":"Visualização do estoque em tempo real";
  if(state.user.role!=="admin"){$("#roleBadge").style.background="rgba(111,199,154,0.15)";$("#roleBadge").style.borderColor="rgba(111,199,154,0.4)";}
  await refresh(); buildTicker(); refreshKanban();
}
async function refresh(){state.products=await api("/api/products");state.movements=await api("/api/movements");renderProducts();renderStats();renderCategories();renderMovements();buildTicker()}
function renderCategories(){let c=[...new Set(state.products.map(p=>p.category))].sort();let sel=$("#category"),old=sel.value;sel.innerHTML='<option value="">Todas as categorias</option>'+c.map(x=>`<option>${x}</option>`).join("");sel.value=old}
function filtered(){let q=$("#search").value.toLowerCase(),c=$("#category").value;return state.products.filter(p=>(!c||p.category===c)&&(!q||p.code.toLowerCase().includes(q)||p.name.toLowerCase().includes(q)))}
const MIN_STOCK=3, NEAR_STOCK=5;
function stockStatus(p){
  if(p.stock < MIN_STOCK) return {cls:"crit", label:`Estoque abaixo do mínimo (${MIN_STOCK})`};
  if(p.stock < NEAR_STOCK) return {cls:"near", label:`Estoque perto do mínimo (${MIN_STOCK})`};
  return {cls:"", label:""};
}

function renderStockAlert(){
  const crit = state.products.filter(p=>p.stock < MIN_STOCK);
  const near = state.products.filter(p=>p.stock >= MIN_STOCK && p.stock < NEAR_STOCK);
  const el = $("#stockAlert");
  if(!el) return;
  if(!crit.length && !near.length){ el.classList.add("hidden"); el.innerHTML=""; return; }
  let parts = [];
  if(crit.length) parts.push(`<div class="alert-row crit"><b>${crit.length} item(ns) ABAIXO do mínimo (${MIN_STOCK}):</b> ${crit.slice(0,6).map(p=>`${esc(p.name)} (${p.stock})`).join(", ")}${crit.length>6?"...":""}. <span class="alert-cta">Reabasteça!</span></div>`);
  if(near.length) parts.push(`<div class="alert-row near"><b>${near.length} item(ns) perto do mínimo:</b> ${near.slice(0,6).map(p=>`${esc(p.name)} (${p.stock})`).join(", ")}${near.length>6?"...":""}.</div>`);
  el.classList.remove("hidden");
  el.innerHTML = parts.join("");
}

function renderProducts(){
 let rows=filtered(); $("#products").innerHTML=rows.map(p=>{let total=(p.stock*(p.weight_6m||0)).toFixed(2).replace(".",",");
 let st=stockStatus(p);
 let badge=st.cls?` <span class="stock-badge ${st.cls}">${st.label}</span>`:"";
 let actions=state.user.role==="admin"?`<div class="action"><button class="in" onclick="openMove(${p.id},'abastecimento')">+ Abastecer</button><button class="out" onclick="openMove(${p.id},'baixa')">− Baixar</button></div>`:`<span class="mini">Somente leitura</span>`;
 return `<tr><td><span class="cat-badge">${esc(p.category)}</span></td><td>${esc(p.code)}</td><td>${esc(p.name)}</td><td>${p.weight_6m?p.weight_6m.toFixed(2).replace(".",",")+" kg":"—"}</td><td class="stock ${st.cls} ${p.stock===0?"zero":""}">${p.stock}</td><td>${total} kg${badge}</td><td>${actions}</td></tr>`}).join("")||`<tr><td colspan="7" class="muted">Nenhum material encontrado.</td></tr>`;
 renderStockAlert();
}
function renderStats(){let total=state.products.reduce((a,p)=>a+p.stock,0),kg=state.products.reduce((a,p)=>a+p.stock*(p.weight_6m||0),0),cats=new Set(state.products.map(p=>p.category)).size,zero=state.products.filter(p=>p.stock===0).length;
$("#stats").innerHTML=[["Peças em estoque",total],["Peso estimado",kg.toLocaleString("pt-BR",{maximumFractionDigits:2})+" kg"],["Categorias",cats],["Itens zerados",zero]].map(x=>`<div class="stat"><small>${x[0]}</small><strong>${x[1]}</strong></div>`).join("")}
function renderMovements(){const m=state.movements;$("#movements").innerHTML=m.map(x=>`<div class="movement"><div class="line"><strong>${esc(x.code)} · ${esc(x.name)}</strong><span class="qty ${x.type==="abastecimento"?"in":"out"}">${x.type==="abastecimento"?"+":"−"}${x.quantity}</span></div><small>${esc(x.category)} · ${esc(x.username)} · ${new Date(x.created_at.replace(" ","T")+"Z").toLocaleString("pt-BR")}${x.note?" · "+esc(x.note):""}</small></div>`).join("")||`<div class="movement muted">Nenhuma movimentação ainda.</div>`}
function buildTicker(){
  // Ticker de movimentações em tempo real: mostra as últimas baixas e abastecimentos
  const movs = state.movements.slice(0, 12); // últimas 12 movimentações
  const items = movs.length ? movs : [{type:"abastecimento",quantity:0,code:"Sem movimentações ainda",name:""}];
  const html = '<div class="ticker-track">' + items.concat(items).map(m=>{
    const isIn = m.type === "abastecimento";
    const sign = isIn ? "+" : "−";
    const cls = isIn ? "up" : "down";
    const label = isIn ? "ENTROU" : "BAIXA";
    return `<span class="tick"><b>${esc(label)}</b> <span class="${cls}">${sign}${m.quantity}</span> ${esc(m.code)} · ${esc(m.name)}</span>`;
  }).join("") + '</div>';
  $("#ticker").innerHTML = html;
}
function openMove(id,type){let p=state.products.find(x=>x.id===id);$("#modal").classList.remove("hidden");$("#productId").value=id;$("#moveType").value=type;$("#modalType").textContent=type==="abastecimento"?"ABASTECIMENTO":"BAIXA";$("#modalTitle").textContent=p.name;$("#modalInfo").textContent=`${p.code} · Estoque atual: ${p.stock} ${p.unit||"barra"}(s)`;$("#quantityUnit").innerHTML = p.unit && p.unit!=="barra" ? `de ${p.unit}s` : "de barras";$("#moveBtn").textContent=type==="abastecimento"?"Confirmar abastecimento":"Confirmar baixa";$("#moveError").textContent="";$("#quantity").value="";$("#note").value="";$("#quantity").focus()}
$("#close").onclick=()=>$("#modal").classList.add("hidden");$("#modal").onclick=e=>{if(e.target.id==="modal")$("#modal").classList.add("hidden")};
$("#moveForm").onsubmit=async e=>{e.preventDefault();try{await api("/api/movement",{method:"POST",body:JSON.stringify({productId:Number($("#productId").value),type:$("#moveType").value,quantity:Number($("#quantity").value),note:$("#note").value})});$("#modal").classList.add("hidden");await refresh();buildTicker()}catch(err){$("#moveError").textContent=err.message}};
$("#loginForm").onsubmit=async e=>{e.preventDefault();$("#loginError").textContent="";try{await api("/api/login",{method:"POST",body:JSON.stringify({username:$("#username").value,password:$("#password").value})});await init()}catch(err){$("#loginError").textContent=err.message}};
$("#logout").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
// Alternar fundo (solzinho) — persistido
$("#themeToggle").onclick=()=>{
  document.body.classList.toggle("gray-theme");
  try{localStorage.setItem("gray-theme",document.body.classList.contains("gray-theme")?"1":"0")}catch(e){}
};
try{if(localStorage.getItem("gray-theme")==="1"){document.body.classList.add("gray-theme")}}catch(e){}
$("#search").oninput=renderProducts;$("#category").onchange=renderProducts;
// Abas Estoque / Regras / Valores / IA / Compras / Explicação
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
  t.classList.add("active");
  const tab=t.dataset.tab;
  ["estoque","regras","valores","ia","kanban","explicacao"].forEach(id=>{
    $("#tab-"+id).classList.toggle("hidden",id!==tab);
  });
});
// Som de notificação (WebAudio, sem arquivo externo)
let audioCtx=null;
function ensureAudio(){if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)()}catch(e){}}return audioCtx}
function playTone(freq,dur,type="sine",vol=0.15){
  const ctx=ensureAudio();if(!ctx)return;
  const o=ctx.createOscillator(),g=ctx.createGain();
  o.type=type;o.frequency.value=freq;
  g.gain.setValueAtTime(vol,ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+dur);
  o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+dur);
}
function playStockSound(type){
  try{
    if(type==="abastecimento"){playTone(880,0.12);setTimeout(()=>playTone(1174,0.18),110)}
    else{playTone(320,0.15,"sawtooth",0.12);setTimeout(()=>playTone(220,0.2,"sawtooth",0.12),140)}
  }catch(e){}
}
const socket=io();
let lastNotified="";
socket.on("inventory:update",async(data)=>{
  if(!state.user)return;
  const key=data?`${data.type}-${data.productId}-${data.quantity}`:`${Date.now()}`;
  if(key!==lastNotified){
    lastNotified=key;
    playStockSound(data?data.type:"abastecimento");
  }
  await refresh();buildTicker();
});
socket.on("purchases:update",async()=>{if(state.user)await refreshKanban()});
function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}

// ---------- Bolsa de valores (materiais / commodities) ----------
const BOLSA_ASSETS=[
  {ticker:"CHAPA", name:"Chapa de Aço", base:4.85},
  {ticker:"ALUM", name:"Alumínio", base:8.40},
  {ticker:"MILHO", name:"Milho (saca)", base:62.30},
  {ticker:"TUBO", name:"Tubo de Aço", base:12.15},
  {ticker:"CANTO", name:"Cantoneira", base:6.70},
  {ticker:"METALON", name:"Metalon", base:9.90},
  {ticker:"FERRO", name:"Ferro Chato", base:5.30},
  {ticker:"CU", name:"Cobre", base:32.80},
];
let bolsa=BOLSA_ASSETS.map(a=>({...a,price:a.base,open:a.base,prev:a.base*(1-(Math.random()*0.06-0.03)),high:a.base,low:a.base,vol:Math.floor(Math.random()*4000+500)}));
function fmtB(v){return v.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}
function renderBolsa(){
  $("#bolsaBody").innerHTML=bolsa.map(a=>{
    const chg=((a.price-a.prev)/a.prev)*100;
    const up=chg>=0;
    return `<tr><td><div class="asset"><span class="dot"></span>${esc(a.ticker)} <span class="muted">${esc(a.name)}</span></div></td><td class="price">R$ ${fmtB(a.price)}</td><td class="chg ${up?"up":"down"}">${up?"▲":"▼"} ${Math.abs(chg).toFixed(2)}%</td><td class="minmax">R$ ${fmtB(a.high)}</td><td class="minmax">R$ ${fmtB(a.low)}</td><td class="vol">${a.vol.toLocaleString("pt-BR")}</td></tr>`;
  }).join("");
}
setInterval(()=>{
  bolsa=bolsa.map(a=>{
    const drift=(Math.random()-0.48)*0.012;
    let price=a.price*(1+drift);
    if(price<a.base*0.88)price=a.base*0.88;
    if(price>a.base*1.15)price=a.base*1.15;
    return {...a,price,high:Math.max(a.high,price),low:Math.min(a.low,price),vol:a.vol+Math.floor(Math.random()*20)};
  });
  renderBolsa();
},4000);
renderBolsa();

// ---------- IA (assistente de estoque) ----------
const aiChat=$("#aiChat");
function fmtTime(){
  const d=new Date();
  return d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric"})+" "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
}
function aiAdd(role,text){
  const d=document.createElement("div");
  d.className="ai-msg "+role;
  d.textContent=text;
  const t=document.createElement("span");
  t.className="ai-msg-time";
  t.textContent=fmtTime();
  d.appendChild(t);
  aiChat.appendChild(d);
  aiChat.scrollTop=aiChat.scrollHeight;
  return d;
}
function aiSetWorking(){
  $(".ai-send").disabled=true;$(".ai-sheet").disabled=true;
  $(".ai-ask input").classList.add("ai-loading");$(".ai-send").classList.add("ai-loading");
  $(".ai-sheet").classList.add("ai-loading");
}
function aiDone(){
  $(".ai-send").disabled=false;$(".ai-sheet").disabled=false;
  $(".ai-ask input").classList.remove("ai-loading");$(".ai-send").classList.remove("ai-loading");
  $(".ai-sheet").classList.remove("ai-loading");
}
async function aiAsk(text,isSheet){
  if(!text&&!isSheet)return;
  aiSetWorking();
  try{
    const r=await api("/api/ai",{method:"POST",body:JSON.stringify({question:text,sheet:isSheet})});
    aiAdd("bot",r.answer);
    if(r.usage)$("#aiUsage").textContent=`Tokens usados hoje: ${r.usage.used.toLocaleString("pt-BR")} / ${r.usage.limit.toLocaleString("pt-BR")}`;
  }catch(e){
    aiAdd("bot error","Erro: "+e.message);
  }finally{aiDone()}
}
$("#aiSheet").onclick=()=>{
  // Baixa a planilha Excel INTELIGENTE (.xlsx) com dados reais + análise da IA
  aiAdd("user","📋 Planilha inteligente do dia (Excel com análise)");
  aiAdd("bot","Gerando planilha inteligente com análise da IA...");
  fetch("/api/planilha-inteligente")
    .then(r=>{if(!r.ok)throw new Error("Falha ao gerar");return r.blob()})
    .then(blob=>{
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download="boletim-analitico-"+new Date().toISOString().slice(0,10)+".xlsx";
      document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
      aiChat.lastChild.textContent="Planilha inteligente baixada! Verifique sua pasta de downloads.";
      const t=document.createElement("span");t.className="ai-msg-time";t.textContent=fmtTime();
      aiChat.lastChild.appendChild(t);
    })
    .catch(e=>{const d=aiAdd("bot error","Erro ao baixar planilha: "+e.message);setTimeout(()=>d.remove(),8000)});
};
$("#aiSend").onclick=()=>{
  const q=$("#aiQuestion").value.trim();
  if(!q)return;
  aiAdd("user",q);
  $("#aiQuestion").value="";
  aiAsk(q,false);
};
$("#aiQuestion").addEventListener("keydown",e=>{if(e.key==="Enter")$("#aiSend").click()});
async function loadAiUsage(){
  try{const u=await api("/api/ai/usage");$("#aiUsage").textContent=`Tokens usados hoje: ${u.used.toLocaleString("pt-BR")} / ${u.limit.toLocaleString("pt-BR")}`}catch(e){}
}
loadAiUsage();

// ---------- Kanban de compras ----------
const KANBAN_STATUS=["solicitado","aprovado","comprado","entregue","cancelado"];
const KANBAN_LABEL={solicitado:"Solicitado",aprovado:"Aprovado",comprado:"Comprado",entregue:"Entregue",cancelado:"Cancelado"};
let purchases=[];
async function refreshKanban(){
  try{purchases=await api("/api/purchases")}catch(e){purchases=[]}
  renderKanban();
}
function renderKanban(){
  KANBAN_STATUS.forEach(s=>{
    const col=document.getElementById("col-"+s);
    const items=purchases.filter(p=>p.status===s);
    document.getElementById("count-"+s).textContent=items.length;
    col.innerHTML=items.map(p=>`
      <div class="kanban-card" data-id="${p.id}">
        <div class="k-title">${esc(p.material)} ${p.quantity>1?`×${p.quantity}`:""}</div>
        ${p.supplier?`<div class="k-supplier">Fornecedor: ${esc(p.supplier)}</div>`:""}
        <div class="k-meta">Criado por ${esc(p.created_by)} · ${esc(String(p.created_at||"").slice(0,10))}</div>
        <div class="k-actions">
          ${s!=="solicitado"&&s!=="cancelado"?`<button class="k-btn" onclick="movePurchase(${p.id},'${s==="aprovado"?"solicitado":s==="comprado"?"aprovado":s==="entregue"?"comprado":"aprovado"}')">◀</button>`:""}
          ${s!=="cancelado"&&s!=="entregue"?`<button class="k-btn" onclick="movePurchase(${p.id},'${s==="solicitado"?"aprovado":s==="aprovado"?"comprado":"entregue"}')">▶</button>`:""}
          <button class="k-btn danger" onclick="deletePurchase(${p.id})">🗑</button>
        </div>
      </div>`).join("")||`<div class="kanban-empty">Vazio</div>`;
  });
}
async function movePurchase(id,status){
  try{await api("/api/purchases/"+id,{method:"PATCH",body:JSON.stringify({status})});await refreshKanban()}catch(e){alert(e.message)}
}
async function deletePurchase(id){
  if(!confirm("Excluir esta compra?"))return;
  try{await api("/api/purchases/"+id,{method:"DELETE"});await refreshKanban()}catch(e){alert(e.message)}
}
$("#kanbanAdd").onclick=()=>{
  const material=prompt("Material (ex.: Chapa de aço 1/4):");
  if(!material||!material.trim())return;
  const qty=prompt("Quantidade:", "1");
  const supplier=prompt("Fornecedor (opcional):", "");
  api("/api/purchases",{method:"POST",body:JSON.stringify({material:material.trim(),quantity:Number(qty)||1,supplier:supplier||""})})
    .then(()=>refreshKanban()).catch(e=>alert(e.message));
};

init();