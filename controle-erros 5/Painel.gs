/**
 *  Painel.gs — painel gerencial (GESTOR/ADMIN) e relatórios CSV / PDF
 */

var MAX_DIAS_PERIODO = 731;

function normalizarFiltros_(f) {
  f = f || {};
  var hoje = fmtData_(agora_());
  var re = /^\d{4}-\d{2}-\d{2}$/;
  var ate = re.test(f.ate) ? f.ate : hoje;
  var de = re.test(f.de) ? f.de : fmtData_(new Date(Date.now() - 29 * 86400000));
  if (de > ate) { var t = de; de = ate; ate = t; }
  if (diasEntre_(de, ate) > MAX_DIAS_PERIODO) throw new Error('Período máximo de 2 anos.');
  return {
    de: de, ate: ate,
    filial: limpar_(f.filial, 60).toUpperCase(),
    equipe: limpar_(f.equipe, 60).toUpperCase(),
    cod: f.cod ? normCod_(limpar_(f.cod, 20)) : '',
    empColab: f.cod ? normEmp_(limpar_(f.empColab, 60)) : '',   // empresa do colaborador filtrado
    tipo: limpar_(f.tipo, 60)
  };
}

function diasEntre_(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

function somarDias_(d, n) {
  var x = new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000);
  return x.toISOString().substring(0, 10);
}

/** Lançamentos no escopo do usuário + filtros (sem cancelados). */
function filtrarLancamentos_(s, f, todos) {
  return (todos || lerAba_('Lancamentos')).map(function (r) {
    return lancamentoPublico_(r);
  }).filter(function (l) {
    if (l.status === 'CANCELADO') return false;
    if (!podeVerFilial_(s, l.filial)) return false;
    if (l.data < f.de || l.data > f.ate) return false;
    if (f.filial && l.filial !== f.filial) return false;
    if (f.equipe && l.equipe !== f.equipe) return false;
    if (f.cod && (l.cod !== f.cod || (f.empColab && !mesmaEmpresa_(l.filial, f.empColab)))) return false;
    if (f.tipo && l.tipos.indexOf(f.tipo) < 0) return false;
    return true;
  });
}

function contarOcorrencias_(l, f) {
  return f.tipo ? 1 : l.tipos.length;
}

