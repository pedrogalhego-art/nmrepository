# Boletim Diário - Estaleiro — Deploy no Render

Passo a passo para colocar o site no ar (gratuito).

## 1. Subir o código para o GitHub

No computador, na pasta do projeto:

```bash
cd C:\Users\Administrator\Downloads\estoque
git init
git add .
git commit -m "Boletim Diario Estaleiro v1.0.1"
```

Depois crie um repositório no GitHub (ex.: `boletim-estaleiro`) e:

```bash
git remote add origin https://github.com/SEU_USUARIO/boletim-estaleiro.git
git branch -M main
git push -u origin main
```

## 2. Criar o serviço no Render

1. Acesse https://dashboard.render.com e faça login (já criado).
2. Clique em **New +** → **Blueprint** (usa o `render.yaml` que já está no projeto).
3. Autorize o Render a acessar seu GitHub e escolha o repositório.
4. Confirme o deploy. O Render lê o `render.yaml` sozinho e sobe o serviço.

> Se não quiser usar Blueprint: **New +** → **Web Service**, escolha o repo,
> runtime **Node**, build `npm install --omit=dev`, start `node server.js`,
> e adicione as variáveis abaixo.

## 3. Configurar variáveis de ambiente

No painel do serviço, aba **Environment**:

| Variável | Valor |
|---|---|
| `SESSION_SECRET` | gere uma chave longa aleatória |
| `ADMIN_PASSWORD` | senha do admin (só vale na 1ª criação do banco) |
| `PROJETO_PASSWORD` | senha do usuário projeto |
| `AI_API_KEY` | chave da IA (opcional — sem ela a IA fica desativada) |
| `AI_BASE_URL` | URL pública da API da IA (veja nota) |
| `AI_MODEL` | `free-first` |

**Nota sobre a IA:** o `AI_BASE_URL` padrão no código aponta para um túnel
local — ele só funciona enquanto o PC de origem estiver ligado. No Render você
precisa de um endpoint público da mesma API. Se não tiver, deixe `AI_API_KEY`
vazio e o chat exibe "IA não configurada".

## 4. Banco de dados — IMPORTANTE

O Render (plano grátis) tem **disco efêmero**: ele é apagado a cada novo deploy.
Como o sistema usa SQLite em arquivo, **todos os dados (estoque, movimentos,
compras) são perdidos quando você faz deploy novo**.

Soluções:
- **Manter os dados**: use um banco externo (ex.: Supabase/Postgres grátis) —
  precisaria adaptar o código.
- **Aceitar reset**: ok se os dados são recarregados do `products.json` a cada
  deploy (os produtos sempre voltam, mas movimentações/usuários/customizações não).

## 5. Acessar

Após o deploy, o Render dá uma URL tipo `https://boletim-estaleiro.onrender.com`.
Use essa URL para acessar (login: usuário que você definiu em `ADMIN_PASSWORD`/`PROJETO_PASSWORD`).

## Dicas

- Plano grátis do Render "dorme" depois de 15 min sem uso; o primeiro acesso
  depois disso demora ~30-60s para acordar.
- Para Socket.IO em tempo real, o Render suporta websockets normalmente (HTTP/1.1).
- Se quiser domínio próprio, configure no painel (a partir do plano pago).

---

VERSÃO 1.0.1 — Boletim Diário - Estaleiro