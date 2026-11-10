/**
 *  Auth.gs — login por EMPRESA + código produtivo, primeiro acesso, sessões e permissões
 *
 *  O código produtivo só é único dentro da empresa; por isso o usuário é identificado
 *  pelo par (empresa, código). O 42 de Feira e o 42 de Caruaru são usuários diferentes.
 *
 *  Fluxo:
 *   1) Usuário escolhe a empresa e digita o código produtivo  -> verificarCodigo()
 *   2a) status ATIVO      -> digita a senha                       -> entrar()
 *   2b) status LIBERADO   -> código de liberação + nova senha     -> criarSenha()
 *   2c) não cadastrado    -> pode solicitar acesso (PENDENTE)     -> solicitarAcesso()
 *   O Gestor/Admin libera (gera o código de liberação) na aba Usuários.
 */

/* ---------- Hash de senha (SHA-256 com salt, iterado) ---------- */
function hashSenha_(senha, salt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + senha, Utilities.Charset.UTF_8);
  for (var i = 1; i < APP.HASH_ITERACOES; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes.concat(Utilities.newBlob(salt).getBytes()));
  }
  return Utilities.base64Encode(bytes);
}

/** Comparação em tempo constante. */
function iguais_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function validarForcaSenha_(senha) {
  senha = String(senha || '');
  if (senha.length < APP.MIN_SENHA) throw new Error('A senha precisa ter pelo menos ' + APP.MIN_SENHA + ' caracteres.');
  if (senha.length > 64) throw new Error('Senha muito longa.');
  if (/^(.)\1+$/.test(senha)) throw new Error('A senha não pode ser um caractere repetido.');
  if (/^(0?123456789?|987654321?0?|123456|654321)$/.test(senha)) throw new Error('Senha muito fácil. Escolha outra.');
}

/* ---------- Usuários ---------- */
/** Empresa de origem do usuário (identidade). "filial" é o escopo de acesso (pode ser TODAS). */
function empresaUsuario_(u) {
  if (u.empresa) return normEmp_(u.empresa);
  if (String(u.filial) !== 'TODAS') return normEmp_(u.filial);
  // Usuário criado na v1.0 com filial TODAS: deduz a empresa pelo código no RH (se for único).
  try {
    var l = colaboradoresPorCod_(u.codProdutivo).filter(function (c) { return c.ativo; });
    if (l.length === 1) return l[0].filial;
  } catch (e) { }
  return '';
}

function chaveUsuario_(empresa, cod) {
  return normTxt_(empresa) + '|' + normCod_(cod);
}

function buscarUsuario_(empresa, cod) {
  var k = chaveUsuario_(empresa, cod);
  var lista = lerAba_('Usuarios');
  for (var i = 0; i < lista.length; i++) if (chaveUsuario_(empresaUsuario_(lista[i]), lista[i].codProdutivo) === k) return lista[i];
  return null;
}

function validarEmpresa_(empresa) {
  empresa = normEmp_(limpar_(empresa, 60));
  if (!empresa) throw new Error('Selecione a empresa.');
  var ok = empresas_().some(function (e) { return mesmaEmpresa_(e, empresa); });
  // O admin pode estar numa empresa sem colaboradores ativos listados; aceita se houver usuário cadastrado nela.
  if (!ok && !lerAba_('Usuarios').some(function (u) { return mesmaEmpresa_(empresaUsuario_(u), empresa); }))
    throw new Error('Empresa inválida.');
  return empresa;
}

function salvarUsuario_(u) {
  u.atualizadoEm = agora_();
  if (!u.empresa) u.empresa = empresaUsuario_(u);
  if (u._linha) atualizarLinha_('Usuarios', u._linha, u);
  else u._linha = inserir_('Usuarios', u);
  invalidarSessoesUsuario_(u.empresa, u.codProdutivo);
  return u;
}

function estaBloqueado_(u) {
  if (String(u.status) === 'BLOQUEADO') return true;
  var ate = u.bloqueadoAte instanceof Date ? u.bloqueadoAte : (u.bloqueadoAte ? new Date(u.bloqueadoAte) : null);
  return !!(ate && !isNaN(ate) && ate.getTime() > Date.now());
}

