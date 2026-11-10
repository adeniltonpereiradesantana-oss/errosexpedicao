/**
 *  Admin.gs — usuários, tipos de erro, configurações, auditoria, instalação e migração
 */

/** Usado só por instalarPeloEditor(): empresa e código produtivo do primeiro administrador. */
var ADMIN_INICIAL_EMPRESA = 'FEIRA DE SANTANA';
var ADMIN_INICIAL_COD = '2';

/** Planilha antiga (Painel - Logística > Controle de Erros) para importar o histórico. */
var PLANILHA_ANTIGA_ID = '1oGPLLtQwDz-x_S4afRhh5fsoiTqnulH8vhU8VyDE6BM';

/* ============================================================
 *  Usuários (GESTOR e ADMIN)
 * ============================================================ */
function usuarioPublico_(u) {
  var dt = function (v) { return v instanceof Date && !isNaN(v) ? fmtData_(v, 'dd/MM/yyyy HH:mm') : ''; };
  return {
    cod: normCod_(u.codProdutivo), empresa: empresaUsuario_(u), nome: String(u.nome), perfil: String(u.perfil), filial: String(u.filial),
    status: estaBloqueado_(u) && String(u.status) !== 'BLOQUEADO' ? 'BLOQ. TEMPORÁRIO' : String(u.status),
    liberadoPor: String(u.liberadoPor || ''), liberadoEm: dt(u.liberadoEm),
    liberacaoExpira: dt(u.liberacaoExpira), ultimoAcesso: dt(u.ultimoAcesso), criadoEm: dt(u.criadoEm)
  };
}

/** GESTOR só gerencia USERs da própria filial; ADMIN gerencia todos. */
function podeGerenciar_(s, u) {
  if (s.perfil === 'ADMIN') return true;
  return String(u.perfil) === 'USER' && podeVerFilial_(s, u.filial);
}

function listarUsuarios(token) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    var lista = lerAba_('Usuarios').filter(function (u) {
      return s.perfil === 'ADMIN' || podeVerFilial_(s, u.filial);
    }).map(function (u) {
      var p = usuarioPublico_(u);
      p.podeGerenciar = podeGerenciar_(s, u) && !ehProprio_(s, p.empresa, p.cod);
      return p;
    });
    var ordem = { 'PENDENTE': 0, 'LIBERADO': 1, 'BLOQ. TEMPORÁRIO': 2, 'BLOQUEADO': 3, 'ATIVO': 4, 'INATIVO': 5 };
    lista.sort(function (a, b) { return (ordem[a.status] - ordem[b.status]) || a.nome.localeCompare(b.nome); });
    var filiais = {};
    colaboradores_().forEach(function (c) { if (c.filial) filiais[c.filial] = true; });
    return { usuarios: lista, filiais: Object.keys(filiais).sort(), exigeCodigo: exigeCodigoLiberacao_(), horas: APP.LIBERACAO_HORAS };
  });
}

/**
 * Empresa do usuário-alvo de uma ação. Gestor de uma filial só: a dele.
 * Senão, a informada; se vier vazia e o código existir em uma única empresa, usa essa.
 */
