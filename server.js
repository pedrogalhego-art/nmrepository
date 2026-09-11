require("dotenv").config();
const express=require("express");
const http=require("http");
const path=require("path");
const session=require("express-session");
const bcrypt=require("bcryptjs");
const Database=require("better-sqlite3");
const {Server}=require("socket.io");
const fs=require("fs");

const app=express();
app.set("trust proxy", 1); // Render: HTTPS termina no proxy — necessário p/ cookie Secure da sessão funcionar
const server=http.createServer(app);
const io=new Server(server);
const db=new Database(process.env.DB_FILE||"estoque.db");
db.pragma("journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT UNIQUE NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','projeto')),
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 category TEXT NOT NULL,
 code TEXT NOT NULL,
 name TEXT NOT NULL,
 weight_6m REAL,
 stock INTEGER NOT NULL DEFAULT 0,
 UNIQUE(category,code)
);
CREATE TABLE IF NOT EXISTS movements(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 product_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('abastecimento','baixa')),
 quantity INTEGER NOT NULL,
 note TEXT,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(product_id) REFERENCES products(id),
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS purchases(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 material TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1,
 supplier TEXT,
 status TEXT NOT NULL DEFAULT 'solicitado' CHECK(status IN ('solicitado','aprovado','comprado','entregue','cancelado')),
 created_by TEXT NOT NULL,
 created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const products=JSON.parse(fs.readFileSync(path.join(__dirname,"products.json"),"utf8"));
const insertProduct=db.prepare(`INSERT OR IGNORE INTO products(category,code,name,weight_6m) VALUES(?,?,?,?)`);
const seedProducts=db.transaction(()=>Object.entries(products).forEach(([cat,items])=>items.forEach(p=>insertProduct.run(cat,p.code,p.name,p.weight_6m))));
seedProducts();

const countUsers=db.prepare("SELECT COUNT(*) c FROM users").get().c;
if(!countUsers){
  const ins=db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)");
  ins.run("admin",bcrypt.hashSync(process.env.ADMIN_PASSWORD||"admin123",12),"admin");
  ins.run("projeto",bcrypt.hashSync(process.env.PROJETO_PASSWORD||"projeto123",12),"projeto");
}

app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(session({
 secret:process.env.SESSION_SECRET||"troque-esta-chave",
 resave:false,saveUninitialized:false,
 cookie:{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",maxAge:8*60*60*1000}
}));
app.use(express.static(path.join(__dirname,"public")));

function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:"Não autenticado"}); next(); }
function admin(req,res,next){ if(!req.session.user || req.session.user.role!=="admin") return res.status(403).json({error:"Acesso permitido somente ao administrador"}); next(); }

app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));
app.post("/api/login",(req,res)=>{
 const {username,password}=req.body;
 const u=db.prepare("SELECT * FROM users WHERE username=?").get(String(username||"").trim());
 if(!u || !bcrypt.compareSync(String(password||""),u.password_hash)) return res.status(401).json({error:"Usuário ou senha inválidos"});
 req.session.user={id:u.id,username:u.username,role:u.role};
 res.json({user:req.session.user});
});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>res.json({ok:true})));

app.get("/api/categories",auth,(req,res)=>{
 const rows=db.prepare(`SELECT category,COUNT(*) items,SUM(stock) pieces,SUM(stock*COALESCE(weight_6m,0)) kg
 FROM products GROUP BY category ORDER BY category`).all();
 res.json(rows);
});
app.get("/api/products",auth,(req,res)=>{
 const q=String(req.query.q||"").trim(), cat=String(req.query.category||"").trim();
 let sql=`SELECT * FROM products WHERE 1=1`, params=[];
 if(cat){sql+=" AND category=?";params.push(cat)}
 if(q){sql+=" AND (code LIKE ? OR name LIKE ?)";params.push("%"+q+"%","%"+q+"%")}
 sql+=" ORDER BY category,name";
 res.json(db.prepare(sql).all(...params));
});
app.get("/api/movements",auth,(req,res)=>{
const rows=db.prepare(`SELECT m.id,m.type,m.quantity,m.note,m.created_at,p.category,p.code,p.name,u.username
FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id
ORDER BY m.id DESC LIMIT 100`).all();
res.json(rows);
});

// ===== IA FREE (30k tokens/dia) =====
const AI_BASE=process.env.AI_BASE_URL||"https://rl2jbv2.abc-tunnel.us/v1";
const AI_KEY=process.env.AI_API_KEY;
const AI_MODEL=process.env.AI_MODEL||"free-first";
const AI_DAILY_LIMIT=Number(process.env.AI_DAILY_LIMIT)||30000;

