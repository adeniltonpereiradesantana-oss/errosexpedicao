# Controle de Erros de Expedição (Google Apps Script) — v1.3.1

**Banco novo:** planilha `Controle de Erros Web - Base` em Meu Drive > Painel - Logística (já criada).
**Colaboradores:** lidos (somente leitura) da aba `Colaboradores` da planilha `RH Inteligente Web - Base` (Atestados-1005217).
A planilha antiga `Controle de Erros` não é alterada.

## 1. Colar o código
1. Abra a planilha **Controle de Erros Web - Base** → **Extensões > Apps Script**.
2. Crie os arquivos abaixo com estes nomes exatos e cole o conteúdo de cada um:

| Tipo | Nome no editor | Arquivo |
|---|---|---|
| Script | `Code` | Code.gs |
| Script | `Auth` | Auth.gs |
| Script | `Colaboradores` | Colaboradores.gs |
| Script | `Lancamentos` | Lancamentos.gs |
| Script | `Painel` | Painel.gs |
| Script | `Admin` | Admin.gs |
| HTML | `Index` | Index.html |
| HTML | `Css` | Css.html |
| HTML | `Js` | Js.html |

3. **Configurações do projeto** (engrenagem) → marque *Mostrar o arquivo de manifesto "appsscript.json"* → cole o conteúdo de `appsscript.json`.
4. Salve (Ctrl+S).

## 2. Instalar
1. Volte para a planilha e recarregue a página (F5). Aparece o menu **Controle de Erros**.
2. **Controle de Erros > 1. Instalar / configurar sistema** → autorize → informe **seu código produtivo** (se ele existir em mais de uma empresa, o sistema pergunta qual) e crie a **senha do administrador**.
3. **Controle de Erros > Testar leitura de colaboradores** → confira se as colunas (código produtivo, nome, filial, situação, equipe) foram encontradas e se as filiais aparecem com o nome (e não um código).
   Se alguma coluna não for encontrada, ajuste a lista `CAMPOS_RH` no topo de `Colaboradores.gs`.
4. (Opcional) **Controle de Erros > 2. Importar histórico da planilha antiga** — traz os lançamentos da planilha antiga (pode rodar mais de uma vez sem duplicar).

> Já instalou uma versão anterior? Depois do push, rode **Controle de Erros > Atualizar estrutura das abas**. Não apaga nada.

> Alternativa sem a planilha aberta: no editor, ajuste `ADMIN_INICIAL_EMPRESA` e `ADMIN_INICIAL_COD` em `Admin.gs` e rode `instalarPeloEditor`. O código de liberação do admin aparece no *Registro de execução*.

## 3. Publicar
**Implantar > Nova implantação > App da Web** → Executar como: **Eu** · Quem pode acessar: **Qualquer pessoa** → Implantar.
Use a URL `/exec` no portal appsistems.
**Link por filial:** acrescente `?empresa=NOME` para a empresa já vir escolhida no login, ex.: `…/exec?empresa=CARUARU` (maiúsculas, acentos e espaços não importam; espaço na URL = `%20`). Toda alteração no código depois exige **Gerenciar implantações > editar > Nova versão**.

## Como funciona
| Perfil | Acesso |
|---|---|
| **User** | Tela de lançamento (só colaboradores da própria filial). Pode excluir o próprio lançamento em até 15 min. |
| **Gestor** | Lançamento + Painel gerencial (período, filtros, CSV/PDF completo e por colaborador) + Usuários: libera primeiro acesso, reseta senha e bloqueia os Users da sua filial. Cancela lançamentos com motivo. |
| **Admin** | Tudo: define Gestores/Admins e filial (ou TODAS), tipos de erro, parâmetros, auditoria. |

**Login = empresa + código produtivo + senha.** O código produtivo só é único dentro da empresa: o 42 de Feira e o 42 de Caruaru são usuários diferentes, cada um com sua senha. A empresa escolhida fica lembrada no aparelho.

**Primeiro acesso:** o colaborador escolhe a empresa, digita o código produtivo → pede acesso (ou o gestor libera direto) → o gestor clica em **Liberar** e recebe um **código de 6 dígitos** (válido por 48h) → o colaborador digita o código produtivo, o código de liberação e cria a própria senha.
Para dispensar o código de 6 dígitos: Configurações > `EXIGIR_CODIGO_LIBERACAO` = NAO (menos seguro).

**Segurança:** senhas com hash SHA-256 + salt (nunca em texto), bloqueio de 15 min após 5 senhas erradas, sessão de 6h validada no servidor a cada ação, permissões checadas no servidor, mudança de perfil/bloqueio derruba a sessão aberta, colaborador inativo no RH não entra, proteção contra fórmula em CSV, trilha de auditoria de tudo.

**Desconto por erro (Configurações > Parâmetros):**
- `Valor do desconto (R$)` — padrão **0,25**.
- `Cálculo do desconto` — **Por lançamento**: Falta+Sobra+Avaria no mesmo lançamento = 1 desconto (R$ 0,25). **Por erro**: cada erro marcado conta (Falta+Sobra+Avaria = 3 × R$ 0,25 = R$ 0,75).
- Cada lançamento guarda a regra do dia em que foi feito: mudar o parâmetro vale para os próximos lançamentos e não altera meses já fechados. Lançamentos importados da planilha antiga (sem regra gravada) usam a regra atual.
- O desconto aparece no painel (total e por colaborador), na lista de lançamentos, no CSV (detalhado e resumo) e no PDF.

**Online agora (painel):** cada tela aberta avisa o servidor a cada minuto. Conta pessoas (o mesmo usuário em dois aparelhos conta 1), agrupadas pela empresa do login. Quem fecha a aba, desliga o aparelho ou fica mais de 3 minutos sem sinal sai da contagem; quem clica em Sair sai na hora. Gestor vê só a própria filial; Admin vê todas. Clique na empresa para ver os nomes.
