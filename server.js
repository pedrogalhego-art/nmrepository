require("dotenv").config();
const express=require("express");
const http=require("http");
const path=require("path");
const session=require("express-session");
const SqliteStore=require("better-sqlite3-session-store")(session);
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
 unit TEXT NOT NULL DEFAULT 'barra',
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
 CREATE TABLE IF NOT EXISTS chat_teams(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT DEFAULT '🏢'
 );
 CREATE TABLE IF NOT EXISTS chat_team_members(
  team_id INTEGER REFERENCES chat_teams(id),
  user_id INTEGER REFERENCES users(id),
  PRIMARY KEY(team_id,user_id)
 );
 CREATE TABLE IF NOT EXISTS chat_conversations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'team',
  name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS chat_participants(
  conversation_id INTEGER REFERENCES chat_conversations(id),
  user_id INTEGER REFERENCES users(id),
  last_read_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(conversation_id,user_id)
 );
 CREATE TABLE IF NOT EXISTS chat_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
 );
 `);
 // Seed equipes padrão
 const defaultTeams=[{name:'Produção',icon:'🏭'},{name:'Expedição',icon:'📦'},{name:'Compras',icon:'🛒'},{name:'Almoxarifado',icon:'🔧'},{name:'Administração',icon:'📋'},{name:'Manutenção',icon:'🛠️'},{name:'Projeto',icon:'📐'}];
 const insTeam=db.prepare('INSERT OR IGNORE INTO chat_teams(name,icon) VALUES(?,?)');
 defaultTeams.forEach(t=>insTeam.run(t.name,t.icon));
 // Todos os usuários existentes entram como membros das equipes padrão (admin ajusta depois)
 const allUsers=db.prepare("SELECT id FROM users").all();
 const addMember=db.prepare("INSERT OR IGNORE INTO chat_team_members(team_id,user_id) SELECT id,? FROM chat_teams");
 allUsers.forEach(u=>addMember.run(u.id));
// Sincroniza conversas de equipe: todos os usuários participam (projeto e admin conversam entre si)
const teamConvs=db.prepare("SELECT c.id FROM chat_conversations c WHERE c.type='team'").all();
const syncConv=db.prepare("INSERT OR IGNORE INTO chat_participants(conversation_id,user_id) SELECT ?,id FROM users");
teamConvs.forEach(c=>syncConv.run(c.id));
// Migração: garantir coluna unit em produtos (banco antigo não tem)
const prodCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
if (!prodCols.includes("unit")) {
  db.exec("ALTER TABLE products ADD COLUMN unit TEXT NOT NULL DEFAULT 'barra'");
}

const categoryUnit = cat => {
  const c = String(cat).toLowerCase();
  if (c.includes("chapa")) return "chapa";
  if (c.includes("tubo")) return "tubo";
  if (c.includes("cantoneira")) return "cantoneira";
  if (c.includes("viga")) return "viga";
  if (c.includes("metalon")) return "barra";
  return "barra";
};
// Restaura backup se o banco estiver vazio (disco efêmero do Render)
try{
  const bck=JSON.parse(fs.readFileSync(BACKUP_FILE,"utf8"));
  const userCount=db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const prodCount=db.prepare("SELECT COUNT(*) c FROM products").get().c;
  if(userCount===0 && prodCount===0 && Array.isArray(bck.products) && bck.products.length>0){
    console.log("[backup] Restaurando banco do backup de", bck.exported_at);
    const insU=db.prepare("INSERT OR IGNORE INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)");
    (bck.users||[]).forEach(u=>insU.run(u.id,u.username,u.password_hash,u.role,u.created_at));
    const hashU=db.prepare("UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE username='admin' LIMIT 1) WHERE username=?");
    (bck.users||[]).forEach(u=>{ /* preserver senhas: re-insere com hash padrao? melhor: nao mexer */ });
    const insP=db.prepare("INSERT OR IGNORE INTO products(id,category,code,name,weight_6m,unit,stock) VALUES(?,?,?,?,?,?,?)");
    (bck.products||[]).forEach(p=>insP.run(p.id,p.category,p.code,p.name,p.weight_6m,p.unit,p.stock));
    const insM=db.prepare("INSERT OR IGNORE INTO movements(id,product_id,user_id,type,quantity,note,created_at) VALUES(?,?,?,?,?,?,?)");
    (bck.movements||[]).forEach(m=>insM.run(m.id,m.product_id,m.user_id,m.type,m.quantity,m.note,m.created_at));
    const insPu=db.prepare("INSERT OR IGNORE INTO purchases(id,material,quantity,supplier,status,created_by,created_at) VALUES(?,?,?,?,?,?,?)");
    (bck.purchases||[]).forEach(p=>insPu.run(p.id,p.material,p.quantity,p.supplier,p.status,p.created_by,p.created_at));
    const insT=db.prepare("INSERT OR IGNORE INTO chat_teams(id,name,icon) VALUES(?,?,?)");
    (bck.chat_teams||[]).forEach(t=>insT.run(t.id,t.name,t.icon));
    const insTm=db.prepare("INSERT OR IGNORE INTO chat_team_members(team_id,user_id) VALUES(?,?)");
    (bck.chat_team_members||[]).forEach(m=>insTm.run(m.team_id,m.user_id));
    const insC=db.prepare("INSERT OR IGNORE INTO chat_conversations(id,type,name,created_at) VALUES(?,?,?,?)");
    (bck.chat_conversations||[]).forEach(c=>insC.run(c.id,c.type,c.name,c.created_at));
    const insCp=db.prepare("INSERT OR IGNORE INTO chat_participants(conversation_id,user_id,last_read_at) VALUES(?,?,?)");
    (bck.chat_participants||[]).forEach(p=>insCp.run(p.conversation_id,p.user_id,p.last_read_at));
    const insCm=db.prepare("INSERT OR IGNORE INTO chat_messages(id,conversation_id,user_id,content,created_at) VALUES(?,?,?,?,?)");
    (bck.chat_messages||[]).forEach(m=>insCm.run(m.id,m.conversation_id,m.user_id,m.content,m.created_at));
    console.log("[backup] Restaurado:",bck.products.length,"produtos,",(bck.movements||[]).length,"movimentações");
  } else if (userCount>0){
    // banco ja tem dados; nada a fazer
  }
}catch(e){ console.log("[backup] Sem backup para restaurar ou erro:",e.message); }


const products=JSON.parse(fs.readFileSync(path.join(__dirname,"products.json"),"utf8"));
const insertProduct=db.prepare(`INSERT INTO products(category,code,name,weight_6m,unit) VALUES(?,?,?,?,?) ON CONFLICT(category,code) DO UPDATE SET name=excluded.name, weight_6m=excluded.weight_6m, unit=excluded.unit`);
const seedProducts=db.transaction(()=>{
  Object.entries(products).forEach(([cat,items])=>{
    const u = categoryUnit(cat);
    items.forEach(p=>insertProduct.run(cat,p.code,p.name,p.weight_6m,u));
    db.prepare("UPDATE products SET unit=? WHERE category=?").run(u, cat);
  });
});
seedProducts();


// ===== Backup automático do banco (persistência entre deploys do Render) =====
// O disco do Render gratuito é efêmero: o estoque.db é zerado a cada deploy.
// Solução: exporta o banco inteiro para um JSON versionado e restaura no boot.
const BACKUP_FILE=path.join(__dirname,"db_backup.json");
const BACKUP_EVERY_MS=Number(process.env.BACKUP_EVERY_MS)||10*60*1000; // 10 min
function exportDbJson(){
  try{
    const dump={
      exported_at:new Date().toISOString(),
      users:db.prepare("SELECT id,username,password_hash,role,created_at FROM users").all(),
      products:db.prepare("SELECT id,category,code,name,weight_6m,unit,stock FROM products").all(),
      movements:db.prepare("SELECT id,product_id,user_id,type,quantity,note,created_at FROM movements").all(),
      purchases:db.prepare("SELECT * FROM purchases").all(),
      chat_teams:db.prepare("SELECT * FROM chat_teams").all(),
      chat_team_members:db.prepare("SELECT * FROM chat_team_members").all(),
      chat_conversations:db.prepare("SELECT * FROM chat_conversations").all(),
      chat_participants:db.prepare("SELECT * FROM chat_participants").all(),
      chat_messages:db.prepare("SELECT * FROM chat_messages").all(),
    };
    const tmp=BACKUP_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(dump,null,1));
    fs.renameSync(tmp,BACKUP_FILE);
    return true;
  }catch(e){
    console.error("Backup falhou:",e.message);
    return false;
  }
}
// Backup imediato e periódico
try{exportDbJson()}catch(e){}
setInterval(exportDbJson, BACKUP_EVERY_MS);


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
 store:new SqliteStore({client:db,expired:{clear:true,intervalMs:900000}}),
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
const AIML_KEY=process.env.AIMLAPI_KEY;               // AIMLAPI (fallback)
const AIML_BASE=process.env.AIMLAPI_BASE||"https://api.aimlapi.com/v1";
const AIML_MODEL=process.env.AIMLAPI_MODEL||"openai/gpt-4o";
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
  // Fallback 2: AIMLAPI (1000+ modelos, usa chave se configurada)
  if(AIML_KEY){
    try{
      const res=await fetch(`${AIML_BASE}/chat/completions`,{
        method:"POST",
        headers:{"Content-Type":"application/json",Authorization:`Bearer ${AIML_KEY}`},
        body:JSON.stringify({model:AIML_MODEL,messages,max_tokens:600,temperature:0.6})
      });
      if(res.ok){
        const data=await res.json();
        const content=(data.choices?.[0]?.message?.content||"").trim();
        if(content) return content;
      }
    }catch(e){/* cai para OpenRouter */}
  }
  // Fallback 3: OpenRouter gratuito (modelos free, sem chave)
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
 try{tx(); const payload={...req.body,user:req.session.user.username}; io.emit("inventory:update",payload); exportDbJson(); res.json({ok:true});}
 catch(e){res.status(400).json({error:e.message});}
});

app.post("/api/users",admin,(req,res)=>{
  const username=String(req.body?.username||"").trim();
  const password=String(req.body?.password||"");
  const role=String(req.body?.role||"projeto");
  if(!username||password.length<6) return res.status(400).json({error:"Usuário e senha (mín. 6) são obrigatórios"});
  if(!["admin","projeto"].includes(role)) return res.status(400).json({error:"Role inválido"});
  try{
    const info=db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run(username,bcrypt.hashSync(password,12),role);
    res.json({id:Number(info.lastInsertRowid),username,role});
  }catch(e){res.status(400).json({error:"Usuário já existe"})}
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
    Categoria:p.category,Codigo:p.code,Descricao:p.name,"Peso unitario (kg)":p.weight_6m??"",Estoque:p.stock,"Peso total (kg)":((p.stock*(p.weight_6m||0))||0).toFixed(2)
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
// ===== Chat Interno API =====
app.post("/api/chat/teams",admin,(req,res)=>{
  const name=String(req.body?.name||"").trim();
  const icon=String(req.body?.icon||"🏢").trim();
  if(!name) return res.status(400).json({error:"Nome da equipe obrigatório"});
  try{
    const info=db.prepare("INSERT INTO chat_teams(name,icon) VALUES(?,?)").run(name,icon);
    res.json({id:Number(info.lastInsertRowid),name,icon});
  }catch(e){res.status(400).json({error:"Equipe já existe"})}
});
app.route("/api/chat/teams/:id/members")
  .get(auth,(req,res)=>{
    const teamId=Number(req.params.id);
    const members=db.prepare(`SELECT u.id,u.username,u.role FROM users u JOIN chat_team_members m ON m.user_id=u.id WHERE m.team_id=? ORDER BY u.username`).all(teamId);
    res.json(members);
  })
  .post(admin,(req,res)=>{
    const teamId=Number(req.params.id);
    const userId=Number(req.body?.userId);
    if(!userId) return res.status(400).json({error:"userId obrigatório"});
    db.prepare("INSERT OR IGNORE INTO chat_team_members(team_id,user_id) VALUES(?,?)").run(teamId,userId);
    res.json({ok:true});
  })
  .delete(admin,(req,res)=>{
    const teamId=Number(req.params.id);
    const userId=Number(req.body?.userId);
    db.prepare("DELETE FROM chat_team_members WHERE team_id=? AND user_id=?").run(teamId,userId);
    res.json({ok:true});
  });
app.get("/api/chat/teams",auth,(req,res)=>{
  const teams=db.prepare("SELECT * FROM chat_teams ORDER BY name").all();
  res.json(teams);
});
app.get("/api/chat/users",auth,(req,res)=>{
  const users=db.prepare("SELECT id,username,role FROM users ORDER BY username").all();
  res.json(users);
});
app.get("/api/chat/conversations",auth,(req,res)=>{
  const userId=req.session.user.id;
  const convs=db.prepare(`
    SELECT c.id,c.type,c.name,c.created_at,
      (SELECT content FROM chat_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) as last_message,
      (SELECT u.username FROM chat_messages m2 JOIN users u ON u.id=m2.user_id WHERE m2.conversation_id=c.id ORDER BY m2.id DESC LIMIT 1) as last_sender,
      (SELECT created_at FROM chat_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) as last_message_at,
      (SELECT COUNT(*) FROM chat_messages WHERE conversation_id=c.id AND user_id!=? AND created_at>COALESCE((SELECT last_read_at FROM chat_participants WHERE conversation_id=c.id AND user_id=?),'1970-01-01')) as unread_count
    FROM chat_conversations c
    INNER JOIN chat_participants cp ON cp.conversation_id=c.id AND cp.user_id=?
    ORDER BY last_message_at DESC NULLS LAST
  `).all(userId,userId,userId);
  res.json(convs);
});
app.post("/api/chat/conversations",auth,(req,res)=>{
  const {type,name,team_id,participant_ids}=req.body;
  const userId=req.session.user.id;
  const convType=type||"direct";
  if(convType==="direct" && participant_ids && participant_ids.length===1){
    const otherId=participant_ids[0];
    if(otherId===userId) return res.status(400).json({error:"Nao pode criar conversa consigo mesmo"});
    const existing=db.prepare(`SELECT c.id FROM chat_conversations c WHERE c.type='direct' AND EXISTS (SELECT 1 FROM chat_participants WHERE conversation_id=c.id AND user_id=?) AND EXISTS (SELECT 1 FROM chat_participants WHERE conversation_id=c.id AND user_id=?)`).get(userId,otherId);
    if(existing) return res.json({id:existing.id,type:"direct"});
  }
  const info=db.prepare("INSERT INTO chat_conversations(type,name) VALUES(?,?)").run(convType,name||null);
  const convId=Number(info.lastInsertRowid);
  const addP=db.prepare("INSERT OR IGNORE INTO chat_participants(conversation_id,user_id) VALUES(?,?)");
  addP.run(convId,userId);
  if(convType==="team"){
    db.prepare("INSERT OR IGNORE INTO chat_participants(conversation_id,user_id) SELECT ?,id FROM users").run(convId);
  } else if(participant_ids){
    participant_ids.forEach(pid=>addP.run(convId,pid));
  }
  const conv=db.prepare("SELECT * FROM chat_conversations WHERE id=?").get(convId);
  res.json(conv);
});
app.get("/api/chat/conversations/:id/messages",auth,(req,res)=>{
  const convId=Number(req.params.id),userId=req.session.user.id;
  const participant=db.prepare("SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?").get(convId,userId);
  if(!participant) return res.status(403).json({error:"Acesso negado"});
  const limit=Math.min(Number(req.query.limit)||50,200);
  const before=req.query.before;
  let sql="SELECT m.id,m.conversation_id,m.user_id,m.content,m.created_at,u.username FROM chat_messages m JOIN users u ON u.id=m.user_id WHERE m.conversation_id=?";
  const params=[convId];
  if(before){sql+=" AND m.id<?";params.push(Number(before));}
  sql+=" ORDER BY m.id DESC LIMIT ?";
  params.push(limit);
  const messages=db.prepare(sql).all(...params).reverse();
  res.json(messages);
});
const chatRateLimit={}; // anti-spam: 1 msg a cada 600ms por usuário
app.post("/api/chat/conversations/:id/messages",auth,(req,res)=>{
  const convId=Number(req.params.id),userId=req.session.user.id;
  const now=Date.now();
  if(chatRateLimit[userId] && now-chatRateLimit[userId]<600) return res.status(429).json({error:"Aguarde um instante antes de enviar outra mensagem."});
  chatRateLimit[userId]=now;
  const raw=String(req.body?.content||"").trim();
  if(!raw) return res.status(400).json({error:"Mensagem vazia"});
  if(raw.length>2000) return res.status(400).json({error:"Mensagem muito longa"});
  const participant=db.prepare("SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?").get(convId,userId);
  if(!participant) return res.status(403).json({error:"Acesso negado"});
  const safe=raw.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const info=db.prepare("INSERT INTO chat_messages(conversation_id,user_id,content) VALUES(?,?,?)").run(convId,userId,safe);
  const msg=db.prepare("SELECT m.id,m.conversation_id,m.user_id,m.content,m.created_at,u.username FROM chat_messages m JOIN users u ON u.id=m.user_id WHERE m.id=?").get(Number(info.lastInsertRowid));
  io.to("chat:"+convId).emit("chat:message",msg);
  res.json(msg);
});
app.delete("/api/chat/messages/:msgId",auth,(req,res)=>{
  const msgId=Number(req.params.msgId);
  const msg=db.prepare("SELECT * FROM chat_messages WHERE id=?").get(msgId);
  if(!msg) return res.status(404).json({error:"Mensagem não encontrada"});
  const isAdmin=req.session.user.role==="admin";
  const isOwner=msg.user_id===req.session.user.id;
  if(!isAdmin && !isOwner) return res.status(403).json({error:"Sem permissão para apagar esta mensagem"});
  db.prepare("DELETE FROM chat_messages WHERE id=?").run(msgId);
  io.to("chat:"+msg.conversation_id).emit("chat:message-deleted",{id:msgId,conversation_id:msg.conversation_id});
  res.json({ok:true});
});

app.post("/api/chat/conversations/:id/read",auth,(req,res)=>{
  const convId=Number(req.params.id),userId=req.session.user.id;
  db.prepare("UPDATE chat_participants SET last_read_at=datetime('now') WHERE conversation_id=? AND user_id=?").run(convId,userId);
  res.json({ok:true});
});

app.get("/api/backup/download",admin,(req,res)=>{
  try{
    const bck=JSON.parse(fs.readFileSync(BACKUP_FILE,"utf8"));
    res.setHeader("Content-Type","application/json");
    res.setHeader("Content-Disposition",'attachment; filename="db_backup.json"');
    res.send(bck);
  }catch(e){
    res.status(404).json({error:"Backup ainda não gerado"});
  }
});

function applyBackup(bck){
  const tx=db.transaction(()=>{
    // Limpa tudo (menos nao da pra dropar com FK, mas vamos DELETE)
    db.prepare("DELETE FROM chat_messages").run();
    db.prepare("DELETE FROM chat_participants").run();
    db.prepare("DELETE FROM chat_conversations").run();
    db.prepare("DELETE FROM chat_team_members").run();
    db.prepare("DELETE FROM chat_teams").run();
    db.prepare("DELETE FROM purchases").run();
    db.prepare("DELETE FROM movements").run();
    db.prepare("DELETE FROM products").run();
    db.prepare("DELETE FROM users").run();
    // Reinsere em ordem de FK
    const insU=db.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)");
    (bck.users||[]).forEach(u=>insU.run(u.id,u.username,u.password_hash||(u.role==='admin'?bcrypt.hashSync(process.env.ADMIN_PASSWORD||'admin123',12):bcrypt.hashSync('projeto123',12)),u.role,u.created_at));
    const insT=db.prepare("INSERT OR IGNORE INTO chat_teams(id,name,icon) VALUES(?,?,?)");
    (bck.chat_teams||[]).forEach(t=>insT.run(t.id,t.name,t.icon));
    const insP=db.prepare("INSERT INTO products(id,category,code,name,weight_6m,unit,stock) VALUES(?,?,?,?,?,?,?)");
    (bck.products||[]).forEach(p=>insP.run(p.id,p.category,p.code,p.name,p.weight_6m,p.unit,p.stock));
    const insM=db.prepare("INSERT INTO movements(id,product_id,user_id,type,quantity,note,created_at) VALUES(?,?,?,?,?,?,?)");
    (bck.movements||[]).forEach(m=>insM.run(m.id,m.product_id,m.user_id,m.type,m.quantity,m.note,m.created_at));
    const insPu=db.prepare("INSERT INTO purchases(id,material,quantity,supplier,status,created_by,created_at) VALUES(?,?,?,?,?,?,?)");
    (bck.purchases||[]).forEach(p=>insPu.run(p.id,p.material,p.quantity,p.supplier,p.status,p.created_by,p.created_at));
    const insTm=db.prepare("INSERT OR IGNORE INTO chat_team_members(team_id,user_id) VALUES(?,?)");
    (bck.chat_team_members||[]).forEach(m=>insTm.run(m.team_id,m.user_id));
    const insC=db.prepare("INSERT INTO chat_conversations(id,type,name,created_at) VALUES(?,?,?,?)");
    (bck.chat_conversations||[]).forEach(c=>insC.run(c.id,c.type,c.name,c.created_at));
    const insCp=db.prepare("INSERT OR IGNORE INTO chat_participants(conversation_id,user_id,last_read_at) VALUES(?,?,?)");
    (bck.chat_participants||[]).forEach(p=>insCp.run(p.conversation_id,p.user_id,p.last_read_at||"now"));
    const insCm=db.prepare("INSERT INTO chat_messages(id,conversation_id,user_id,content,created_at) VALUES(?,?,?,?,?)");
    (bck.chat_messages||[]).forEach(m=>insCm.run(m.id,m.conversation_id,m.user_id,m.content,m.created_at));
  });
  tx();
  exportDbJson();
}

app.post("/api/backup/restore",admin,(req,res)=>{
  try{
    const bck=req.body;
    if(!bck || !Array.isArray(bck.products)) return res.status(400).json({error:"Backup inválido"});
    applyBackup(bck);
    res.json({ok:true,restored:bck.products.length+" produtos, "+(bck.movements||[]).length+" movimentações"});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});


app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
io.on("connection",socket=>{
  socket.on("chat:join",({conversationId})=>{socket.join("chat:"+conversationId);});
  socket.on("chat:leave",({conversationId})=>{socket.leave("chat:"+conversationId);});
  socket.on("chat:typing",({conversationId,username})=>{socket.to("chat:"+conversationId).emit("chat:typing",{conversationId,username});});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Estoque rodando em http://localhost:${PORT}`));
