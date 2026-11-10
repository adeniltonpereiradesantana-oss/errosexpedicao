/**
 *  Colaboradores.gs — leitura (somente leitura) da aba Colaboradores do RH
 *  Planilha: RH Inteligente Web - Base (Atestados-1005217)
 *
 *  Os cabeçalhos são detectados por nome (sem depender da ordem das colunas).
 *  Se algum nome for diferente, ajuste as listas em CAMPOS_RH abaixo.
 */

var CAMPOS_RH = {
  cod: ['codprodutivo', 'codigoprodutivo', 'produtivoid', 'idprodutivo'],
  nome: ['colaborador', 'nome', 'nomecompleto', 'nomecolaborador', 'funcionario'],
  filial: ['filial', 'empresa', 'empresaid', 'idempresa', 'filialid', 'unidade'],
  situacao: ['situacao', 'status', 'ativo'],
  equipe: ['equipe', 'setor', 'departamento'],
  funcao: ['funcao', 'cargo'],
  turno: ['turno']
};

var SITUACOES_INATIVAS = ['inativo', 'demitido', 'desligado', 'excluido', 'nao', 'false'];

function rhPlanilha_() {
  return SpreadsheetApp.openById(String(cfg_('RH_PLANILHA_ID', APP.RH_ID_PADRAO)).trim());
}