function empresaAlvo_(s, empresa, cod) {
  empresa = normEmp_(limpar_(empresa, 60));
  if (!empresa && s.perfil !== 'ADMIN' && s.filial !== 'TODAS') empresa = normEmp_(s.filial);
  if (!empresa) {
    var l = colaboradoresPorCod_(cod);
    var emps = l.map(function (c) { return c.filial; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    if (emps.length === 1) empresa = emps[0];
    else if (emps.length > 1) throw new Error('O código ' + cod + ' existe em mais de uma empresa (' + emps.join(', ') + '). Escolha o colaborador na lista.');
    else throw new Error('Código produtivo ' + cod + ' não encontrado na aba Colaboradores do RH.');
  }
  return empresa;
}

function codigo6_() {
  var n = parseInt(aleatorioHex_(4), 16) % 1000000;
  return ('000000' + n).slice(-6);
}

/**
 * Libera o primeiro acesso (ou reseta a senha) de um colaborador.
 * Retorna o código de liberação que o gestor repassa ao colaborador.
 */
function liberarAcesso(token, empresa, cod) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    cod = normCod_(limpar_(cod, 20));
    empresa = empresaAlvo_(s, empresa, cod);
    if (ehProprio_(s, empresa, cod)) throw new Error('Use "Trocar senha" para alterar a sua própria senha.');
    return comTrava_(function () {
      var u = buscarUsuario_(empresa, cod);
      var c = buscarColaborador_(cod, empresa);
      if (!u) {
        if (!c) throw new Error('Código produtivo ' + cod + ' não encontrado em ' + empresa + ' (aba Colaboradores do RH).');
        if (!c.ativo) throw new Error('Colaborador inativo no RH.');
        u = { codProdutivo: c.cod, nome: c.nome, perfil: 'USER', filial: c.filial, empresa: c.filial, criadoEm: agora_() };
      }
      if (!podeGerenciar_(s, u)) throw new Error('Você não pode liberar este usuário.');
      if (c && !c.ativo && String(u.perfil) !== 'ADMIN') throw new Error('Colaborador inativo no RH.');
      var codigo = codigo6_();
      u.salt = aleatorioHex_(16);
      u.codigoLiberacaoHash = hashSenha_(codigo, u.salt);
      u.senhaHash = '';
      u.status = 'LIBERADO';
      u.tentativas = 0; u.bloqueadoAte = '';
      u.liberacaoExpira = new Date(Date.now() + APP.LIBERACAO_HORAS * 3600000);
      u.liberadoPor = s.cod + ' - ' + s.nome;
      u.liberadoEm = agora_();
      salvarUsuario_(u);
      auditar_(s, 'LIBEROU_ACESSO', u.codProdutivo + ' - ' + u.nome);
      return {
        ok: true, cod: normCod_(u.codProdutivo), empresa: empresaUsuario_(u), nome: String(u.nome),
        codigo: exigeCodigoLiberacao_() ? codigo : '', horas: APP.LIBERACAO_HORAS
      };
    });
  });
}

/** Bloqueia / desbloqueia / inativa. acao: 'BLOQUEAR' | 'DESBLOQUEAR' | 'INATIVAR' */
function alterarStatusUsuario(token, empresa, cod, acao) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    cod = normCod_(limpar_(cod, 20));
    empresa = empresaAlvo_(s, empresa, cod);
    if (ehProprio_(s, empresa, cod)) throw new Error('Você não pode alterar o seu próprio acesso.');
    return comTrava_(function () {
      var u = buscarUsuario_(empresa, cod);
      if (!u) throw new Error('Usuário não encontrado.');
      if (!podeGerenciar_(s, u)) throw new Error('Você não pode alterar este usuário.');
      if (acao === 'BLOQUEAR') u.status = 'BLOQUEADO';
      else if (acao === 'INATIVAR') { u.status = 'INATIVO'; u.senhaHash = ''; u.codigoLiberacaoHash = ''; }
      else if (acao === 'DESBLOQUEAR') { u.status = u.senhaHash ? 'ATIVO' : 'PENDENTE'; u.bloqueadoAte = ''; u.tentativas = 0; }
      else throw new Error('Ação inválida.');
      salvarUsuario_(u);
      auditar_(s, 'STATUS_' + acao, u.codProdutivo + ' - ' + u.nome);
      return { ok: true };
    });
  });
}