function agregar_(s, f) {
  var todos = lerAba_('Lancamentos');
  var lista = filtrarLancamentos_(s, f, todos);
  var tiposCad = tiposOrdenados_().map(function (t) { return String(t.nome); });

  var porTipo = {}, porDia = {}, porColab = {}, porEquipe = {}, porFilial = {}, colabs = {};
  var ocorr = 0, qtdTotal = 0, descTotal = 0;
  lista.forEach(function (l) {
    var n = contarOcorrencias_(l, f);
    ocorr += n;
    l.desconto = descontoDe_(l, n);
    descTotal += l.desconto;
    if (typeof l.quantidade === 'number' && !isNaN(l.quantidade)) qtdTotal += l.quantidade;
    (f.tipo ? [f.tipo] : l.tipos).forEach(function (t) {
      porTipo[t] = (porTipo[t] || 0) + 1;
      if (tiposCad.indexOf(t) < 0) tiposCad.push(t);
    });
    porDia[l.data] = (porDia[l.data] || 0) + n;
    porEquipe[l.equipe || '(sem equipe)'] = (porEquipe[l.equipe || '(sem equipe)'] || 0) + n;
    porFilial[l.filial || '(sem filial)'] = (porFilial[l.filial || '(sem filial)'] || 0) + n;
    var kc = l.filial + '|' + l.cod;   // código só é único dentro da empresa
    colabs[kc] = true;
    var c = porColab[kc] || (porColab[kc] = {
      cod: l.cod, nome: l.colaborador, equipe: l.equipe, filial: l.filial,
      total: 0, lancamentos: 0, tipos: {}, ultima: 0, desconto: 0
    });
    c.total += n; c.lancamentos++;
    c.desconto = Math.round((c.desconto + l.desconto) * 100) / 100;
    (f.tipo ? [f.tipo] : l.tipos).forEach(function (t) { c.tipos[t] = (c.tipos[t] || 0) + 1; });
    if (l.ts > c.ultima) c.ultima = l.ts;
  });

  // Série temporal: diária até 62 dias; mensal acima disso.
  var dias = diasEntre_(f.de, f.ate) + 1;
  var serie = [], mensal = dias > 62;
  if (!mensal) {
    for (var i = 0; i < dias; i++) {
      var d = somarDias_(f.de, i);
      serie.push({ chave: d, rotulo: d.substring(8, 10) + '/' + d.substring(5, 7), total: porDia[d] || 0 });
    }
  } else {
    var meses = {};
    Object.keys(porDia).forEach(function (d) { var m = d.substring(0, 7); meses[m] = (meses[m] || 0) + porDia[d]; });
    var m0 = f.de.substring(0, 7), m1 = f.ate.substring(0, 7), y = Number(m0.substring(0, 4)), mm = Number(m0.substring(5, 7));
    var NOMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    while (true) {
      var k = y + '-' + (mm < 10 ? '0' : '') + mm;
      serie.push({ chave: k, rotulo: NOMES[mm - 1] + '/' + String(y).substring(2), total: meses[k] || 0 });
      if (k >= m1) break;
      mm++; if (mm > 12) { mm = 1; y++; }
    }
  }

  // Período anterior de mesmo tamanho (para variação).
  var fAnt = JSON.parse(JSON.stringify(f));
  fAnt.ate = somarDias_(f.de, -1); fAnt.de = somarDias_(f.de, -dias);
  var ocorrAnt = filtrarLancamentos_(s, fAnt, todos).reduce(function (a, l) { return a + contarOcorrencias_(l, f); }, 0);

  // Botões de empresa: ocorrências de cada empresa com os MESMOS filtros, exceto a empresa.
  var fSemEmp = JSON.parse(JSON.stringify(f)); fSemEmp.filial = '';
  var porEmpresaBotao = {};
  try { empresas_().forEach(function (e) { if (podeVerFilial_(s, e)) porEmpresaBotao[e] = 0; }); } catch (e) { }
  filtrarLancamentos_(s, fSemEmp, todos).forEach(function (l) {
    var k = l.filial || '(sem filial)';
    porEmpresaBotao[k] = (porEmpresaBotao[k] || 0) + contarOcorrencias_(l, f);
  });

  // Opções de filtro (escopo do usuário, todo o histórico).
  var opFiliais = {}, opEquipes = {};
  todos.forEach(function (r) {
    if (String(r.status) === 'CANCELADO' || !podeVerFilial_(s, r.filial)) return;
    if (r.filial) opFiliais[String(r.filial)] = true;
    if (r.equipe) opEquipes[String(r.equipe)] = true;
  });

  function emLista(o) {
    return Object.keys(o).map(function (k) { return { nome: k, total: o[k] }; })
      .sort(function (a, b) { return b.total - a.total; });
  }
  var ranking = Object.keys(porColab).map(function (k) { return porColab[k]; })
    .sort(function (a, b) { return b.total - a.total || a.nome.localeCompare(b.nome); });
  lista.sort(function (a, b) { return b.ts - a.ts; });

  return {
    filtros: f,
    kpis: {
      lancamentos: lista.length,
      ocorrencias: ocorr,
      colaboradores: Object.keys(colabs).length,
      dias: dias,
      mediaDia: dias ? ocorr / dias : 0,
      quantidade: qtdTotal,
      desconto: Math.round(descTotal * 100) / 100,
      anterior: ocorrAnt,
      variacao: ocorrAnt ? (ocorr - ocorrAnt) / ocorrAnt : null
    },
    tiposOrdem: tiposCad,
    regraDesconto: regraDesconto_(),
    porTipo: tiposCad.map(function (t) { return { nome: t, total: porTipo[t] || 0 }; }).filter(function (x) { return x.total > 0; }),
    serie: serie,
    serieMensal: mensal,
    porEquipe: emLista(porEquipe),
    porFilial: emLista(porFilial),
    ranking: ranking,
    lista: lista,
    empresasBotoes: Object.keys(porEmpresaBotao).sort().map(function (k) { return { nome: k, total: porEmpresaBotao[k] }; }),
    opcoes: { filiais: Object.keys(opFiliais).concat(Object.keys(porEmpresaBotao)).filter(function (x, i, a) { return a.indexOf(x) === i; }).sort(), equipes: Object.keys(opEquipes).sort() }
  };
}