function registrarFalha_(u) {
  u.tentativas = (Number(u.tentativas) || 0) + 1;
  if (u.tentativas >= APP.MAX_TENTATIVAS) {
    u.bloqueadoAte = new Date(Date.now() + APP.BLOQUEIO_MINUTOS * 60000);
    u.tentativas = 0;
    salvarUsuario_(u);
    auditar_({ cod: u.codProdutivo, nome: u.nome, empresa: empresaUsuario_(u) }, 'LOGIN_BLOQUEIO_TEMPORARIO', APP.MAX_TENTATIVAS + ' tentativas erradas');
    throw new Error('Muitas tentativas erradas. Acesso bloqueado por ' + APP.BLOQUEIO_MINUTOS + ' minutos.');
  }
  salvarUsuario_(u);
  var resta = APP.MAX_TENTATIVAS - u.tentativas;
  throw new Error('Senha ou código inválido. ' + resta + ' tentativa(s) restante(s).');
}

/* ---------- Sessões (CacheService) ---------- */
function criarSessao_(u) {
  var token = aleatorioHex_(24);
  var s = {
    cod: normCod_(u.codProdutivo),
    empresa: empresaUsuario_(u),
    nome: String(u.nome),
    perfil: String(u.perfil),
    filial: String(u.filial || ''),
    criada: Date.now(),
    ver: versaoUsuario_(empresaUsuario_(u), u.codProdutivo)
  };
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(s), APP.SESSAO_SEGUNDOS);
  return { token: token, sessao: s };
}

function versaoUsuario_(empresa, cod) {
  return CacheService.getScriptCache().get('uver_' + chaveUsuario_(empresa, cod)) || '0';
}

/** Qualquer alteração no usuário (perfil, bloqueio, senha) derruba as sessões abertas dele. */
function invalidarSessoesUsuario_(empresa, cod) {
  CacheService.getScriptCache().put('uver_' + chaveUsuario_(empresa, cod), String(Date.now()), APP.SESSAO_SEGUNDOS);
}

/** É o próprio usuário logado? */
function ehProprio_(s, empresa, cod) {
  return chaveUsuario_(empresa, cod) === chaveUsuario_(s.empresa, s.cod);
}

/** Valida o token e (opcionalmente) o perfil mínimo. Lança SESSAO_EXPIRADA se inválido. */
function sessao_(token, perfisPermitidos) {
  if (!token || !/^[a-f0-9]{48}$/.test(String(token))) throw new Error('SESSAO_EXPIRADA: faça login novamente.');
  var raw = CacheService.getScriptCache().get('sess_' + token);
  if (!raw) throw new Error('SESSAO_EXPIRADA: sua sessão expirou. Faça login novamente.');
  var s = JSON.parse(raw);
  if (String(s.ver) !== String(versaoUsuario_(s.empresa, s.cod))) {
    CacheService.getScriptCache().remove('sess_' + token);
    throw new Error('SESSAO_EXPIRADA: seu acesso foi alterado. Faça login novamente.');
  }
  if (perfisPermitidos && perfisPermitidos.indexOf(s.perfil) < 0) throw new Error('Você não tem permissão para esta ação.');
  s.token = token;
  return s;
}

function podeVerFilial_(s, filial) {
  if (s.perfil === 'ADMIN' || s.filial === 'TODAS') return true;
  return normTxt_(s.filial) === normTxt_(filial);
}

/** Envolve funções públicas: converte erros em mensagens seguras. */
function api_(fn) {
  try { return fn(); } catch (e) { throw new Error(erroPublico_(e)); }
}

/* ============================================================
 *  Funções públicas (chamadas pelo navegador)
 * ============================================================ */

/** Passo 1 do login. Não revela dados pessoais além do primeiro nome. */
function verificarCodigo(empresa, cod) {
  return api_(function () {
    empresa = validarEmpresa_(empresa);
    cod = normCod_(limpar_(cod, 20));
    if (!cod) throw new Error('Informe o código produtivo.');
    var u = buscarUsuario_(empresa, cod);
    if (u) {
      if (String(u.status) === 'INATIVO') return { etapa: 'INATIVO' };
      if (estaBloqueado_(u)) return { etapa: 'BLOQUEADO' };
      if (String(u.status) === 'ATIVO') return { etapa: 'SENHA', nome: primeiroNome_(u.nome) };
      if (String(u.status) === 'LIBERADO') return { etapa: 'CRIAR_SENHA', nome: primeiroNome_(u.nome), exigeCodigo: exigeCodigoLiberacao_() };
      if (String(u.status) === 'PENDENTE') return { etapa: 'PENDENTE', nome: primeiroNome_(u.nome) };
    }
    var c = buscarColaborador_(cod, empresa);
    if (!c) return { etapa: 'INEXISTENTE' };
    if (!c.ativo) return { etapa: 'INATIVO' };
    return { etapa: 'SOLICITAR', nome: primeiroNome_(c.nome) };
  });
}

function exigeCodigoLiberacao_() {
  return String(cfg_('EXIGIR_CODIGO_LIBERACAO', 'SIM')).toUpperCase() !== 'NAO';
}

