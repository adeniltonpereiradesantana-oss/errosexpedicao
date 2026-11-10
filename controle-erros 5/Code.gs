/**
 * ============================================================
 *  CONTROLE DE ERROS DE EXPEDIÇÃO — Web App (Apps Script)
 *  Arquivo: Code.gs — configuração, roteamento e utilitários
 * ============================================================
 *  Banco:  planilha "Controle de Erros Web - Base"
 *          (Meu Drive > Painel - Logística)
 *  Colaboradores: planilha "RH Inteligente Web - Base", aba Colaboradores
 *          (Meu Drive > appsheet > data > Atestados-1005217) — somente leitura
 * ============================================================
 */

/** IDs fixos (podem ser sobrescritos pela aba Config). */
var APP = {
  NOME: 'Controle de Erros de Expedição',
  VERSAO: '1.3.1',
  DB_ID: '1qbH4Q69Nd6u80ymD5nsCUCn35dLaur-1KkzGJf3aIVA',
  RH_ID_PADRAO: '1USFoa4OlEJ2ZYcaCiK5BpNZ22tVTTy3gzxxEodQIN8Y',
  RH_ABA_PADRAO: 'Colaboradores',
  SESSAO_SEGUNDOS: 6 * 60 * 60,      // 6 horas (máximo do CacheService)
  MAX_TENTATIVAS: 5,                 // erros de senha antes do bloqueio
  BLOQUEIO_MINUTOS: 15,
  HASH_ITERACOES: 1000,
  MIN_SENHA: 6,
  LIBERACAO_HORAS: 48,               // validade do código de primeiro acesso
  MINUTOS_EXCLUIR_PROPRIO: 15,       // USER pode excluir o próprio lançamento nesse prazo
  PRESENCA_SEGUNDOS: 60,             // a tela aberta avisa que está online nesse intervalo
  ONLINE_MINUTOS: 3                  // sem sinal por mais que isso = considerado offline
};

/** Estrutura das abas do banco. A ordem das colunas é a ordem gravada. */
var ABAS = {
  Config: ['chave', 'valor', 'descricao'],
  Usuarios: ['codProdutivo', 'nome', 'perfil', 'filial', 'status', 'senhaHash', 'salt',
    'tentativas', 'bloqueadoAte', 'codigoLiberacaoHash', 'liberacaoExpira',
    'liberadoPor', 'liberadoEm', 'ultimoAcesso', 'criadoEm', 'atualizadoEm', 'empresa'],
  Lancamentos: ['id', 'dataHora', 'data', 'filial', 'codProdutivo', 'colaborador', 'equipe',
    'tiposErro', 'qtdErros', 'pedido', 'quantidade', 'observacao',
    'lancadoPorCod', 'lancadoPorNome', 'status', 'canceladoPor', 'canceladoEm', 'motivoCancelamento',
    'lancadoPorEmpresa', 'descontoValor', 'descontoModo'],
  TiposErro: ['id', 'nome', 'ativo', 'ordem'],
  Auditoria: ['dataHora', 'codProdutivo', 'nome', 'acao', 'detalhe', 'empresa']
};

/** Colunas que devem ficar como TEXTO puro (evita o Sheets converter em data/número). */
var COLUNAS_TEXTO = {
  Usuarios: ['codProdutivo', 'filial', 'senhaHash', 'salt', 'codigoLiberacaoHash', 'empresa'],
  Lancamentos: ['id', 'data', 'codProdutivo', 'pedido', 'lancadoPorCod', 'filial', 'lancadoPorEmpresa'],
  Auditoria: ['codProdutivo', 'empresa'],
  TiposErro: ['id']
};

var PERFIS = ['ADMIN', 'GESTOR', 'USER'];
var STATUS_USUARIO = ['PENDENTE', 'LIBERADO', 'ATIVO', 'BLOQUEADO', 'INATIVO'];

/* ============================================================
 *  Web App
 * ============================================================ */
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  // ?empresa=CARUARU na URL já deixa a empresa escolhida no login (link por filial no portal)
  t.empresaUrl = (e && e.parameter && e.parameter.empresa) ? String(e.parameter.empresa).substring(0, 60) : '';
  t.appNome = APP.NOME;
  t.appVersao = APP.VERSAO;
  return t.evaluate()
    .setTitle(APP.NOME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(nome) {
  return HtmlService.createHtmlOutputFromFile(nome).getContent();
}

/** Menu na planilha-banco (quando o script está vinculado a ela). */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('Controle de Erros')
      .addItem('1. Instalar / configurar sistema', 'menuInstalar')
      .addItem('2. Importar histórico da planilha antiga', 'menuImportarHistorico')
      .addItem('Atualizar estrutura das abas (após nova versão)', 'atualizarEstrutura')
      .addSeparator()
      .addItem('Testar leitura de colaboradores', 'menuTestarColaboradores')
      .addToUi();
  } catch (e) { /* aberto fora da planilha */ }
}

/* ============================================================
 *  Acesso ao banco
 * ============================================================ */
var _db = null;
function db_() {
  if (_db) return _db;
  var id = PropertiesService.getScriptProperties().getProperty('DB_ID') || APP.DB_ID;
  _db = SpreadsheetApp.openById(id);
  return _db;
}