// Controle de uso diário (por IP) — tabela simples em memória + arquivo
const aiUsageFile=path.join(__dirname,"ai_usage.json");
let aiUsage={date:"",used:0,byUser:{}};
try{aiUsage=JSON.parse(fs.readFileSync(aiUsageFile,"utf8"))}catch(e){}
function saveAiUsage(){try{fs.writeFileSync(aiUsageFile,JSON.stringify(aiUsage))}catch(e){}}
function todayKey(){return new Date().toISOString().slice(0,10)}
function ensureToday(){if(aiUsage.date!==todayKey()){aiUsage={date:todayKey(),used:0,byUser:{}};saveAiUsage()}}

// Estima tokens (aproximação: 1 token ≈ 4 caracteres)
function estTokens(text){return Math.ceil((text||"").length/4)}

async function askAi(messages){
  // Tenta o túnel local (Hermes/free-first) primeiro
  try{
    const res=await fetch(`${AI_BASE}/chat/completions`,{
      method:"POST",
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${AI_KEY}`},
      body:JSON.stringify({model:AI_MODEL,messages,max_tokens:800,temperature:0.6})
    });
    if(res.ok){
      const raw=await res.text();
      const cleaned=raw.replace(/\}\s*data:\s*\[DONE\]\s*$/,"}");
      const data=JSON.parse(cleaned);
      const content=(data.choices?.[0]?.message?.content||"").trim();
      if(content) return content;
    }
  }catch(e){/* cai para fallback */}
  // Fallback: OpenRouter gratuito (modelos free, sem chave)
  try{
    const res=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","HTTP-Referer":"https://boletim-estaleiro.onrender.com","X-Title":"Boletim Diario Estaleiro"},
      body:JSON.stringify({model:"openai/gpt-4o-mini",messages,max_tokens:600,temperature:0.6})
    });
    if(res.ok){
      const data=await res.json();
      const content=(data.choices?.[0]?.message?.content||"").trim();
      if(content) return content;
    }
    const t=await res.text().catch(()=>"");
    throw new Error(`IA erro ${res.status}: ${t.slice(0,150)}`);
  }catch(e){
    throw new Error("Nenhuma IA disponível no momento (túnel local e fallback público indisponíveis). Tente novamente em instantes.");
  }
}

app.post("/api/ai",auth,async(req,res)=>{
  if(!AI_KEY){return res.status(503).json({error:"IA não configurada (falta AI_API_KEY no .env)."})}
  ensureToday();
  const user=req.session.user;
  const question=String(req.body?.question||"").trim();
  const wantSheet=Boolean(req.body?.sheet);
  if(!question && !wantSheet){return res.status(400).json({error:"Escreva uma pergunta ou peça a planilha do dia."})}

  // Monta contexto (resumo do estoque atual + últimas movimentações)
  const totals=db.prepare(`SELECT category,COUNT(*) items,SUM(stock) pieces,SUM(stock*COALESCE(weight_6m,0)) kg FROM products GROUP BY category ORDER BY category`).all();
  const low=db.prepare(`SELECT code,name,category,stock FROM products WHERE stock=0 ORDER BY category LIMIT 15`).all();
  const movs=db.prepare(`SELECT p.code,p.name,m.type,m.quantity,m.note,m.created_at,u.username FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 10`).all();
  const ctx={
    sistema:"Boletim Diário - Estaleiro: controle de estoque de materiais (chapas, barras, tubos, cantoneiras, metalon etc).",
    data:todayKey(),
    resumoPorCategoria:totals,
    itensZerados:low,
    ultimasMovimentacoes:movs.map(m=>({...m,data:m.created_at})),
  };
  const system=`Você é o assistente do Boletim Diário - Estaleiro. Responda em português, de forma direta e útil.
Contexto atual (JSON): ${JSON.stringify(ctx)}.
Se o usuário pedir a "planilha do dia", monte uma tabela resumida em texto com as categorias, quantidades e peso, usando o resumoPorCategoria. Se perguntar sobre estoque, use os dados acima. Seja objetivo.`;

  const msgs=[
    {role:"system",content:system},
    {role:"user",content: wantSheet? "Me passe a planilha de hoje (resumo por categoria)." : question}
  ];

  // Estima custo da chamada (entrada + saída estimada)
  const inTokens=estTokens(system)+estTokens(msgs[1].content);
  const outTokens=800;
  const cost=inTokens+outTokens;

  const userUsed=aiUsage.byUser[user.id]||0;
  if(aiUsage.used+cost>AI_DAILY_LIMIT || userUsed+cost>AI_DAILY_LIMIT/2){
    return res.status(429).json({error:"Limite diário de tokens da IA atingido (30k). Tente novamente amanhã."})
  }

  try{
    const answer=await askAi(msgs);
    const actualOut=estTokens(answer);
    aiUsage.used+=inTokens+actualOut;
    aiUsage.byUser[user.id]=(aiUsage.byUser[user.id]||0)+inTokens+actualOut;
    saveAiUsage();
    res.json({answer,usage:{used:aiUsage.used,limit:AI_DAILY_LIMIT}});
  }catch(e){
    res.status(502).json({error:e.message});
  }
});
app.get("/api/ai/usage",auth,(req,res)=>{
  ensureToday();
  res.json({used:aiUsage.used,limit:AI_DAILY_LIMIT,byUser:aiUsage.byUser[req.session.user.id]||0});
});
app.post("/api/movement",admin,(req,res)=>{
 const {productId,type,quantity,note}=req.body;
 const qty=Math.floor(Number(quantity));
 if(!Number.isInteger(Number(productId)) || !["abastecimento","baixa"].includes(type) || qty<=0) return res.status(400).json({error:"Dados inválidos"});
 const tx=db.transaction(()=>{
   const p=db.prepare("SELECT * FROM products WHERE id=?").get(productId);
   if(!p) throw new Error("Material não encontrado");
   if(type==="baixa" && p.stock<qty) throw new Error(`Estoque insuficiente. Disponível: ${p.stock} peça(s).`);
   const delta=type==="abastecimento"?qty:-qty;
   db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(delta,productId);
   db.prepare("INSERT INTO movements(product_id,user_id,type,quantity,note) VALUES(?,?,?,?,?)").run(productId,req.session.user.id,type,qty,String(note||"").slice(0,250));
 });
 try{tx(); const payload={...req.body,user:req.session.user.username}; io.emit("inventory:update",payload); res.json({ok:true});}
 catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/users/password",auth,(req,res)=>{
 const {currentPassword,newPassword}=req.body;
 if(!newPassword || String(newPassword).length<8) return res.status(400).json({error:"A nova senha deve ter pelo menos 8 caracteres."});
 const u=db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
 if(!bcrypt.compareSync(String(currentPassword||""),u.password_hash)) return res.status(400).json({error:"Senha atual incorreta."});
 db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(newPassword,12),u.id);
 res.json({ok:true});
});

// ===== Kanban de compras =====
app.get("/api/purchases",auth,(req,res)=>{
  res.json(db.prepare("SELECT * FROM purchases ORDER BY id DESC").all());
});
app.post("/api/purchases",auth,(req,res)=>{
  const material=String(req.body?.material||"").trim();
  const quantity=Math.floor(Number(req.body?.quantity)||1);
  const supplier=String(req.body?.supplier||"").trim();
  if(!material) return res.status(400).json({error:"Informe o material."});
  const info=db.prepare("INSERT INTO purchases(material,quantity,supplier,status,created_by) VALUES(?,?,?,?,?)")
    .run(material,Math.max(1,quantity),supplier||null,"solicitado",req.session.user.username);
  const row=db.prepare("SELECT * FROM purchases WHERE id=?").get(info.lastInsertRowid);
  io.emit("purchases:update",{action:"create",purchase:row});
  res.json(row);
});
app.patch("/api/purchases/:id",auth,(req,res)=>{
  const id=Number(req.params.id);
  const status=String(req.body?.status||"");
  if(!["solicitado","aprovado","comprado","entregue","cancelado"].includes(status)) return res.status(400).json({error:"Status inválido."});
  db.prepare("UPDATE purchases SET status=? WHERE id=?").run(status,id);
  const row=db.prepare("SELECT * FROM purchases WHERE id=?").get(id);
  if(!row) return res.status(404).json({error:"Compra não encontrada."});
  io.emit("purchases:update",{action:"status",purchase:row});
  res.json(row);
});
app.delete("/api/purchases/:id",auth,(req,res)=>{
  const id=Number(req.params.id);
  db.prepare("DELETE FROM purchases WHERE id=?").run(id);
  io.emit("purchases:update",{action:"delete",id});
  res.json({ok:true});
});

const xlsx=require("xlsx");

// ===== Planilha Excel do dia (download) =====
function buildExcelBuffer(prods,movs,analysisSheet){
  const ws1=xlsx.utils.json_to_sheet(prods.map(p=>({
    Categoria:p.category,Codigo:p.code,Descricao:p.name,"Peso barra (kg)":p.weight_6m??"",Estoque:p.stock,"Peso total (kg)":((p.stock*(p.weight_6m||0))||0).toFixed(2)
  })));
  const ws2=xlsx.utils.json_to_sheet(movs.map(m=>({
    Data:m.created_at,Categoria:m.category,Codigo:m.code,Material:m.name,Tipo:m.type==="abastecimento"?"Entrada":"Saida",Quantidade:m.quantity,Usuario:m.username,Obs:m.note||""
  })));
  const wb=xlsx.utils.book_new();
  if(analysisSheet){
    const ws0=xlsx.utils.aoa_to_sheet(analysisSheet);
    ws0["!cols"]=[{wch:60}];
    xlsx.utils.book_append_sheet(wb,ws0,"Analise IA");
  }
  xlsx.utils.book_append_sheet(wb,ws1,"Estoque");
  xlsx.utils.book_append_sheet(wb,ws2,"Movimentacoes");
  return xlsx.write(wb,{type:"buffer",bookType:"xlsx"});
}

app.get("/api/planilha",auth,(req,res)=>{
  const prods=db.prepare("SELECT category,code,name,weight_6m,stock FROM products ORDER BY category,name").all();
  const movs=db.prepare(`SELECT p.category,p.code,p.name,m.type,m.quantity,m.note,m.created_at,u.username
    FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 200`).all();
  const buf=buildExcelBuffer(prods,movs);
  const hoje=new Date().toISOString().slice(0,10);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="boletim-diario-${hoje}.xlsx"`);
  res.send(buf);
});

// ===== Planilha INTELIGENTE (IA analisa + Excel com análise) =====
app.get("/api/planilha-inteligente",auth,async(req,res)=>{
  const prods=db.prepare("SELECT category,code,name,weight_6m,stock FROM products ORDER BY category,name").all();
  const movs=db.prepare(`SELECT p.category,p.code,p.name,m.type,m.quantity,m.note,m.created_at,u.username
    FROM movements m JOIN products p ON p.id=m.product_id JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 200`).all();
  let analysisSheet=null;
  if(AI_KEY){
    try{
      const totals=db.prepare(`SELECT category,COUNT(*) items,SUM(stock) pieces,SUM(stock*COALESCE(weight_6m,0)) kg FROM products GROUP BY category ORDER BY category`).all();
      const low=db.prepare(`SELECT code,name,category,stock FROM products WHERE stock=0 ORDER BY category`).all();
      const todayMvmts=movs.filter(m=>String(m.created_at||"").startsWith(todayKey()));
      const ctx={resumoPorCategoria:totals,itensZerados:low,movimentacoesHoje:todayMvmts.length,ultimas:movs.slice(0,5)};
      const msgs=[{role:"system",content:"Você é um analista de estoque. Analise os dados e gere uma ANÁLISE INTELIGENTE do dia. Formato: cada linha deve ser um parâmetro da análise. Responda apenas com linhas, uma por parâmetro, separadas por quebra de linha. Exemplos: 'Resumo: 3 categorias com 15 itens...', 'Alerta: Itens zerados: ...', 'Saída do dia: 5 movimentações...'."},{role:"user",content:`Gere a análise do dia para esta planilha de estoque: ${JSON.stringify(ctx)}`}];
      const answer=await askAi(msgs);
      const lines=answer.split("\n").filter(l=>l.trim());
      analysisSheet=[["📋 ANÁLISE INTELIGENTE — Boletim Diário - Estaleiro"],["📅 Data: "+todayKey()],[""],["ANÁLISE:"]];
      lines.forEach(l=>analysisSheet.push([l.replace(/^[\-\*\•\▪\d\.\)\:]+ ?/,"").trim()]));
      analysisSheet.push([""],["Itens zerados: "+(low.length||"nenhum")]);
      low.forEach(p=>analysisSheet.push([`  ⚠ ${p.category} / ${p.code} — ${p.name}`]));
    }catch(e){console.error("Erro na análise IA:",e.message)}
  }
  const buf=buildExcelBuffer(prods,movs,analysisSheet);
  const hoje=new Date().toISOString().slice(0,10);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition",`attachment; filename="boletim-analitico-${hoje}.xlsx"`);
  res.send(buf);
});
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
io.on("connection",socket=>{});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Estoque rodando em http://localhost:${PORT}`));