/** Colaborador do RH pede acesso; fica PENDENTE até o Gestor/Admin liberar. */
function solicitarAcesso(empresa, cod) {
  return api_(function () {
    empresa = validarEmpresa_(empresa);
    cod = normCod_(limpar_(cod, 20));
    return comTrava_(function () {
      if (buscarUsuario_(empresa, cod)) return { ok: true, msg: 'Solicitação já registrada. Aguarde a liberação do seu gestor.' };
      var c = buscarColaborador_(cod, empresa);
      if (!c || !c.ativo) throw new Error('Código produtivo não encontrado entre os colaboradores ativos desta empresa.');
      salvarUsuario_({
        codProdutivo: c.cod, nome: c.nome, perfil: 'USER', filial: c.filial, empresa: c.filial, status: 'PENDENTE',
        tentativas: 0, criadoEm: agora_()
      });
      auditar_({ cod: c.cod, nome: c.nome, empresa: c.filial }, 'SOLICITOU_ACESSO', 'Empresa ' + c.filial);
      return { ok: true, msg: 'Solicitação enviada. Peça ao seu gestor para liberar o primeiro acesso.' };
    });
  });
}

/** Login com senha. */
function entrar(empresa, cod, senha) {
  return api_(function () {
    empresa = validarEmpresa_(empresa);
    cod = normCod_(limpar_(cod, 20));
    senha = String(senha || '');
    return comTrava_(function () {
      var u = buscarUsuario_(empresa, cod);
      if (!u || String(u.status) !== 'ATIVO') throw new Error('Senha ou código inválido.');
      if (estaBloqueado_(u)) throw new Error('Acesso temporariamente bloqueado. Tente mais tarde ou procure o gestor.');
      var c = buscarColaborador_(cod, empresa);
      if (c && !c.ativo && u.perfil !== 'ADMIN') throw new Error('Colaborador inativo no RH. Acesso negado.');
      if (!iguais_(hashSenha_(senha, u.salt), u.senhaHash)) registrarFalha_(u);
      u.tentativas = 0; u.bloqueadoAte = ''; u.ultimoAcesso = agora_();
      if (!u.empresa) u.empresa = empresaUsuario_(u);
      atualizarLinha_('Usuarios', u._linha, u); // sem invalidar sessões
      var r = criarSessao_(u);
      registrarPresenca_(r.sessao);
      auditar_(r.sessao, 'LOGIN', '');
      return { token: r.token, usuario: perfilPublico_(r.sessao) };
    });
  });
}

/** Primeiro acesso / senha resetada: cria a senha. */
function criarSenha(empresa, cod, codigoLiberacao, senha, confirmacao) {
  return api_(function () {
    empresa = validarEmpresa_(empresa);
    cod = normCod_(limpar_(cod, 20));
    if (String(senha) !== String(confirmacao)) throw new Error('As senhas não conferem.');
    validarForcaSenha_(senha);
    return comTrava_(function () {
      var u = buscarUsuario_(empresa, cod);
      if (!u || String(u.status) !== 'LIBERADO') throw new Error('Primeiro acesso não liberado para este código.');
      if (estaBloqueado_(u)) throw new Error('Acesso temporariamente bloqueado. Tente mais tarde.');
      var exp = u.liberacaoExpira instanceof Date ? u.liberacaoExpira : (u.liberacaoExpira ? new Date(u.liberacaoExpira) : null);
      if (exp && exp.getTime() < Date.now()) throw new Error('A liberação expirou. Peça ao gestor para liberar novamente.');
      if (exigeCodigoLiberacao_()) {
        var cl = limpar_(codigoLiberacao, 12).replace(/\D/g, '');
        if (!cl || !iguais_(hashSenha_(cl, u.salt), u.codigoLiberacaoHash)) registrarFalha_(u);
      }
      u.salt = aleatorioHex_(16);
      u.senhaHash = hashSenha_(senha, u.salt);
      u.codigoLiberacaoHash = ''; u.liberacaoExpira = '';
      u.status = 'ATIVO'; u.tentativas = 0; u.bloqueadoAte = ''; u.ultimoAcesso = agora_();
      salvarUsuario_(u);
      var r = criarSessao_(u);
      registrarPresenca_(r.sessao);
      auditar_(r.sessao, 'SENHA_CRIADA', 'Primeiro acesso concluído');
      return { token: r.token, usuario: perfilPublico_(r.sessao) };
    });
  });
}