/** Somente ADMIN: define perfil (ADMIN/GESTOR/USER) e filial (ou TODAS). */
function definirPerfil(token, empresa, cod, perfil, filial) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN']);
    cod = normCod_(limpar_(cod, 20));
    empresa = empresaAlvo_(s, empresa, cod);
    perfil = String(perfil || '').toUpperCase();
    filial = limpar_(filial, 60).toUpperCase();
    if (PERFIS.indexOf(perfil) < 0) throw new Error('Perfil inválido.');
    if (ehProprio_(s, empresa, cod)) throw new Error('Você não pode alterar o seu próprio perfil.');
    if (!filial) throw new Error('Informe a filial.');
    return comTrava_(function () {
      var u = buscarUsuario_(empresa, cod);
      if (!u) throw new Error('Usuário não encontrado. Libere o acesso primeiro.');
      var antes = u.perfil + '/' + u.filial;
      u.perfil = perfil; u.filial = filial;
      salvarUsuario_(u);
      auditar_(s, 'ALTEROU_PERFIL', u.codProdutivo + ' - ' + u.nome + ': ' + antes + ' -> ' + perfil + '/' + filial);
      return { ok: true };
    });
  });
}

/* ============================================================
 *  Tipos de erro, configurações e auditoria (ADMIN)
 * ============================================================ */
function listarTipos(token) {
  return api_(function () {
    sessao_(token, ['ADMIN']);
    return lerAba_('TiposErro').map(function (t) {
      return { id: String(t.id), nome: String(t.nome), ativo: t.ativo === true || String(t.ativo).toUpperCase() === 'SIM' || String(t.ativo).toUpperCase() === 'TRUE', ordem: Number(t.ordem) || 0 };
    }).sort(function (a, b) { return a.ordem - b.ordem; });
  });
}

function salvarTipo(token, tipo) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN']);
    tipo = tipo || {};
    var nome = limpar_(tipo.nome, 40).replace(/[,;|]/g, ' ').trim();
    if (!nome) throw new Error('Informe o nome do tipo de erro.');
    return comTrava_(function () {
      var lista = lerAba_('TiposErro');
      var dup = lista.filter(function (t) { return normTxt_(t.nome) === normTxt_(nome) && String(t.id) !== String(tipo.id || ''); });
      if (dup.length) throw new Error('Já existe um tipo com esse nome.');
      var reg = null;
      if (tipo.id) lista.forEach(function (t) { if (String(t.id) === String(tipo.id)) reg = t; });
      if (reg && String(reg.nome) !== nome) {
        // Renomear mudaria o histórico — só permitido se o tipo ainda não foi usado.
        var usado = lerAba_('Lancamentos').some(function (l) { return separarTipos_(l.tiposErro).indexOf(String(reg.nome)) >= 0; });
        if (usado) throw new Error('Este tipo já tem lançamentos e não pode ser renomeado. Desative-o e crie outro.');
      }
      var obj = reg || { id: novoId_(), ordem: lista.length + 1 };
      obj.nome = nome;
      obj.ativo = tipo.ativo === false ? 'NAO' : 'SIM';
      if (tipo.ordem !== undefined && tipo.ordem !== '') obj.ordem = Number(tipo.ordem) || obj.ordem;
      if (reg) atualizarLinha_('TiposErro', reg._linha, obj); else inserir_('TiposErro', obj);
      auditar_(s, 'TIPO_ERRO', (reg ? 'Alterou ' : 'Criou ') + nome + ' (' + obj.ativo + ')');
      return { ok: true };
    });
  });
}

var CHAVES_CONFIG_EDITAVEIS = ['DESCONTO_VALOR', 'DESCONTO_MODO', 'RH_PLANILHA_ID', 'RH_ABA_COLABORADORES', 'EXIGIR_CODIGO_LIBERACAO'];