/** Painel gerencial. */
function painel(token, filtros) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    var f = normalizarFiltros_(filtros);
    var a = agregar_(s, f);
    a.totalLista = a.lista.length;
    if (a.lista.length > 3000) a.lista = a.lista.slice(0, 3000);
    a.tiposAtivos = tiposErroAtivos_().map(function (t) { return t.nome; });
    a.online = resumoOnline_(s);
    return a;
  });
}

/* ============================================================
 *  CSV
 * ============================================================ */
function celulaCsv_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // proteção contra injeção de fórmula
  if (/[";\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function moedaCsv_(v) { return (Math.round((Number(v) || 0) * 100) / 100).toFixed(2).replace('.', ','); }

function textoRegra_(l) {
  var v = l.descontoValor === '' ? regraDesconto_().valor : l.descontoValor;
  var m = l.descontoModo || regraDesconto_().modo;
  return 'R$ ' + moedaCsv_(v) + (m === 'POR_ERRO' ? ' por erro' : ' por lançamento');
}

function montarCsv_(linhas) {
  return '﻿' + linhas.map(function (l) { return l.map(celulaCsv_).join(';'); }).join('\r\n');
}

/**
 * tipo: 'detalhado' (todos os lançamentos) | 'colaboradores' (resumo por colaborador)
 * Se filtros.cod vier preenchido, o relatório fica restrito àquele colaborador.
 */
function exportarCsv(token, filtros, tipo) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    var f = normalizarFiltros_(filtros);
    var a = agregar_(s, f);
    var linhas, sufixo;
    if (tipo === 'colaboradores') {
      sufixo = 'resumo-colaboradores';
      linhas = [['Código produtivo', 'Colaborador', 'Equipe', 'Filial', 'Ocorrências', 'Lançamentos']
        .concat(a.tiposOrdem).concat(['Desconto (R$)', 'Último erro'])];
      a.ranking.forEach(function (c) {
        linhas.push([c.cod, c.nome, c.equipe, c.filial, c.total, c.lancamentos]
          .concat(a.tiposOrdem.map(function (t) { return c.tipos[t] || 0; }))
          .concat([moedaCsv_(c.desconto), c.ultima ? fmtData_(new Date(c.ultima), 'dd/MM/yyyy HH:mm') : '']));
      });
    } else {
      sufixo = 'detalhado';
      linhas = [['ID', 'Data/hora', 'Filial', 'Código produtivo', 'Colaborador', 'Equipe', 'Tipos de erro',
        'Qtd. ocorrências', 'Desconto (R$)', 'Regra do desconto', 'Pedido/Carga', 'Quantidade', 'Observação', 'Lançado por']];
      a.lista.forEach(function (l) {
        linhas.push([l.id, l.dataHora, l.filial, l.cod, l.colaborador, l.equipe, l.tipos.join(', '),
          l.qtdErros, moedaCsv_(l.desconto), textoRegra_(l), l.pedido, l.quantidade === '' ? '' : String(l.quantidade).replace('.', ','), l.observacao,
          l.lancadoPorCod + ' - ' + l.lancadoPor]);
      });
    }
    var nome = 'erros-expedicao_' + (f.cod ? 'colab-' + f.cod + '_' : '') + sufixo + '_' + f.de + '_a_' + f.ate + '.csv';
    auditar_(s, 'EXPORTOU_CSV', nome);
    return { nome: nome, conteudo: montarCsv_(linhas) };
  });
}

/* ============================================================
 *  PDF (gerado no servidor)
 * ============================================================ */
function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function br_(d) { return d.substring(8, 10) + '/' + d.substring(5, 7) + '/' + d.substring(0, 4); }
function num_(n, dec) {
  var s = Number(n || 0).toFixed(dec || 0).split('.');
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return s.join(',');
}

var CORES_TIPO_PDF = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