/** Troca de senha pelo próprio usuário logado. */
function trocarSenha(token, atual, nova, confirmacao) {
  return api_(function () {
    var s = sessao_(token);
    if (String(nova) !== String(confirmacao)) throw new Error('As senhas não conferem.');
    validarForcaSenha_(nova);
    return comTrava_(function () {
      var u = buscarUsuario_(s.empresa, s.cod);
      if (!iguais_(hashSenha_(String(atual || ''), u.salt), u.senhaHash)) registrarFalha_(u);
      u.salt = aleatorioHex_(16);
      u.senhaHash = hashSenha_(nova, u.salt);
      u.tentativas = 0;
      salvarUsuario_(u); // derruba outras sessões
      var r = criarSessao_(u);
      auditar_(s, 'SENHA_ALTERADA', '');
      return { token: r.token, usuario: perfilPublico_(r.sessao) };
    });
  });
}

function sair(token) {
  try {
    var s = sessao_(token);
    CacheService.getScriptCache().remove('sess_' + token);
    removerPresenca_(s);
    auditar_(s, 'LOGOUT', '');
  } catch (e) { /* já expirada */ }
  return true;
}

/* ============================================================
 *  Presença (quem está com o sistema aberto agora)
 *  Cada tela aberta chama ping() a cada minuto. Quem fica mais de
 *  APP.ONLINE_MINUTOS sem sinal (fechou a aba, desligou, saiu) deixa de contar.
 *  Conta PESSOAS: o mesmo usuário em dois aparelhos conta 1.
 * ============================================================ */
function lerPresenca_() {
  var raw = CacheService.getScriptCache().get('presenca');
  var m = raw ? JSON.parse(raw) : {}, limite = Date.now() - APP.ONLINE_MINUTOS * 60000;
  Object.keys(m).forEach(function (k) { if (m[k].t < limite) delete m[k]; });
  return m;
}

function alterarPresenca_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return; // presença é "melhor esforço": nunca trava o sistema
  try {
    var m = lerPresenca_();
    fn(m);
    CacheService.getScriptCache().put('presenca', JSON.stringify(m), 1800);
  } finally { lock.releaseLock(); }
}

function registrarPresenca_(s) {
  alterarPresenca_(function (m) {
    m[chaveUsuario_(s.empresa, s.cod)] = { e: s.empresa, n: s.nome, p: s.perfil, c: s.cod, t: Date.now() };
  });
}

function removerPresenca_(s) {
  alterarPresenca_(function (m) { delete m[chaveUsuario_(s.empresa, s.cod)]; });
}

/** Resumo de quem está online, no escopo do usuário (Gestor: só a filial dele). */
function resumoOnline_(s) {
  var m = lerPresenca_(), por = {}, total = 0, agora = Date.now();
  Object.keys(m).forEach(function (k) {
    var x = m[k];
    if (!podeVerFilial_(s, x.e)) return;
    var g = por[x.e] || (por[x.e] = { empresa: x.e, total: 0, pessoas: [] });
    g.total++; total++;
    g.pessoas.push({ nome: x.n, cod: x.c, perfil: x.p, seg: Math.round((agora - x.t) / 1000) });
  });
  var lista = Object.keys(por).map(function (k) {
    por[k].pessoas.sort(function (a, b) { return a.nome.localeCompare(b.nome); });
    return por[k];
  }).sort(function (a, b) { return b.total - a.total || a.empresa.localeCompare(b.empresa); });
  return { total: total, porEmpresa: lista, minutos: APP.ONLINE_MINUTOS };
}

/** Sinal de vida da tela aberta. Gestor/Admin já recebem o resumo de quem está online. */
function ping(token) {
  return api_(function () {
    var s = sessao_(token);
    registrarPresenca_(s);
    return (s.perfil === 'ADMIN' || s.perfil === 'GESTOR') ? { online: resumoOnline_(s) } : { ok: true };
  });
}

/** Quem está online agora (Gestor/Admin). */
function online(token) {
  return api_(function () { return resumoOnline_(sessao_(token, ['ADMIN', 'GESTOR'])); });
}

/** Recupera a sessão ao recarregar a página. */
function retomarSessao(token) {
  return api_(function () {
    var s = sessao_(token);
    registrarPresenca_(s);
    return { token: token, usuario: perfilPublico_(s) };
  });
}

function perfilPublico_(s) {
  return {
    cod: s.cod, empresa: s.empresa, nome: s.nome, primeiroNome: primeiroNome_(s.nome), perfil: s.perfil, filial: s.filial,
    pode: {
      lancar: true,
      painel: s.perfil === 'ADMIN' || s.perfil === 'GESTOR',
      usuarios: s.perfil === 'ADMIN' || s.perfil === 'GESTOR',
      admin: s.perfil === 'ADMIN'
    }
  };
}