/** Parâmetros padrão (criados na instalação e, se faltarem, na primeira vez que o Admin abre Configurações). */
function configPadrao_() {
  return [
    ['DESCONTO_VALOR', '0.25', 'Valor do desconto em R$ (ex.: 0,25). Vale para os lançamentos feitos a partir da alteração.'],
    ['DESCONTO_MODO', 'POR_LANCAMENTO', 'POR_LANCAMENTO = 1 desconto por lançamento, mesmo com vários erros (Falta+Sobra+Avaria = 1 desconto). POR_ERRO = 1 desconto para cada erro marcado.'],
    ['RH_PLANILHA_ID', APP.RH_ID_PADRAO, 'ID da planilha do RH (RH Inteligente Web - Base, pasta Atestados-1005217)'],
    ['RH_ABA_COLABORADORES', APP.RH_ABA_PADRAO, 'Aba com os colaboradores (código produtivo, nome, filial, situação)'],
    ['EXIGIR_CODIGO_LIBERACAO', 'SIM', 'SIM = no primeiro acesso o colaborador informa o código de 6 dígitos gerado pelo gestor']
  ];
}

function garantirConfigPadrao_() {
  var existentes = lerAba_('Config').map(function (r) { return String(r.chave); });
  configPadrao_().forEach(function (c) { if (existentes.indexOf(c[0]) < 0) inserir_('Config', { chave: c[0], valor: c[1], descricao: c[2] }); });
  _cfg = null;
}

function lerConfig(token) {
  return api_(function () {
    sessao_(token, ['ADMIN']);
    comTrava_(garantirConfigPadrao_);
    var desc = {};
    configPadrao_().forEach(function (c) { desc[c[0]] = c[2]; });
    return lerAba_('Config').filter(function (r) { return CHAVES_CONFIG_EDITAVEIS.indexOf(String(r.chave)) >= 0; })
      .sort(function (a, b) { return CHAVES_CONFIG_EDITAVEIS.indexOf(String(a.chave)) - CHAVES_CONFIG_EDITAVEIS.indexOf(String(b.chave)); })
      .map(function (r) {
        var v = String(r.chave) === 'DESCONTO_VALOR' ? String(numeroConfig_(r.valor)).replace('.', ',') : String(r.valor);
        return { chave: String(r.chave), valor: v, descricao: desc[String(r.chave)] || String(r.descricao) };
      });
  });
}

function salvarConfig(token, valores) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN']);
    return comTrava_(function () {
      lerAba_('Config').forEach(function (r) {
        var k = String(r.chave);
        if (CHAVES_CONFIG_EDITAVEIS.indexOf(k) < 0 || valores[k] === undefined) return;
        var v = limpar_(valores[k], 200);
        if (k === 'EXIGIR_CODIGO_LIBERACAO') v = v.toUpperCase() === 'NAO' ? 'NAO' : 'SIM';
        if (k === 'DESCONTO_MODO') v = v.toUpperCase() === 'POR_ERRO' ? 'POR_ERRO' : 'POR_LANCAMENTO';
        if (k === 'DESCONTO_VALOR') {
          var n = Number(v.replace(/\s|R\$/g, '').replace(',', '.'));
          if (isNaN(n) || n < 0 || n > 10000) throw new Error('Valor do desconto inválido. Use, por exemplo, 0,25.');
          v = String(Math.round(n * 100) / 100);
        }
        if (v !== String(r.valor) && !(k === 'DESCONTO_VALOR' && numeroConfig_(r.valor) === Number(v))) {
          r.valor = v;
          atualizarLinha_('Config', r._linha, r);
          auditar_(s, 'CONFIG', k + ' = ' + v);
        }
      });
      _cfg = null;
      limparCacheColaboradores_();
      return { ok: true };
    });
  });
}

function listarAuditoria(token) {
  return api_(function () {
    sessao_(token, ['ADMIN']);
    var l = lerAba_('Auditoria');
    return l.slice(-400).reverse().map(function (r) {
      return {
        dataHora: r.dataHora instanceof Date ? fmtData_(r.dataHora, 'dd/MM/yyyy HH:mm:ss') : String(r.dataHora),
        cod: String(r.codProdutivo), nome: String(r.nome), acao: String(r.acao), detalhe: String(r.detalhe)
      };
    });
  });
}

/** Diagnóstico da leitura da aba Colaboradores (ADMIN). */
function diagnosticoColaboradores(token) {
  return api_(function () {
    sessao_(token, ['ADMIN']);
    return diagnosticoColaboradores_();
  });
}

