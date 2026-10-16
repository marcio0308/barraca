/* ============================================================
   PASTORAL FAMILIAR - ATENDIMENTO
   ============================================================ */
(function () {
    'use strict';
    const { db, esc, formatarPreco, centavos, ehErroDeRede, mensagemDeErro, definirStatus, aviso, comBotaoOcupado, local } = window.PF;

    const CHAVE_CACHE = 'pf_cache_atendimento';
    const CHAVE_PENDENTES = 'pf_vendas_pendentes';

    // ---------- Estado ----------
    let produtos = [];
    let carrinho = [];            // itens: { id, nome, preco, quantidade } — SEM imagem
    let vendaAtual = null;
    let pagamentoSelecionado = null;
    let chavePix = '';
    let titularPix = '';
    let qrCodeImage = '';
    let sistemaBloqueado = false;
    let realtimeAtivo = false;
    let timerRetentativa = null;
    let sincronizando = false;

    // ---------- DOM ----------
    const $ = id => document.getElementById(id);
    const gradeProdutos = $('gradeProdutos');
    const listaCarrinho = $('listaCarrinho');
    const totalCarrinho = $('totalCarrinho');
    const modalResumoVenda = $('modalResumoVenda');
    const modalQRCode = $('modalQRCode');
    const modalPagamento = $('modalPagamento');
    const modalSucesso = $('modalSucesso');
    const textoSucesso = $('textoSucesso');
    const bloqueioOverlay = $('bloqueioOverlay');
    const conteudoAtendimento = $('conteudoAtendimento');
    const chavePixModal = $('chavePixModal');
    const titularPixModal = $('titularPixModal');
    const qrPlaceholder = $('qrPlaceholder');
    const conteudoResumoVenda = $('conteudoResumoVenda');
    const btnPagamentoSim = $('btnPagamentoSim');

    // ============================================================
    // CONFIGURAÇÃO / BLOQUEIO
    // ============================================================
    function aplicarConfig(lista) {
        (lista || []).forEach(item => {
            if (item.chave === 'chavePix') chavePix = item.valor || '';
            if (item.chave === 'titularPix') titularPix = item.valor || '';
            if (item.chave === 'qrCodeImage') qrCodeImage = item.valor || '';
            if (item.chave === 'sistemaBloqueado') aplicarBloqueio(item.valor === 'true');
        });
    }

    function aplicarBloqueio(bloqueado) {
        sistemaBloqueado = bloqueado;
        bloqueioOverlay.classList.toggle('ativo', bloqueado);
        conteudoAtendimento.style.opacity = bloqueado ? '0.5' : '1';
        conteudoAtendimento.style.pointerEvents = bloqueado ? 'none' : 'auto';
        if (bloqueado) {
            [modalResumoVenda, modalQRCode, modalPagamento].forEach(m => m.classList.remove('ativo'));
        }
    }

    // Consulta leve, usada só como reserva quando o tempo real (Realtime) não está ativo
    async function verificarBloqueio() {
        const { data, error, status } = await db
            .from('config').select('valor').eq('chave', 'sistemaBloqueado').maybeSingle();
        if (error) {
            atualizarStatus(ehErroDeRede(error, status) ? 'offline' : 'online');
            return;
        }
        if (data) aplicarBloqueio(data.valor === 'true');
        atualizarStatus('online');
    }

    // ============================================================
    // CARREGAR DADOS
    // ============================================================
    function salvarCache() {
        // Imagens antigas em base64 não vão para o cache (estouram o limite do navegador)
        const produtosLeves = produtos.map(p => ({
            ...p, imagem: (p.imagem && !String(p.imagem).startsWith('data:')) ? p.imagem : null
        }));
        local.gravar(CHAVE_CACHE, {
            produtos: produtosLeves,
            config: { chavePix, titularPix, qrCodeImage: String(qrCodeImage).startsWith('data:') ? '' : qrCodeImage }
        });
    }

    function carregarCache() {
        const cache = local.ler(CHAVE_CACHE, null);
        if (!cache) return false;
        produtos = cache.produtos || [];
        chavePix = cache.config?.chavePix || '';
        titularPix = cache.config?.titularPix || '';
        qrCodeImage = cache.config?.qrCodeImage || '';
        renderizarProdutos();
        return produtos.length > 0;
    }

    async function carregarDados() {
        clearTimeout(timerRetentativa);
        definirStatus('conectando', 'Conectando...');

        // As duas consultas em paralelo (antes eram em sequência)
        const [resProdutos, resConfig] = await Promise.all([
            db.from('produtos').select('id, nome, preco, imagem').order('id'),
            db.from('config').select('chave, valor')
        ]);

        const falha = resProdutos.error ? resProdutos : (resConfig.error ? resConfig : null);
        if (falha) {
            console.error('Erro ao carregar dados:', falha.error);
            const msg = mensagemDeErro(falha.error, falha.status);
            if (produtos.length > 0) {
                atualizarStatus('offline');
                aviso('Usando os produtos salvos no aparelho. ' + msg, 'alerta', 5000);
            } else {
                mostrarErroCarregamento(msg);
            }
            if (ehErroDeRede(falha.error, falha.status)) {
                timerRetentativa = setTimeout(carregarDados, 15000);
            }
            return;
        }

        produtos = (resProdutos.data || []).map(p => ({ ...p, preco: Number(p.preco) }));
        aplicarConfig(resConfig.data);
        renderizarProdutos();
        atualizarCarrinho();
        salvarCache();
        atualizarStatus('online');
    }

    function mostrarErroCarregamento(msg) {
        gradeProdutos.innerHTML = `
            <div class="painel-erro">
                <p><strong>Não foi possível carregar os produtos.</strong></p>
                <p>${esc(msg)}</p>
                <button class="btn btn-primario" data-acao="recarregar">Tentar novamente</button>
                <p class="dica">Nova tentativa automática em 15 segundos.</p>
            </div>`;
        atualizarStatus('offline');
    }

    // ============================================================
    // TEMPO REAL: bloqueio, Pix e produtos atualizam sozinhos
    // ============================================================
    function assinarRealtime() {
        db.channel('atendimento')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'config' }, payload => {
                if (payload.new && payload.new.chave) {
                    aplicarConfig([payload.new]);
                    salvarCache();
                }
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'produtos' }, () => {
                // Pequeno atraso para agrupar várias alterações seguidas do gestor
                clearTimeout(assinarRealtime._t);
                assinarRealtime._t = setTimeout(carregarDados, 800);
            })
            .subscribe(status => {
                realtimeAtivo = status === 'SUBSCRIBED';
                if (status === 'SUBSCRIBED') verificarBloqueio();
            });
    }

    // ============================================================
    // PRODUTOS
    // ============================================================
    function renderizarProdutos() {
        if (!produtos.length) {
            gradeProdutos.innerHTML = '<div class="vazio" style="grid-column:1/-1;">Nenhum produto cadastrado</div>';
            return;
        }
        const frag = document.createDocumentFragment();
        produtos.forEach(p => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'cartao-produto';
            card.dataset.produto = p.id;
            const inicial = esc((p.nome || '?').charAt(0).toUpperCase());
            card.innerHTML = `
                <div class="foto-produto" data-inicial="${inicial}">${p.imagem
                    ? `<img src="${esc(p.imagem)}" alt="${esc(p.nome)}" loading="lazy" decoding="async" crossorigin="anonymous">`
                    : inicial}</div>
                <div class="nome-produto">${esc(p.nome)}</div>
                <div class="preco-produto">${formatarPreco(p.preco)}</div>`;
            frag.appendChild(card);
        });
        gradeProdutos.replaceChildren(frag);
    }

    function adicionarAoCarrinho(id) {
        if (sistemaBloqueado) return aviso('Sistema bloqueado. Aguarde a liberação.', 'alerta');
        const p = produtos.find(x => String(x.id) === String(id));
        if (!p) return;
        const existente = carrinho.find(i => i.id === p.id);
        if (existente) existente.quantidade += 1;
        else carrinho.push({ id: p.id, nome: p.nome, preco: Number(p.preco), quantidade: 1 });
        atualizarCarrinho();
    }

    // ============================================================
    // CARRINHO
    // ============================================================
    function totalDoCarrinho() {
        return centavos(carrinho.reduce((acc, i) => acc + i.preco * i.quantidade, 0));
    }

    function atualizarCarrinho() {
        if (!carrinho.length) {
            listaCarrinho.innerHTML = '<div class="vazio" style="padding:12px;">Carrinho vazio</div>';
            totalCarrinho.textContent = `Total: ${formatarPreco(0)}`;
            return;
        }
        listaCarrinho.innerHTML = carrinho.map((item, index) => `
            <div class="item-carrinho">
                <div class="info-produto"><strong>${esc(item.nome)}</strong></div>
                <div class="controles">
                    <button type="button" data-acao="menos" data-index="${index}" aria-label="Diminuir">-</button>
                    <span class="qtd">${item.quantidade}</span>
                    <button type="button" data-acao="mais" data-index="${index}" aria-label="Aumentar">+</button>
                    <button type="button" data-acao="remover" data-index="${index}" class="btn-excluir-item">Excluir</button>
                </div>
                <div class="preco-item">${formatarPreco(item.preco * item.quantidade)}</div>
            </div>`).join('');
        totalCarrinho.textContent = `Total: ${formatarPreco(totalDoCarrinho())}`;
    }

    function alterarQuantidade(index, delta) {
        if (sistemaBloqueado) return aviso('Sistema bloqueado.', 'alerta');
        const item = carrinho[index];
        if (!item) return;
        item.quantidade += delta;
        if (item.quantidade <= 0) carrinho.splice(index, 1);
        atualizarCarrinho();
    }

    // ============================================================
    // FLUXO DA VENDA
    // ============================================================
    function gerarIdUnico() {
        // Gerado UMA vez por venda: se a gravação for repetida, o banco reconhece o mesmo id
        return Date.now() * 1000 + Math.floor(Math.random() * 1000);
    }

    function encerrarVenda() {
        if (sistemaBloqueado) return aviso('Sistema bloqueado.', 'alerta');
        if (!carrinho.length) return aviso('Adicione produtos ao carrinho primeiro.', 'alerta');

        vendaAtual = {
            id: gerarIdUnico(),
            itens: carrinho.map(i => ({ id: i.id, nome: i.nome, preco: i.preco, quantidade: i.quantidade })),
            total: totalDoCarrinho(),
            pagamento: null,
            status: 'pendente'
        };

        conteudoResumoVenda.innerHTML = vendaAtual.itens.map(item => `
            <div class="linha-resumo">
                <span>${esc(item.nome)} x${item.quantidade}</span>
                <span><strong>${formatarPreco(item.preco * item.quantidade)}</strong></span>
            </div>`).join('') +
            `<div class="total-resumo">Total: ${formatarPreco(vendaAtual.total)}</div>`;
        modalResumoVenda.classList.add('ativo');
    }

    function cancelarVenda() {
        [modalResumoVenda, modalQRCode, modalPagamento].forEach(m => m.classList.remove('ativo'));
        vendaAtual = null;
        pagamentoSelecionado = null;
    }

    function processarPagamento(pagamento) {
        if (sistemaBloqueado) return aviso('Sistema bloqueado.', 'alerta');
        if (!vendaAtual) return;
        pagamentoSelecionado = pagamento;
        vendaAtual.pagamento = pagamento;
        modalResumoVenda.classList.remove('ativo');

        if (pagamento === 'pix') {
            chavePixModal.textContent = 'Chave Pix: ' + (chavePix || '(não configurada)');
            titularPixModal.textContent = 'Titular: ' + (titularPix || '(não configurado)');
            if (qrCodeImage) {
                const img = document.createElement('img');
                if (!qrCodeImage.startsWith('data:')) img.crossOrigin = 'anonymous';
                img.src = qrCodeImage;
                img.alt = 'QR Code Pix';
                qrPlaceholder.replaceChildren(img);
                qrPlaceholder.classList.add('has-image');
            } else {
                qrPlaceholder.textContent = 'QR CODE';
                qrPlaceholder.classList.remove('has-image');
            }
            modalQRCode.classList.add('ativo');
        } else {
            modalPagamento.classList.add('ativo');
        }
    }

    async function confirmarPagamento() {
        if (sistemaBloqueado) return aviso('Sistema bloqueado.', 'alerta');
        if (!vendaAtual) return;

        const registro = {
            id: vendaAtual.id,
            itens: vendaAtual.itens,
            total: vendaAtual.total,
            pagamento: vendaAtual.pagamento,
            status: 'pago',
            data: new Date().toISOString()
        };

        const resultado = await gravarVenda(registro);

        if (resultado === 'erro-regra') return; // mensagem já exibida; modal continua aberto

        if (resultado === 'pendente') {
            adicionarPendente(registro);
            textoSucesso.textContent = 'Venda registrada no aparelho! Será enviada quando a conexão voltar.';
        } else {
            textoSucesso.textContent = 'Venda realizada com sucesso!';
        }

        modalPagamento.classList.remove('ativo');
        modalSucesso.classList.add('ativo');
        setTimeout(() => modalSucesso.classList.remove('ativo'), 1800);
        carrinho = [];
        atualizarCarrinho();
        vendaAtual = null;
        pagamentoSelecionado = null;
    }

    // Retorna 'ok' | 'pendente' (falha de rede) | 'erro-regra'
    async function gravarVenda(registro, silencioso = false) {
        const { error, status } = await db.from('vendas').insert(registro);
        if (!error) return 'ok';
        if (error.code === '23505') return 'ok'; // já gravada antes (clique repetido / reenvio)
        if (ehErroDeRede(error, status)) return 'pendente';
        console.error('Erro ao salvar venda:', error);
        if (!silencioso) aviso('Erro ao salvar venda: ' + mensagemDeErro(error, status), 'erro', 6000);
        return 'erro-regra';
    }

    // ============================================================
    // VENDAS PENDENTES (feitas sem internet)
    // ============================================================
    function lerPendentes() { return local.ler(CHAVE_PENDENTES, []); }

    function adicionarPendente(registro) {
        const lista = lerPendentes();
        if (!lista.some(v => v.id === registro.id)) lista.push(registro);
        if (!local.gravar(CHAVE_PENDENTES, lista)) {
            aviso('ATENÇÃO: não foi possível guardar a venda no aparelho. Anote-a manualmente.', 'erro', 10000);
        }
        atualizarStatus();
    }

    async function sincronizarPendentes() {
        if (sincronizando || !navigator.onLine) return;
        const lista = lerPendentes();
        if (!lista.length) return;
        sincronizando = true;
        try {
            const final = [];
            for (let i = 0; i < lista.length; i++) {
                const resultado = await gravarVenda(lista[i], true);
                if (resultado === 'pendente') { final.push(...lista.slice(i)); break; } // rede caiu: para aqui
                if (resultado === 'erro-regra') final.push(lista[i]);
            }
            local.gravar(CHAVE_PENDENTES, final);
            const enviadas = lista.length - final.length;
            if (enviadas > 0) aviso(`${enviadas} venda(s) pendente(s) enviada(s) ao banco.`, 'sucesso');
        } finally {
            sincronizando = false;
            atualizarStatus();
        }
    }

    let ultimoEstado = 'conectando';
    function atualizarStatus(estado) {
        if (estado) ultimoEstado = estado;
        const qtd = lerPendentes().length;
        const extra = qtd ? ` · ${qtd} venda(s) aguardando envio` : '';
        if (ultimoEstado === 'online') definirStatus(qtd ? 'conectando' : 'online', 'Conectado' + extra);
        else if (ultimoEstado === 'offline') definirStatus('offline', 'Sem conexão com o banco' + extra);
        else definirStatus('conectando', 'Conectando...' + extra);
    }

    // ============================================================
    // EVENTOS (delegação: um único ouvinte para todos os botões)
    // ============================================================
    document.addEventListener('click', e => {
        const card = e.target.closest('[data-produto]');
        if (card) return adicionarAoCarrinho(card.dataset.produto);

        const alvo = e.target.closest('button');
        if (!alvo) return;
        const acao = alvo.dataset.acao;
        const index = Number(alvo.dataset.index);

        if (acao === 'mais') return alterarQuantidade(index, 1);
        if (acao === 'menos') return alterarQuantidade(index, -1);
        if (acao === 'remover') return alterarQuantidade(index, -Infinity);
        if (acao === 'recarregar') return carregarDados();
        if (alvo.dataset.pagamento) return processarPagamento(alvo.dataset.pagamento);

        switch (alvo.id) {
            case 'btnEncerrarVenda': return encerrarVenda();
            case 'btnCancelarResumo': return cancelarVenda();
            case 'btnSeguirQR':
                modalQRCode.classList.remove('ativo');
                return modalPagamento.classList.add('ativo');
            case 'btnFecharModalQR': return cancelarVenda();
            case 'btnPagamentoSim':
                return comBotaoOcupado(btnPagamentoSim, 'Salvando...', confirmarPagamento);
            case 'btnPagamentoNao':
                modalPagamento.classList.remove('ativo');
                return (pagamentoSelecionado === 'pix' ? modalQRCode : modalResumoVenda).classList.add('ativo');
            case 'btnLimparCarrinho':
                if (sistemaBloqueado) return aviso('Sistema bloqueado.', 'alerta');
                carrinho = [];
                vendaAtual = null;
                return atualizarCarrinho();
        }
    });

    // Imagem que não carrega: mostra a inicial do produto no lugar
    document.addEventListener('error', e => {
        const img = e.target;
        if (img.tagName === 'IMG' && img.parentElement?.classList.contains('foto-produto')) {
            img.parentElement.textContent = img.parentElement.dataset.inicial || '?';
        }
    }, true);

    window.addEventListener('online', () => { carregarDados(); sincronizarPendentes(); });

    // Quando o aparelho "acorda" ou a aba volta a aparecer, confere o estado
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { verificarBloqueio(); sincronizarPendentes(); }
    });

    // Reserva: a cada 30 s (só com a tela visível) confere bloqueio se o tempo real caiu,
    // e tenta enviar vendas pendentes
    setInterval(() => {
        if (document.hidden) return;
        if (!realtimeAtivo) verificarBloqueio();
        sincronizarPendentes();
    }, 30000);

    // ============================================================
    // INICIALIZAÇÃO
    // ============================================================
    carregarCache();          // mostra os produtos guardados na hora, sem esperar a rede
    atualizarCarrinho();
    carregarDados().then(sincronizarPendentes);
    assinarRealtime();
})();