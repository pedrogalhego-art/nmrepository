# Controle de Estoque — tempo real

Sistema web para os materiais da planilha, com:
- Login por usuário;
- perfil **Administrador**: abastecimento e baixa;
- perfil **Projeto**: consulta somente leitura;
- estoque atualizado em tempo real via Socket.IO;
- histórico de movimentações com usuário, data, quantidade e observação;
- categorias em ticker estilo mercado financeiro;
- peso estimado por barras de 6 m;
- busca por código/descrição e filtro por categoria;
- SQLite local para persistência.

## Rodar no Windows

1. Instale Node.js LTS.
2. Extraia esta pasta.
3. Abra o Prompt/PowerShell dentro dela.
4. Execute:
   `npm install`
5. Copie `.env.example` para `.env` e troque `SESSION_SECRET` e as senhas.
6. Execute:
   `npm start`
7. Acesse `http://localhost:3000`.

### Usuários iniciais
- Administrador: `admin` / `admin123`
- Projeto: `projeto` / `projeto123`

**Troque as senhas antes de colocar em uso.** O banco `estoque.db` é criado automaticamente.

## Publicação
Para usar em vários computadores da empresa, rode o servidor em uma máquina/VPS acessível pela rede e coloque HTTPS/reverse proxy na frente. O sistema foi preparado para funcionar como aplicação web centralizada; não é necessário instalar o banco nos computadores dos usuários.

## Observação
As quantidades iniciais dos produtos são 0 porque a planilha fornecida contém os cadastros e pesos, mas não trazia estoque inicial preenchido. O administrador deve realizar o primeiro abastecimento pelo sistema.