function acharColuna_(cabNorm, candidatos) {
  for (var i = 0; i < candidatos.length; i++) {
    var idx = cabNorm.indexOf(candidatos[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Mapa id->nome de empresas/filiais, se a planilha do RH tiver a aba Empresas/Filiais. */
function mapaEmpresasRh_(ss) {
  var mapa = {};
  ['Empresas', 'Filiais', 'Empresa', 'Filial'].some(function (nomeAba) {
    var sh = ss.getSheetByName(nomeAba);
    if (!sh || sh.getLastRow() < 2) return false;
    var vals = sh.getDataRange().getValues();
    var cab = vals[0].map(normTxt_);
    var cId = acharColuna_(cab, ['id', 'empresaid', 'idempresa', 'codigo', 'filialid']);
    var cNome = acharColuna_(cab, ['nomefantasia', 'fantasia', 'filial', 'nome', 'empresa', 'cidade', 'razaosocial']);
    if (cId < 0 || cNome < 0 || cId === cNome) return false;
    for (var i = 1; i < vals.length; i++) {
      var id = String(vals[i][cId]).trim();
      if (id) mapa[id] = String(vals[i][cNome]).trim().toUpperCase();
    }
    return true;
  });
  return mapa;
}

/** Lê todos os colaboradores do RH (com cache de 10 minutos). */
function colaboradores_() {
  var cache = lerCacheGrande_('rh_colab');
  if (cache) return cache;

  var ss = rhPlanilha_();
  var nomeAba = String(cfg_('RH_ABA_COLABORADORES', APP.RH_ABA_PADRAO));
  var sh = ss.getSheetByName(nomeAba);
  if (!sh) throw new Error('Aba "' + nomeAba + '" não encontrada na planilha do RH.');
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  var cab = vals[0].map(normTxt_);
  var col = {};
  Object.keys(CAMPOS_RH).forEach(function (k) { col[k] = acharColuna_(cab, CAMPOS_RH[k]); });
  if (col.cod < 0) throw new Error('Coluna do código produtivo não encontrada na aba ' + nomeAba + '.');
  if (col.nome < 0) throw new Error('Coluna do nome do colaborador não encontrada na aba ' + nomeAba + '.');

  var empresas = mapaEmpresasRh_(ss);
  var lista = [];
  var vistos = {};
  for (var i = 1; i < vals.length; i++) {
    var r = vals[i];
    var cod = normCod_(r[col.cod]);
    if (!cod) continue;
    var sit = col.situacao >= 0 ? String(r[col.situacao]).trim() : '';
    var filialRaw = col.filial >= 0 ? String(r[col.filial]).trim() : '';
    var item = {
      cod: cod,
      nome: String(r[col.nome]).trim().toUpperCase(),
      filial: (empresas[filialRaw] || filialRaw).toUpperCase(),
      equipe: col.equipe >= 0 ? String(r[col.equipe]).trim().toUpperCase() : '',
      funcao: col.funcao >= 0 ? String(r[col.funcao]).trim().toUpperCase() : '',
      turno: col.turno >= 0 ? String(r[col.turno]).trim().toUpperCase() : '',
      situacao: sit.toUpperCase(),
      ativo: SITUACOES_INATIVAS.indexOf(normTxt_(sit)) < 0
    };
    // O código produtivo é único DENTRO de cada empresa. Chave = empresa + código.
    // Mesmo código repetido na mesma empresa (ex.: recontratação): prevalece o ATIVO / o mais abaixo.
    var chave = item.filial + '|' + cod;
    if (vistos[chave] !== undefined) {
      var ant = lista[vistos[chave]];
      if (ant.ativo && !item.ativo) continue;
      lista[vistos[chave]] = item;
    } else {
      vistos[chave] = lista.length;
      lista.push(item);
    }
  }
  gravarCacheGrande_('rh_colab', lista, 600);
  return lista;
}

/** Colaborador pelo código dentro de uma empresa. Sem empresa: só retorna se o código for único. */
function buscarColaborador_(cod, empresa) {
  cod = normCod_(cod);
  var achados = colaboradores_().filter(function (c) {
    return c.cod === cod && (!empresa || mesmaEmpresa_(c.filial, empresa));
  });
  if (!achados.length) return null;
  if (!empresa && achados.length > 1) {
    var ativos = achados.filter(function (c) { return c.ativo; });
    return ativos.length === 1 ? ativos[0] : null; // ambíguo: código existe em mais de uma empresa
  }
  return achados[0];
}

function colaboradoresPorCod_(cod) {
  cod = normCod_(cod);
  return colaboradores_().filter(function (c) { return c.cod === cod; });
}

/** Empresas com colaboradores ativos (usadas na tela de login). */
function empresas_() {
  var m = {};
  colaboradores_().forEach(function (c) { if (c.ativo && c.filial) m[c.filial] = true; });
  return Object.keys(m).sort();
}

/* ---------- Cache em partes (CacheService tem limite de 100KB por chave) ---------- */
function gravarCacheGrande_(chave, obj, seg) {
  try {
    var s = JSON.stringify(obj), tam = 90000, partes = {}, n = Math.ceil(s.length / tam);
    for (var i = 0; i < n; i++) partes[chave + '_' + i] = s.substr(i * tam, tam);
    partes[chave + '_n'] = String(n);
    CacheService.getScriptCache().putAll(partes, seg);
  } catch (e) { console.warn('Cache não gravado: ' + e); }
}

function lerCacheGrande_(chave) {
  var c = CacheService.getScriptCache();
  var n = Number(c.get(chave + '_n'));
  if (!n) return null;
  var ks = [];
  for (var i = 0; i < n; i++) ks.push(chave + '_' + i);
  var got = c.getAll(ks), s = '';
  for (var j = 0; j < n; j++) { if (got[ks[j]] === undefined || got[ks[j]] === null) return null; s += got[ks[j]]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function limparCacheColaboradores_() {
  CacheService.getScriptCache().remove('rh_colab_n');
}

/* ============================================================
 *  Funções públicas
 * ============================================================ */

/** Lista de empresas para o login (pública: só os nomes). */
function listarEmpresas() {
  return api_(function () { return empresas_(); });
}

/** Lista de colaboradores ativos que o usuário pode lançar (dados mínimos). */
function listarColaboradores(token) {
  return api_(function () {
    var s = sessao_(token);
    return colaboradores_().filter(function (c) {
      return c.ativo && podeVerFilial_(s, c.filial);
    }).map(function (c) {
      return { cod: c.cod, nome: c.nome, equipe: c.equipe, filial: c.filial };
    });
  });
}

function atualizarColaboradores(token) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    limparCacheColaboradores_();
    var n = colaboradores_().length;
    auditar_(s, 'ATUALIZOU_COLABORADORES', n + ' registros');
    return { total: n };
  });
}