function gerarPdf(token, filtros) {
  return api_(function () {
    var s = sessao_(token, ['ADMIN', 'GESTOR']);
    var f = normalizarFiltros_(filtros);
    var a = agregar_(s, f);
    var colab = f.cod ? (a.ranking[0] || buscarColaborador_(f.cod, f.empColab) || { cod: f.cod, nome: '' }) : null;
    var html = htmlRelatorio_(s, f, a, colab);
    var nome = 'relatorio-erros_' + (colab ? 'colab-' + f.cod + '_' : 'completo_') + f.de + '_a_' + f.ate + '.pdf';
    var blob = HtmlService.createHtmlOutput(html).getBlob().getAs(MimeType.PDF).setName(nome);
    auditar_(s, 'GEROU_PDF', nome);
    return { nome: nome, base64: Utilities.base64Encode(blob.getBytes()) };
  });
}

function htmlRelatorio_(s, f, a, colab) {
  var k = a.kpis;
  var maxTipo = a.porTipo.reduce(function (m, t) { return Math.max(m, t.total); }, 0) || 1;
  var filtrosTxt = ['Período: ' + br_(f.de) + ' a ' + br_(f.ate)];
  if (f.filial) filtrosTxt.push('Filial: ' + f.filial);
  if (f.equipe) filtrosTxt.push('Equipe: ' + f.equipe);
  if (f.tipo) filtrosTxt.push('Tipo: ' + f.tipo);

  var h = [];
  h.push('<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1f2328;font-size:10px;margin:0}' +
    'h1{font-size:17px;margin:0 0 2px}h2{font-size:12px;margin:16px 0 6px;border-bottom:1px solid #d0d7de;padding-bottom:3px}' +
    '.sub{color:#57606a;font-size:10px}.topo{border-bottom:3px solid #2a78d6;padding-bottom:8px;margin-bottom:10px}' +
    'table{width:100%;border-collapse:collapse}th{background:#f3f5f7;text-align:left;font-size:9px;text-transform:uppercase;color:#57606a}' +
    'th,td{font-size:10px;padding:4px 6px;border-bottom:1px solid #e5e8eb;vertical-align:top}td.n,th.n{text-align:right}' +
    '.kpis td{border:1px solid #d0d7de;padding:8px;width:20%}.kv{font-size:20px;font-weight:bold}.kl{color:#57606a;font-size:9px;text-transform:uppercase}' +
    '.bar{height:9px;border-radius:0 3px 3px 0}.rod{margin-top:14px;color:#8c959f;font-size:8px;text-align:right}' +
    '</style></head><body>');
  h.push('<div class="topo"><h1>' + (colab ? 'Relatório de erros — ' + esc_(colab.nome) : 'Relatório de erros de expedição') + '</h1>');
  h.push('<div class="sub">' + esc_(filtrosTxt.join('  ·  ')) +
    (colab ? '<br>Código produtivo: <b>' + esc_(colab.cod) + '</b>' + (colab.equipe ? '  ·  Equipe: ' + esc_(colab.equipe) : '') +
      (colab.filial ? '  ·  Filial: ' + esc_(colab.filial) : '') : '') + '</div></div>');

  var varTxt = k.variacao === null ? '—' : (k.variacao >= 0 ? '+' : '') + num_(k.variacao * 100, 1) + '%';
  h.push('<table class="kpis"><tr>' +
    '<td><div class="kl">Ocorrências</div><div class="kv">' + num_(k.ocorrencias) + '</div></td>' +
    '<td><div class="kl">Lançamentos</div><div class="kv">' + num_(k.lancamentos) + '</div></td>' +
    (colab ? '<td><div class="kl">Média por dia</div><div class="kv">' + num_(k.mediaDia, 2) + '</div></td>'
      : '<td><div class="kl">Colaboradores com erro</div><div class="kv">' + num_(k.colaboradores) + '</div></td>') +
    '<td><div class="kl">Desconto total</div><div class="kv">R$ ' + num_(k.desconto, 2) + '</div><div class="sub">Regra atual: R$ ' + num_(a.regraDesconto.valor, 2) +
      (a.regraDesconto.modo === 'POR_ERRO' ? ' por erro' : ' por lançamento') + '</div></td>' +
    '<td><div class="kl">Vs. período anterior</div><div class="kv">' + varTxt + '</div><div class="sub">' + num_(k.anterior) + ' ocorrências</div></td>' +
    '</tr></table>');

  h.push('<h2>Ocorrências por tipo de erro</h2><table>');
  a.porTipo.forEach(function (t) {
    var cor = CORES_TIPO_PDF[a.tiposOrdem.indexOf(t.nome) % CORES_TIPO_PDF.length];
    var pct = k.ocorrencias ? t.total / k.ocorrencias * 100 : 0;
    h.push('<tr><td style="width:22%">' + esc_(t.nome) + '</td><td style="width:58%"><div class="bar" style="width:' +
      Math.max(1, Math.round(t.total / maxTipo * 100)) + '%;background:' + cor + '"></div></td><td class="n">' +
      num_(t.total) + '</td><td class="n">' + num_(pct, 1) + '%</td></tr>');
  });
  if (!a.porTipo.length) h.push('<tr><td>Nenhuma ocorrência no período.</td></tr>');
  h.push('</table>');

  var tiposUsados = a.porTipo.map(function (t) { return t.nome; });
  if (!colab) {
    h.push('<h2>Ranking por colaborador</h2><table><tr><th>#</th><th>Código</th><th>Colaborador</th><th>Equipe</th>' +
      (f.filial ? '' : '<th>Filial</th>') +
      tiposUsados.map(function (t) { return '<th class="n">' + esc_(t) + '</th>'; }).join('') + '<th class="n">Total</th><th class="n">Desconto</th></tr>');
    a.ranking.forEach(function (c, i) {
      h.push('<tr><td>' + (i + 1) + '</td><td>' + esc_(c.cod) + '</td><td>' + esc_(c.nome) + '</td><td>' + esc_(c.equipe) + '</td>' +
        (f.filial ? '' : '<td>' + esc_(c.filial) + '</td>') +
        tiposUsados.map(function (t) { return '<td class="n">' + (c.tipos[t] || 0) + '</td>'; }).join('') +
        '<td class="n"><b>' + c.total + '</b></td><td class="n">R$ ' + num_(c.desconto, 2) + '</td></tr>');
    });
    h.push('</table>');

    h.push('<h2>Ocorrências por equipe</h2><table><tr><th>Equipe</th><th class="n">Ocorrências</th><th class="n">%</th></tr>');
    a.porEquipe.forEach(function (e) {
      h.push('<tr><td>' + esc_(e.nome) + '</td><td class="n">' + e.total + '</td><td class="n">' +
        num_(k.ocorrencias ? e.total / k.ocorrencias * 100 : 0, 1) + '%</td></tr>');
    });
    h.push('</table>');
  }

  h.push('<h2>' + (a.serieMensal ? 'Evolução mensal' : 'Evolução diária') + '</h2><table><tr>');
  var serie = a.serie.filter(function (x) { return x.total > 0; });
  if (!serie.length) h.push('<td>Sem ocorrências.</td>');
  serie.forEach(function (x, i) {
    if (i && i % 10 === 0) h.push('</tr><tr>');
    h.push('<td style="text-align:center"><div class="kl">' + esc_(x.rotulo) + '</div><b>' + x.total + '</b></td>');
  });
  h.push('</tr></table>');

  h.push('<h2>Lançamentos detalhados (' + a.lista.length + ')</h2><table><tr><th>Data/hora</th>' +
    (colab ? '' : '<th>Colaborador</th><th>Equipe</th>') + '<th>Tipos de erro</th><th class="n">Desconto</th><th>Pedido/Carga</th><th class="n">Qtd.</th><th>Observação</th><th>Lançado por</th></tr>');
  a.lista.forEach(function (l) {
    h.push('<tr><td>' + esc_(l.dataHora) + '</td>' +
      (colab ? '' : '<td>' + esc_(l.cod + ' - ' + l.colaborador) + '</td><td>' + esc_(l.equipe) + '</td>') +
      '<td>' + esc_(l.tipos.join(', ')) + '</td><td class="n">R$ ' + num_(l.desconto, 2) + '</td><td>' + esc_(l.pedido) + '</td><td class="n">' +
      esc_(l.quantidade === '' ? '' : num_(l.quantidade, l.quantidade % 1 ? 2 : 0)) + '</td><td>' + esc_(l.observacao) +
      '</td><td>' + esc_(l.lancadoPor) + '</td></tr>');
  });
  h.push('</table>');
  h.push('<div class="rod">Gerado em ' + fmtData_(agora_(), 'dd/MM/yyyy HH:mm') + ' por ' + esc_(s.nome) + ' · ' + esc_(APP.NOME) + '</div>');
  h.push('</body></html>');
  return h.join('');
}