function aba_(nome) {
  var sh = db_().getSheetByName(nome);
  if (!sh) throw new Error('Aba "' + nome + '" não encontrada. Rode a instalação do sistema.');
  return sh;
}

/** Lê uma aba inteira como lista de objetos (com _linha = número da linha). */
function lerAba_(nome) {
  var sh = aba_(nome);
  var ult = sh.getLastRow();
  var cab = ABAS[nome];
  if (ult < 2) return [];
  var vals = sh.getRange(2, 1, ult - 1, cab.length).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (r.join('') === '') continue;
    var o = { _linha: i + 2 };
    for (var c = 0; c < cab.length; c++) o[cab[c]] = r[c];
    out.push(o);
  }
  return out;
}

function objParaLinha_(nome, obj) {
  return ABAS[nome].map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
}

/** Formato de cada coluna: texto puro onde precisa, data/hora nas colunas de data. */
var COLUNAS_DATAHORA = ['dataHora', 'bloqueadoAte', 'liberacaoExpira', 'liberadoEm', 'ultimoAcesso',
  'criadoEm', 'atualizadoEm', 'canceladoEm'];
function formatosLinha_(nome) {
  var txt = COLUNAS_TEXTO[nome] || [];
  return [ABAS[nome].map(function (c) {
    if (txt.indexOf(c) >= 0) return '@';
    if (COLUNAS_DATAHORA.indexOf(c) >= 0) return 'dd/MM/yyyy HH:mm:ss';
    return 'General';
  })];
}

function gravarLinha_(sh, nome, linhaNum, obj) {
  var linha = objParaLinha_(nome, obj);
  if (linhaNum > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(200, linhaNum - sh.getMaxRows()));
  var rg = sh.getRange(linhaNum, 1, 1, linha.length);
  rg.setNumberFormats(formatosLinha_(nome)); // garante texto ANTES de gravar (evita virar data/número)
  rg.setValues([linha]);
}

function inserir_(nome, obj) {
  var sh = aba_(nome);
  var n = sh.getLastRow() + 1;
  gravarLinha_(sh, nome, n, obj);
  return n;
}

function atualizarLinha_(nome, linhaNum, obj) {
  gravarLinha_(aba_(nome), nome, linhaNum, obj);
}

/** Executa fn com trava global (evita gravações simultâneas). */
function comTrava_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('Sistema ocupado. Tente novamente em alguns segundos.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================================================
 *  Config (aba Config)
 * ============================================================ */
var _cfg = null;
function cfg_(chave, padrao) {
  if (!_cfg) {
    _cfg = {};
    try {
      lerAba_('Config').forEach(function (r) { _cfg[String(r.chave).trim()] = r.valor; });
    } catch (e) { /* ainda não instalado */ }
  }
  var v = _cfg[chave];
  return (v === undefined || v === '') ? padrao : v;
}

/* ============================================================
 *  Utilitários
 * ============================================================ */
function tz_() { return Session.getScriptTimeZone() || 'America/Bahia'; }
function agora_() { return new Date(); }
function fmtData_(d, f) { return Utilities.formatDate(d, tz_(), f || 'yyyy-MM-dd'); }

/** Data guardada como texto yyyy-MM-dd (tolera célula que virou Date). */
function dataTxt_(v) {
  if (v instanceof Date) return isNaN(v) ? '' : fmtData_(v);
  return String(v || '').trim().substring(0, 10);
}

/** Normaliza código produtivo: "0042", 42, "42.0" -> "42". */
function normCod_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  s = s.replace(/\.0+$/, '');
  if (/^\d+$/.test(s)) s = String(parseInt(s, 10));
  return s.toUpperCase();
}

/** Normaliza nome de empresa/filial. */
function normEmp_(v) {
  return String(v === null || v === undefined ? '' : v).trim().toUpperCase();
}

/** Mesma empresa? (ignora acentos, espaços e caixa) */
function mesmaEmpresa_(a, b) {
  return normTxt_(a) === normTxt_(b);
}

/** Normaliza texto para comparação de cabeçalhos/nomes. */
function normTxt_(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Limpa texto vindo do navegador. */
function limpar_(v, max) {
  var s = String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (max && s.length > max) s = s.substring(0, max);
  return s;
}

function novoId_() {
  return Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
}

function aleatorioHex_(bytes) {
  var s = '';
  while (s.length < bytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.substring(0, bytes * 2);
}

function primeiroNome_(n) {
  return String(n || '').trim().split(/\s+/)[0] || '';
}

function auditar_(sessao, acao, detalhe) {
  try {
    inserir_('Auditoria', {
      dataHora: agora_(),
      codProdutivo: sessao ? sessao.cod : '',
      nome: sessao ? sessao.nome : '',
      acao: acao,
      detalhe: limpar_(detalhe, 500),
      empresa: sessao ? (sessao.empresa || '') : ''
    });
  } catch (e) { console.error('Falha ao auditar: ' + e); }
}

/** Padroniza o retorno de erros para o navegador sem vazar detalhes internos. */
function erroPublico_(e) {
  var msg = (e && e.message) ? e.message : String(e);
  if (msg.indexOf('SESSAO_EXPIRADA') === 0) return msg;
  if (/Exception|ReferenceError|TypeError|Cannot read/i.test(msg)) {
    console.error(e && e.stack ? e.stack : msg);
    return 'Erro interno. Tente novamente ou fale com o administrador.';
  }
  return msg;
}
