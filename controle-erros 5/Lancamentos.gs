/**
 *  Lancamentos.gs — registro e consulta de erros de expedição
 */

/** Tipos ativos. "idx" = posição na lista completa (define a cor fixa do tipo em todo o sistema). */
function tiposErroAtivos_() {
  return tiposOrdenados_().map(function (t, i) { t._idx = i; return t; })
    .filter(function (t) { return t.ativo === true || String(t.ativo).toUpperCase() === 'SIM' || String(t.ativo).toUpperCase() === 'TRUE'; })
    .map(function (t) { return { id: String(t.id), nome: String(t.nome), idx: t._idx }; });
}

function tiposOrdenados_() {
  return lerAba_('TiposErro').sort(function (a, b) { return (Number(a.ordem) || 0) - (Number(b.ordem) || 0); });
}

/* ---------- Desconto ---------- */
function numeroConfig_(v) {
  if (typeof v === 'number') return v;
  var n = Number(String(v || '').replace(/\s|R\$/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

/** Regra vigente (aba Config): valor em R$ e modo POR_LANCAMENTO | POR_ERRO. */
function regraDesconto_() {
  return {
    valor: numeroConfig_(cfg_('DESCONTO_VALOR', 0.25)),
    modo: String(cfg_('DESCONTO_MODO', 'POR_LANCAMENTO')).toUpperCase() === 'POR_ERRO' ? 'POR_ERRO' : 'POR_LANCAMENTO'
  };
}

/**
 * Desconto de um lançamento. Cada lançamento guarda a regra do dia em que foi feito
 * (descontoValor/descontoModo), então mudar o parâmetro não altera meses já fechados.
 * Lançamentos antigos sem regra gravada usam a regra vigente.
 * nErros = quantos erros contam (todos, ou só o tipo filtrado no painel).
 */
function descontoDe_(l, nErros) {
  var valor = l.descontoValor === '' || l.descontoValor === undefined || l.descontoValor === null ? null : numeroConfig_(l.descontoValor);
  var modo = l.descontoModo || '';
  if (valor === null || !modo) { var rg = regraDesconto_(); if (valor === null) valor = rg.valor; if (!modo) modo = rg.modo; }
  var n = nErros === undefined ? (l.tipos ? l.tipos.length : 1) : nErros;
  var total = modo === 'POR_ERRO' ? valor * n : (n > 0 ? valor : 0);
  return Math.round(total * 100) / 100;
}

/** Separa "Falta, Sobra" em ['Falta','Sobra']. */
function separarTipos_(v) {
  return String(v || '').split(/[,;|]/).map(function (x) { return x.trim(); }).filter(String);
}

function lancamentoPublico_(r) {
  var dh = r.dataHora instanceof Date ? r.dataHora : new Date(r.dataHora);
  return {
    id: String(r.id),
    dataHora: isNaN(dh) ? '' : fmtData_(dh, 'dd/MM/yyyy HH:mm'),
    ts: isNaN(dh) ? 0 : dh.getTime(),
    data: dataTxt_(r.data),
    filial: String(r.filial),
    cod: normCod_(r.codProdutivo),
    colaborador: String(r.colaborador),
    equipe: String(r.equipe),
    tipos: separarTipos_(r.tiposErro),
    qtdErros: Number(r.qtdErros) || separarTipos_(r.tiposErro).length,
    pedido: String(r.pedido || ''),
    quantidade: r.quantidade === '' ? '' : Number(r.quantidade),
    observacao: String(r.observacao || ''),
    lancadoPor: String(r.lancadoPorNome || ''),
    lancadoPorCod: normCod_(r.lancadoPorCod),
    lancadoPorEmpresa: normEmp_(r.lancadoPorEmpresa),
    status: String(r.status || 'ATIVO'),
    descontoValor: r.descontoValor === '' || r.descontoValor === undefined ? '' : numeroConfig_(r.descontoValor),
    descontoModo: String(r.descontoModo || '')
  };
}

function comDesconto_(l) { l.desconto = descontoDe_(l); return l; }

/** Dados iniciais da tela de lançamento. */
function dadosLancamento(token) {
  return api_(function () {
    var s = sessao_(token);
    return {
      tipos: tiposErroAtivos_(),
      recentes: meusRecentes_(s),
      regraDesconto: regraDesconto_(),
      minutosExcluir: APP.MINUTOS_EXCLUIR_PROPRIO
    };
  });
}

function meusRecentes_(s) {
  var hoje = fmtData_(agora_());
  var lista = lerAba_('Lancamentos').filter(function (r) {
    if (String(r.status) === 'CANCELADO') return false;
    if (s.perfil === 'USER') return lancadoPeloUsuario_(s, r) && dataTxt_(r.data) === hoje;
    return dataTxt_(r.data) === hoje && podeVerFilial_(s, r.filial);
  }).map(lancamentoPublico_).map(comDesconto_);
  lista.sort(function (a, b) { return b.ts - a.ts; });
  return lista.slice(0, 100);
}

/** O lançamento foi feito por este usuário (mesma empresa + mesmo código)? */
function lancadoPeloUsuario_(s, r) {
  return ehProprio_(s, r.lancadoPorEmpresa || s.empresa, r.lancadoPorCod);
}

/**
 * Registra um erro.
 * dados = { cod, empresa (do colaborador), tipos: [nomes], pedido, quantidade, observacao }
 */
function registrarErro(token, dados) {
  return api_(function () {
    var s = sessao_(token);
    dados = dados || {};
    var cod = normCod_(limpar_(dados.cod, 20));
    // Empresa do colaborador: a informada, ou a do próprio usuário (perfil de uma filial só).
    var empresa = normEmp_(limpar_(dados.empresa, 60)) || (s.filial !== 'TODAS' ? s.filial : s.empresa);
    var c = buscarColaborador_(cod, empresa);
    if (!c) throw new Error('Colaborador com código ' + cod + ' não encontrado em ' + empresa + '.');
    if (!c.ativo) throw new Error('Colaborador ' + c.nome + ' está inativo no RH.');
    if (!podeVerFilial_(s, c.filial)) throw new Error('Este colaborador não pertence à sua filial.');

    var validos = tiposErroAtivos_().map(function (t) { return t.nome; });
    var tipos = (Array.isArray(dados.tipos) ? dados.tipos : []).map(function (t) { return limpar_(t, 60); })
      .filter(function (t, i, arr) { return validos.indexOf(t) >= 0 && arr.indexOf(t) === i; });
    if (!tipos.length) throw new Error('Selecione pelo menos um tipo de erro.');

    var qtd = '';
    if (dados.quantidade !== '' && dados.quantidade !== null && dados.quantidade !== undefined) {
      qtd = Number(String(dados.quantidade).replace(',', '.'));
      if (isNaN(qtd) || qtd < 0 || qtd > 1000000) throw new Error('Quantidade inválida.');
    }

    var agora = agora_();
    var reg = {
      id: novoId_(),
      dataHora: agora,
      data: fmtData_(agora),
      filial: c.filial,
      codProdutivo: c.cod,
      colaborador: c.nome,
      equipe: c.equipe,
      tiposErro: tipos.join(', '),
      qtdErros: tipos.length,
      pedido: limpar_(dados.pedido, 40),
      quantidade: qtd,
      observacao: limpar_(dados.observacao, 300),
      lancadoPorCod: s.cod,
      lancadoPorNome: s.nome,
      lancadoPorEmpresa: s.empresa,
      status: 'ATIVO'
    };
    var regra = regraDesconto_();          // grava a regra vigente no próprio lançamento
    reg.descontoValor = regra.valor;
    reg.descontoModo = regra.modo;
    comTrava_(function () { inserir_('Lancamentos', reg); });
    return { ok: true, lancamento: comDesconto_(lancamentoPublico_(reg)) };
  });
}

/** Cancela (exclusão lógica). USER: só o próprio, dentro do prazo. GESTOR/ADMIN: qualquer um da filial. */
function cancelarLancamento(token, id, motivo) {
  return api_(function () {
    var s = sessao_(token);
    id = limpar_(id, 20);
    motivo = limpar_(motivo, 200);
    return comTrava_(function () {
      var lista = lerAba_('Lancamentos');
      var r = null;
      for (var i = 0; i < lista.length; i++) if (String(lista[i].id) === id) { r = lista[i]; break; }
      if (!r) throw new Error('Lançamento não encontrado.');
      if (String(r.status) === 'CANCELADO') return { ok: true };
      if (s.perfil === 'USER') {
        var dh = r.dataHora instanceof Date ? r.dataHora : new Date(r.dataHora);
        if (!lancadoPeloUsuario_(s, r)) throw new Error('Você só pode excluir os seus próprios lançamentos.');
        if (Date.now() - dh.getTime() > APP.MINUTOS_EXCLUIR_PROPRIO * 60000)
          throw new Error('Prazo de ' + APP.MINUTOS_EXCLUIR_PROPRIO + ' minutos para excluir encerrado. Fale com o gestor.');
      } else {
        if (!podeVerFilial_(s, r.filial)) throw new Error('Lançamento de outra filial.');
        if (!motivo) throw new Error('Informe o motivo do cancelamento.');
      }
      r.status = 'CANCELADO';
      r.canceladoPor = s.cod + ' - ' + s.nome;
      r.canceladoEm = agora_();
      r.motivoCancelamento = motivo || 'Excluído pelo próprio lançador';
      atualizarLinha_('Lancamentos', r._linha, r);
      auditar_(s, 'CANCELOU_LANCAMENTO', id + ' (' + r.colaborador + ' - ' + r.tiposErro + ') ' + r.motivoCancelamento);
      return { ok: true };
    });
  });
}