function diagnosticoColaboradores_() {
  limparCacheColaboradores_();
  var ss = rhPlanilha_();
  var nomeAba = String(cfg_('RH_ABA_COLABORADORES', APP.RH_ABA_PADRAO));
  var sh = ss.getSheetByName(nomeAba);
  if (!sh) throw new Error('Aba "' + nomeAba + '" não encontrada na planilha ' + ss.getName());
  var cab = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cabN = cab.map(normTxt_);
  var detectadas = {};
  Object.keys(CAMPOS_RH).forEach(function (k) { var i = acharColuna_(cabN, CAMPOS_RH[k]); detectadas[k] = i >= 0 ? cab[i] : '(não encontrada)'; });
  var l = colaboradores_();
  var porFilial = {};
  l.forEach(function (c) { var k = c.filial || '(vazio)'; porFilial[k] = porFilial[k] || { ativos: 0, inativos: 0 }; porFilial[k][c.ativo ? 'ativos' : 'inativos']++; });
  return { planilha: ss.getName(), aba: nomeAba, colunas: detectadas, total: l.length, porFilial: porFilial, exemplo: l.slice(0, 5) };
}

/* ============================================================
 *  Instalação
 * ============================================================ */
function instalarEstrutura_() {
  var ss = db_();
  Object.keys(ABAS).forEach(function (nome) {
    var sh = ss.getSheetByName(nome) || ss.insertSheet(nome);
    var cab = ABAS[nome];
    sh.getRange(1, 1, 1, cab.length).setValues([cab]).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    (COLUNAS_TEXTO[nome] || []).forEach(function (c) {
      var col = cab.indexOf(c) + 1;
      sh.getRange(2, col, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  });
  aba_('Lancamentos').getRange('B2:B').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  ['Página1', 'Sheet1', 'Planilha1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  garantirConfigPadrao_();
  if (!lerAba_('TiposErro').length) {
    ['Falta', 'Sobra', 'Avaria', 'Troca de produto', 'Validade / lote'].forEach(function (n, i) {
      inserir_('TiposErro', { id: novoId_(), nome: n, ativo: i < 3 ? 'SIM' : 'NAO', ordem: i + 1 });
    });
  }
  _cfg = null;
}

function criarAdmin_(empresa, cod, nome, senha) {
  cod = normCod_(cod); empresa = normEmp_(empresa);
  var u = buscarUsuario_(empresa, cod) || { codProdutivo: cod, criadoEm: agora_() };
  u.empresa = empresa;
  u.nome = nome || u.nome || 'ADMINISTRADOR';
  u.perfil = 'ADMIN'; u.filial = 'TODAS'; u.tentativas = 0; u.bloqueadoAte = '';
  u.salt = aleatorioHex_(16);
  if (senha) { validarForcaSenha_(senha); u.senhaHash = hashSenha_(senha, u.salt); u.status = 'ATIVO'; u.codigoLiberacaoHash = ''; }
  return u;
}

/** Menu da planilha: instala e cria o administrador com senha. */
function menuInstalar() {
  var ui = SpreadsheetApp.getUi();
  instalarEstrutura_();
  var r1 = ui.prompt('Administrador', 'Código produtivo do administrador (aba Colaboradores):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var cod = normCod_(r1.getResponseText());
  var achados = [];
  try { achados = colaboradoresPorCod_(cod).filter(function (c) { return c.ativo; }); }
  catch (e) { ui.alert('Aviso: não consegui ler os colaboradores do RH: ' + e.message); }
  var c = achados.length === 1 ? achados[0] : null;
  var empresa = c ? c.filial : '';
  if (!c) {
    var lista = achados.length ? achados.map(function (x) { return x.filial + ' (' + x.nome + ')'; }).join('\n') : empresas_().join('\n');
    var r0 = ui.prompt('Empresa do administrador',
      (achados.length > 1 ? 'O código ' + cod + ' existe em mais de uma empresa:\n' : 'Digite a empresa exatamente como abaixo:\n') + lista,
      ui.ButtonSet.OK_CANCEL);
    if (r0.getSelectedButton() !== ui.Button.OK) return;
    empresa = normEmp_(r0.getResponseText());
    c = buscarColaborador_(cod, empresa);
  }
  if (!empresa) { ui.alert('Empresa não informada.'); return; }
  var r2 = ui.prompt('Administrador', 'Crie a senha do administrador ' + (c ? c.nome : cod) + ' — ' + empresa + ' (mín. ' + APP.MIN_SENHA + ' caracteres):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var u = criarAdmin_(empresa, cod, c ? c.nome : '', r2.getResponseText());
  salvarUsuario_(u);
  auditar_({ cod: cod, nome: u.nome, empresa: empresa }, 'INSTALACAO', 'Sistema instalado e administrador criado');
  ui.alert('Pronto!', 'Sistema instalado. Entre no app escolhendo a empresa ' + empresa + ', o código ' + cod + ' e a senha criada.', ui.ButtonSet.OK);
}

/**
 * Alternativa sem a planilha aberta: rode pelo editor.
 * Libera o primeiro acesso do admin (ADMIN_INICIAL_EMPRESA + ADMIN_INICIAL_COD) e mostra o código no "Registro de execução".
 */
function instalarPeloEditor() {
  instalarEstrutura_();
  var c = null;
  try { c = buscarColaborador_(ADMIN_INICIAL_COD, ADMIN_INICIAL_EMPRESA); } catch (e) { Logger.log('Aviso RH: ' + e.message); }
  var u = criarAdmin_(ADMIN_INICIAL_EMPRESA, ADMIN_INICIAL_COD, c ? c.nome : '', '');
  var codigo = codigo6_();
  u.codigoLiberacaoHash = hashSenha_(codigo, u.salt);
  u.senhaHash = ''; u.status = 'LIBERADO';
  u.liberacaoExpira = new Date(Date.now() + APP.LIBERACAO_HORAS * 3600000);
  u.liberadoPor = 'INSTALAÇÃO'; u.liberadoEm = agora_();
  salvarUsuario_(u);
  auditar_({ cod: u.codProdutivo, nome: u.nome, empresa: u.empresa }, 'INSTALACAO', 'Instalado pelo editor');
  Logger.log('Sistema instalado. Admin: empresa ' + u.empresa + ', código produtivo ' + u.codProdutivo + ' (' + u.nome + '). ' +
    'No primeiro acesso use o CÓDIGO DE LIBERAÇÃO: ' + codigo + ' (válido por ' + APP.LIBERACAO_HORAS + 'h).');
}

/** Atualiza cabeçalhos/formatos das abas após uma nova versão (não apaga dados). */
function atualizarEstrutura() {
  instalarEstrutura_();
  var n = 0;
  lerAba_('Usuarios').forEach(function (u) {
    if (!u.empresa) { var e = empresaUsuario_(u); if (e) { u.empresa = e; atualizarLinha_('Usuarios', u._linha, u); n++; } }
  });
  var msg = 'Estrutura atualizada. Usuários com empresa preenchida agora: ' + n + '.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { }
}

function menuTestarColaboradores() {
  var d = diagnosticoColaboradores_();
  var txt = 'Planilha: ' + d.planilha + ' / aba ' + d.aba + '\nTotal: ' + d.total + '\n\nColunas detectadas:\n' +
    Object.keys(d.colunas).map(function (k) { return '  ' + k + ': ' + d.colunas[k]; }).join('\n') +
    '\n\nPor filial:\n' + Object.keys(d.porFilial).map(function (k) { return '  ' + k + ': ' + d.porFilial[k].ativos + ' ativos / ' + d.porFilial[k].inativos + ' inativos'; }).join('\n');
  Logger.log(txt);
  try { SpreadsheetApp.getUi().alert(txt); } catch (e) { /* rodado pelo editor */ }
}

/* ============================================================
 *  Migração do histórico antigo (abas Erros + Nomes)
 * ============================================================ */
function menuImportarHistorico() {
  var r = importarHistoricoAntigo();
  try { SpreadsheetApp.getUi().alert(r); } catch (e) { Logger.log(r); }
}

/** Idempotente: pode rodar mais de uma vez sem duplicar (usa o id antigo). */
function importarHistoricoAntigo() {
  var ant = SpreadsheetApp.openById(PLANILHA_ANTIGA_ID);
  var erros = ant.getSheetByName('Erros').getDataRange().getValues();
  var nomes = ant.getSheetByName('Nomes').getDataRange().getValues();
  var mapaNome = {};
  for (var i = 1; i < nomes.length; i++) {
    var curto = String(nomes[i][2]).trim().toUpperCase();
    if (curto && !mapaNome[curto]) mapaNome[curto] = { cod: normCod_(nomes[i][0]), nome: String(nomes[i][1]).trim().toUpperCase(), equipe: String(nomes[i][3]).trim().toUpperCase() };
  }
  var existentes = {};
  lerAba_('Lancamentos').forEach(function (l) { existentes[String(l.id)] = true; });
  var cab = erros[0].map(normTxt_);
  var ci = function (n) { return cab.indexOf(n); };
  var novos = [], semCod = [];
  for (var j = 1; j < erros.length; j++) {
    var r = erros[j];
    var idAnt = String(r[ci('id')]).trim();
    if (!idAnt) continue;
    var id = 'ANT-' + idAnt;
    if (existentes[id]) continue;
    var curto = String(r[ci('nome')]).trim().toUpperCase();
    var n = mapaNome[curto];
    if (!n) { semCod.push(curto); continue; }
    var c = null;
    var filialAnt = String(r[ci('filial')]).trim().toUpperCase();
    try { c = buscarColaborador_(n.cod, filialAnt); } catch (e) { }
    var dv = r[ci('data')], hv = r[ci('hora')];
    var d = dv instanceof Date ? new Date(dv.getTime()) : new Date(String(dv) + 'T12:00:00');
    if (hv instanceof Date) d.setHours(hv.getHours(), hv.getMinutes(), hv.getSeconds());
    else if (/^\d{1,2}:\d{2}/.test(String(hv))) { var p = String(hv).split(':'); d.setHours(+p[0], +p[1], +(p[2] || 0)); }
    var tipos = separarTipos_(r[ci('erro')]);
    novos.push(objParaLinha_('Lancamentos', {
      id: id, dataHora: d, data: fmtData_(d), filial: c ? c.filial : filialAnt,
      codProdutivo: n.cod, colaborador: c ? c.nome : n.nome, equipe: c ? c.equipe : n.equipe,
      tiposErro: tipos.join(', '), qtdErros: tipos.length, pedido: '', quantidade: '', observacao: 'Importado do controle antigo',
      lancadoPorCod: '', lancadoPorNome: String(r[ci('usuario')]).trim().toUpperCase(), status: 'ATIVO'
    }));
  }
  if (novos.length) {
    comTrava_(function () {
      var sh = aba_('Lancamentos');
      var ini = sh.getLastRow() + 1, fim = ini + novos.length - 1;
      if (fim > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), fim - sh.getMaxRows() + 200);
      var fmt = formatosLinha_('Lancamentos')[0];
      var rg = sh.getRange(ini, 1, novos.length, novos[0].length);
      rg.setNumberFormats(novos.map(function () { return fmt; }));
      rg.setValues(novos);
    });
  }
  var msg = 'Histórico importado: ' + novos.length + ' lançamento(s).';
  if (semCod.length) msg += '\nSem código produtivo correspondente (não importados): ' + semCod.filter(function (x, i, a) { return a.indexOf(x) === i; }).join(', ');
  return msg;
}
