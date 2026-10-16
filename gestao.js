/* ============================================================
   PASTORAL FAMILIAR - GESTÃO
   ============================================================ */
(function () {
    'use strict';
    const {
        db, esc, formatarPreco, centavos, ehErroDeRede, mensagemDeErro, definirStatus, aviso,
        comBotaoOcupado, redimensionarImagem, enviarImagem, removerImagem
    } = window.PF;

    const LIMITE_LISTA = 200;  // vendas exibidas na lista (os totais consideram todas)

    // ---------- Estado ----------
    let produtos = [];
    let vendas = [];
    const cfg = { chavePix: '', titularPix: '', qrCodeImage: '', sistemaBloqueado: false };
    let canal = null;
    let painelAtivo = false;
    let timerRender = null;

    // ---------- DOM ----------
    const $ = id => document.getElementById(id);
    const conteudoGestao = $('conteudoGestao');
    const modalLogin = $('modalLogin');
    const formLogin = $('formLogin');
    const inputEmail = $('inputEmail');
    const inputSenha = $('inputSenha');
    const erroLogin = $('erroLogin');
    const btnLogin = $('btnLogin');
    const btnSair = $('btnSair');
    const listaVendasVertical = $('listaVendasVertical');
    const totalVendas = $('totalVendas');
    const quantidadeVendida = $('quantidadeVendida');
    const corpoTotalProdutos = $('corpoTotalProdutos');
    const areaEdicaoProdutos = $('areaEdicaoProdutos');
    const inputChavePix = $('inputChavePix');
    const inputTitularPix = $('inputTitularPix');
    const inputQRCode = $('inputQRCode');
    const previewQR = $('previewQR');
    const btnBloqueio = $('btnBloqueio');
    const avisoMigracao = $('avisoMigracao');

    // ============================================================
    // LOGIN (Supabase Auth — a senha não fica mais no código)
    // ============================================================
    function mostrarLogin(mensagem) {
        painelAtivo = false;
        conteudoGestao.classList.add('hidden');
        btnSair.classList.add('hidden');
        modalLogin.classList.add('ativo');
        erroLogin.textContent = mensagem || '';
        erroLogin.style.display = mensagem ? 'block' : 'none';
        if (canal) { db.removeChannel(canal); canal = null; }
        setTimeout(() => (inputEmail.value ? inputSenha : inputEmail).focus(), 50);
    }

    async function fazerLogin() {
        const email = inputEmail.value.trim();
        const password = inputSenha.value;
        if (!email || !password) {
            erroLogin.textContent = 'Informe e-mail e senha.';
            erroLogin.style.display = 'block';
            return;
        }
        erroLogin.style.display = 'none';
        const { error, status } = await db.auth.signInWithPassword({ email, password });
        if (error) {
            erroLogin.textContent = '❌ ' + mensagemDeErro(error, status);
            erroLogin.style.display = 'block';
            inputSenha.value = '';
            inputSenha.focus();
            return;
        }
        inputSenha.value = '';
        await entrarNoPainel();
    }

    async function entrarNoPainel() {
        // Confere no banco se o usuário logado está na lista de gestores
        const { data: ehGestor, error, status } = await db.rpc('eh_gestor');
        if (error) {
            if (ehErroDeRede(error, status)) return mostrarLogin('❌ ' + mensagemDeErro(error, status));
            await db.auth.signOut();
            return mostrarLogin('❌ ' + mensagemDeErro(error, status));
        }
        if (ehGestor !== true) {
            await db.auth.signOut();
            return mostrarLogin('❌ Este usuário não está cadastrado como gestor.');
        }
        modalLogin.classList.remove('ativo');
        conteudoGestao.classList.remove('hidden');
        btnSair.classList.remove('hidden');
        if (!painelAtivo) {
            painelAtivo = true;
            await carregarDados();
            assinarRealtime();
        }
    }

    db.auth.onAuthStateChange(evento => {
        if (evento === 'SIGNED_OUT') mostrarLogin();
    });

    // ============================================================
    // CARREGAR DADOS (três consultas em paralelo)
    // ============================================================
    function normalizarVenda(v) {
        let itens = v.itens;
        if (typeof itens === 'string') { try { itens = JSON.parse(itens); } catch (_) { itens = []; } }
        if (!Array.isArray(itens)) itens = [];
        return {
            ...v,
            total: Number(v.total) || 0,
            itens: itens.map(i => ({
                nome: i.nome, preco: Number(i.preco) || 0, quantidade: Number(i.quantidade) || 0
            }))
        };
    }

    async function carregarDados() {
        definirStatus('conectando', 'Carregando...');
        listaVendasVertical.innerHTML = '<div class="vazio">Carregando vendas...</div>';

        const [rp, rc, rv] = await Promise.all([
            db.from('produtos').select('id, nome, preco, imagem').order('id'),
            db.from('config').select('chave, valor'),
            db.from('vendas').select('id, itens, total, pagamento, status, data').order('data', { ascending: false })
        ]);

        const falha = [rp, rc, rv].find(r => r.error);
        if (falha) {
            console.error('Erro ao carregar dados:', falha.error);
            const msg = mensagemDeErro(falha.error, falha.status);
            definirStatus('offline', 'Erro de conexão');
            listaVendasVertical.innerHTML = `
                <div class="painel-erro">
                    <p><strong>Não foi possível carregar os dados.</strong></p>
                    <p>${esc(msg)}</p>
                    <button type="button" class="btn btn-primario" data-acao="recarregar">Tentar novamente</button>
                </div>`;
            return;
        }

        produtos = (rp.data || []).map(p => ({ ...p, preco: Number(p.preco) }));
        (rc.data || []).forEach(aplicarItemConfig);
        vendas = (rv.data || []).map(normalizarVenda);

        inputChavePix.value = cfg.chavePix;
        inputTitularPix.value = cfg.titularPix;
        mostrarPreviewQR();
        atualizarBotaoBloqueio();
        renderizarEdicaoProdutos();
        atualizarGestao();
        definirStatus('online', 'Conectado');

        migrarImagensAntigas();
    }

    function aplicarItemConfig(item) {
        if (!item || !item.chave) return;
        if (item.chave === 'chavePix') cfg.chavePix = item.valor || '';
        if (item.chave === 'titularPix') cfg.titularPix = item.valor || '';
        if (item.chave === 'qrCodeImage') cfg.qrCodeImage = item.valor || '';
        if (item.chave === 'sistemaBloqueado') cfg.sistemaBloqueado = item.valor === 'true';
    }

    function mostrarPreviewQR() {
        if (cfg.qrCodeImage) {
            const img = document.createElement('img');
            if (!cfg.qrCodeImage.startsWith('data:')) img.crossOrigin = 'anonymous';
            img.src = cfg.qrCodeImage;
            img.alt = 'QR Code Pix';
            previewQR.replaceChildren(img);
        } else {
            previewQR.replaceChildren();
        }
    }

    // ============================================================
    // TEMPO REAL: novas vendas aparecem sozinhas
    // ============================================================
    function assinarRealtime() {
        if (canal) db.removeChannel(canal);
        canal = db.channel('gestao')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'vendas' }, payload => {
                const v = normalizarVenda(payload.new);
                if (!vendas.some(x => String(x.id) === String(v.id))) {
                    vendas.unshift(v);
                    agendarRender();
                }
            })
            .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'vendas' }, payload => {
                const id = payload.old && payload.old.id;
                if (id == null) return;
                vendas = vendas.filter(x => String(x.id) !== String(id));
                agendarRender();
            })
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'config' }, payload => {
                if (payload.new && payload.new.chave === 'sistemaBloqueado') {
                    aplicarItemConfig(payload.new);
                    atualizarBotaoBloqueio();
                }
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED') definirStatus('online', 'Conectado · atualização automática');
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') definirStatus('conectando', 'Conectado · sem atualização automática');
            });
    }

    function agendarRender() {
        clearTimeout(timerRender);
        timerRender = setTimeout(atualizarGestao, 300);
    }

    // ============================================================
    // PRODUTOS
    // ============================================================
    function criarLinhaProduto(p) {
        const div = document.createElement('div');
        div.className = 'produto-edit-item';
        div.dataset.id = p.id;
        div.innerHTML = `
            <div class="preview-mini"></div>
            <div class="campo">
                <label>Nome</label>
                <input type="text" class="edit-nome" maxlength="80">
            </div>
            <div class="campo">
                <label>Preço (R$)</label>
                <input type="number" class="edit-preco" step="0.01" min="0" inputmode="decimal">
            </div>
            <div class="campo">
                <label>Imagem</label>
                <input type="file" class="edit-imagem" accept="image/*">
            </div>
            <button type="button" class="btn btn-danger" data-acao="remover-produto" style="padding:6px 16px; font-size:13px;">Remover</button>`;
        // Valores atribuídos pela propriedade .value: aspas e símbolos no nome não quebram a tela
        div.querySelector('.edit-nome').value = p.nome || '';
        div.querySelector('.edit-preco').value = Number.isFinite(p.preco) ? p.preco : '';
        atualizarMiniatura(div, p);
        return div;
    }

    function atualizarMiniatura(linha, p) {
        const mini = linha.querySelector('.preview-mini');
        if (p.imagem) {
            const img = document.createElement('img');
            if (!String(p.imagem).startsWith('data:')) img.crossOrigin = 'anonymous';
            img.src = p.imagem;
            img.alt = p.nome || '';
            img.loading = 'lazy';
            mini.replaceChildren(img);
        } else {
            const span = document.createElement('span');
            span.textContent = (p.nome || '?').charAt(0).toUpperCase();
            mini.replaceChildren(span);
        }
    }

    function renderizarEdicaoProdutos() {
        if (!produtos.length) {
            areaEdicaoProdutos.innerHTML = '<p class="vazio">Nenhum produto cadastrado</p>';
            return;
        }
        const frag = document.createDocumentFragment();
        produtos.forEach(p => frag.appendChild(criarLinhaProduto(p)));
        areaEdicaoProdutos.replaceChildren(frag);
    }

    const produtoPorId = id => produtos.find(p => String(p.id) === String(id));

    // Marca a linha alterada (borda laranja) para o gestor saber o que falta salvar
    areaEdicaoProdutos.addEventListener('input', e => {
        const linha = e.target.closest('.produto-edit-item');
        if (!linha || e.target.type === 'file') return;
        const p = produtoPorId(linha.dataset.id);
        if (!p) return;
        const nome = linha.querySelector('.edit-nome').value.trim();
        const preco = centavos(String(linha.querySelector('.edit-preco').value).replace(',', '.'));
        linha.classList.toggle('alterado', nome !== p.nome || preco !== centavos(p.preco));
    });

    // Troca de imagem: reduz no aparelho, envia ao Storage e grava só a URL
    areaEdicaoProdutos.addEventListener('change', async e => {
        const input = e.target;
        if (!input.classList.contains('edit-imagem')) return;
        const linha = input.closest('.produto-edit-item');
        const p = produtoPorId(linha.dataset.id);
        const arquivo = input.files && input.files[0];
        if (!p || !arquivo) return;

        const mini = linha.querySelector('.preview-mini');
        mini.classList.add('enviando');
        input.disabled = true;
        try {
            const blob = await redimensionarImagem(arquivo, 600, 'image/jpeg', 0.82);
            const url = await enviarImagem(blob, 'produtos');
            const { data, error, status } = await db.from('produtos').update({ imagem: url }).eq('id', p.id).select('id');
            if (error) throw Object.assign(error, { status });
            if (!data || !data.length) throw new Error('permission denied: produto não atualizado');
            const antiga = p.imagem;
            p.imagem = url;
            atualizarMiniatura(linha, p);
            removerImagem(antiga);
            aviso(`Imagem de "${p.nome}" atualizada (${Math.round(blob.size / 1024)} KB).`, 'sucesso');
        } catch (err) {
            console.error('Erro ao enviar imagem:', err);
            aviso('Erro ao enviar imagem: ' + mensagemDeErro(err, err.status), 'erro', 6000);
        } finally {
            mini.classList.remove('enviando');
            input.disabled = false;
            input.value = '';
        }
    });

    async function salvarProdutos() {
        const alteracoes = [];
        for (const linha of areaEdicaoProdutos.querySelectorAll('.produto-edit-item')) {
            const p = produtoPorId(linha.dataset.id);
            if (!p) continue;
            const nome = linha.querySelector('.edit-nome').value.trim();
            const precoTexto = String(linha.querySelector('.edit-preco').value).replace(',', '.');
            const preco = centavos(precoTexto);
            if (!nome) return aviso('Há produto sem nome. Preencha antes de salvar.', 'alerta');
            if (precoTexto === '' || !Number.isFinite(preco) || preco < 0) {
                return aviso(`Preço inválido em "${nome}".`, 'alerta');
            }
            if (nome !== p.nome || preco !== centavos(p.preco)) alteracoes.push({ p, linha, nome, preco });
        }
        if (!alteracoes.length) return aviso('Nenhuma alteração para salvar.', 'info');

        // Só os produtos alterados, só nome e preço (sem reenviar imagens), todos em paralelo
        const resultados = await Promise.all(alteracoes.map(a =>
            db.from('produtos').update({ nome: a.nome, preco: a.preco }).eq('id', a.p.id).select('id')
        ));

        let falhas = 0;
        let ultimaMsg = '';
        resultados.forEach((r, i) => {
            const a = alteracoes[i];
            if (r.error || !r.data || !r.data.length) {
                falhas++;
                ultimaMsg = r.error ? mensagemDeErro(r.error, r.status) : 'Sem permissão para alterar.';
                return;
            }
            a.p.nome = a.nome;
            a.p.preco = a.preco;
            a.linha.classList.remove('alterado');
            atualizarMiniatura(a.linha, a.p);
        });

        if (falhas) aviso(`${falhas} produto(s) não foram salvos: ${ultimaMsg}`, 'erro', 6000);
        else aviso(`✅ ${alteracoes.length} produto(s) atualizado(s).`, 'sucesso');
    }

    async function adicionarProduto() {
        const nome = (prompt('Digite o nome do novo produto:') || '').trim();
        if (!nome) return;
        const precoStr = prompt('Digite o preço do produto (ex: 10,50):');
        if (precoStr == null) return;
        const preco = centavos(precoStr.replace(',', '.'));
        if (!Number.isFinite(preco) || preco <= 0) return aviso('Preço inválido. Digite um valor positivo.', 'alerta');

        const { data, error, status } = await db.from('produtos')
            .insert({ nome, preco, imagem: null }).select('id, nome, preco, imagem');
        if (error || !data || !data.length) {
            console.error('Erro ao adicionar produto:', error);
            return aviso('Erro ao adicionar produto: ' + mensagemDeErro(error || { message: 'sem retorno' }, status), 'erro', 6000);
        }
        const novo = { ...data[0], preco: Number(data[0].preco) };
        produtos.push(novo);
        // Acrescenta só a nova linha: edições não salvas nas outras linhas são preservadas
        if (!areaEdicaoProdutos.querySelector('.produto-edit-item')) areaEdicaoProdutos.replaceChildren();
        areaEdicaoProdutos.appendChild(criarLinhaProduto(novo));
        aviso(`✅ Produto "${novo.nome}" adicionado. Envie a imagem pelo campo "Imagem".`, 'sucesso', 5000);
    }

    async function removerProduto(linha) {
        const p = produtoPorId(linha.dataset.id);
        if (!p || !confirm(`Remover o produto "${p.nome}"?`)) return;
        const { data, error, status } = await db.from('produtos').delete().eq('id', p.id).select('id');
        if (error || !data || !data.length) {
            return aviso('Erro ao remover produto: ' +
                (error ? mensagemDeErro(error, status) : 'sem permissão ou produto inexistente.'), 'erro', 6000);
        }
        removerImagem(p.imagem);
        produtos = produtos.filter(x => x !== p);
        linha.remove();
        if (!produtos.length) renderizarEdicaoProdutos();
        aviso('Produto removido.', 'sucesso');
    }

    // ============================================================
    // CONFIGURAÇÕES (Pix, QR Code, bloqueio)
    // ============================================================
    // Atualiza a linha da tabela config; se ela não existir, cria.
    async function salvarConfig(chave, valor) {
        const upd = await db.from('config').update({ valor }).eq('chave', chave).select('chave');
        if (upd.error) throw Object.assign(upd.error, { status: upd.status });
        if (upd.data && upd.data.length) return;
        const ins = await db.from('config').insert({ chave, valor });
        if (ins.error) throw Object.assign(ins.error, { status: ins.status });
    }

    async function salvarConfiguracoes() {
        const chave = inputChavePix.value.trim();
        const titular = inputTitularPix.value.trim();
        if (!chave) return aviso('Informe a chave Pix.', 'alerta');
        if (!titular) return aviso('Informe o titular da chave Pix.', 'alerta');

        try {
            let novaUrlQR = null;
            const arquivo = inputQRCode.files && inputQRCode.files[0];
            if (arquivo) {
                // PNG para o QR Code continuar nítido; 800 px é mais do que suficiente
                const blob = await redimensionarImagem(arquivo, 800, 'image/png');
                novaUrlQR = await enviarImagem(blob, 'config');
            }

            await Promise.all([
                salvarConfig('chavePix', chave),
                salvarConfig('titularPix', titular),
                novaUrlQR ? salvarConfig('qrCodeImage', novaUrlQR) : Promise.resolve()
            ]);

            cfg.chavePix = chave;
            cfg.titularPix = titular;
            if (novaUrlQR) {
                removerImagem(cfg.qrCodeImage);
                cfg.qrCodeImage = novaUrlQR;
                mostrarPreviewQR();
                inputQRCode.value = '';
            }
            aviso('✅ Configurações salvas com sucesso!', 'sucesso');
        } catch (err) {
            console.error('Erro ao salvar configurações:', err);
            aviso('Erro ao salvar configurações: ' + mensagemDeErro(err, err.status), 'erro', 6000);
        }
    }

    function atualizarBotaoBloqueio() {
        btnBloqueio.textContent = cfg.sistemaBloqueado ? '🔓 Desbloquear Atendimento' : '🔒 Bloquear Atendimento';
        btnBloqueio.classList.toggle('bloqueado', cfg.sistemaBloqueado);
    }

    async function toggleBloqueio() {
        const novo = !cfg.sistemaBloqueado;
        try {
            await salvarConfig('sistemaBloqueado', String(novo));
            cfg.sistemaBloqueado = novo;
            aviso(novo ? '🔒 Atendimento BLOQUEADO.' : '🔓 Atendimento DESBLOQUEADO.', 'sucesso');
        } catch (err) {
            console.error('Erro ao alterar bloqueio:', err);
            aviso('Erro ao alterar bloqueio: ' + mensagemDeErro(err, err.status), 'erro', 6000);
        }
    }

    // ============================================================
    // VENDAS
    // ============================================================
    const rotuloPagamento = p => ({ pix: 'Pix', cartao: 'Cartão', dinheiro: 'Dinheiro' }[p] || p || '-');

    function atualizarGestao() {
        let totalGeral = 0;
        let qtdTotal = 0;
        const resumo = new Map();

        vendas.forEach(v => {
            totalGeral += v.total;
            v.itens.forEach(item => {
                qtdTotal += item.quantidade;
                const r = resumo.get(item.nome) || { quantidade: 0, total: 0 };
                r.quantidade += item.quantidade;
                r.total += item.preco * item.quantidade;
                resumo.set(item.nome, r);
            });
        });

        totalVendas.textContent = formatarPreco(centavos(totalGeral));
        quantidadeVendida.textContent = qtdTotal;

        if (!vendas.length) {
            listaVendasVertical.innerHTML = '<div class="vazio">Nenhuma venda registrada</div>';
        } else {
            const html = vendas.slice(0, LIMITE_LISTA).map(v => {
                const itensStr = v.itens.map(i => `${esc(i.nome)} (${i.quantidade})`).join(', ');
                const pago = v.status === 'pago';
                const dataFmt = v.data ? new Date(v.data).toLocaleString('pt-BR') : 'Data não disponível';
                return `
                    <div class="venda-item-vertical">
                        <div class="venda-header">
                            <span class="venda-id">#${esc(v.id)}</span>
                            <span class="venda-total">${formatarPreco(v.total)}</span>
                            <span class="badge-status ${pago ? 'badge-pago' : ''}">${pago ? 'Pago' : 'Pendente'}</span>
                        </div>
                        <div class="venda-detalhes">
                            <strong>Produtos:</strong> ${itensStr}<br>
                            <strong>Pagamento:</strong> ${esc(rotuloPagamento(v.pagamento))}<br>
                            <strong>Data:</strong> ${dataFmt}
                        </div>
                        <div class="venda-actions">
                            <button type="button" class="btn btn-danger" data-acao="excluir-venda" data-id="${esc(v.id)}" style="padding:4px 14px; font-size:13px;">Excluir</button>
                        </div>
                    </div>`;
            }).join('');
            const extra = vendas.length > LIMITE_LISTA
                ? `<div class="mais-vendas">Exibindo as ${LIMITE_LISTA} vendas mais recentes de ${vendas.length}. Os totais consideram todas.</div>`
                : '';
            listaVendasVertical.innerHTML = html + extra;
        }

        if (!resumo.size) {
            corpoTotalProdutos.innerHTML = '<tr><td colspan="3" class="vazio">Nenhuma venda registrada</td></tr>';
            return;
        }
        let linhas = '';
        let somaQtd = 0;
        let somaValor = 0;
        for (const [nome, d] of resumo) {
            somaQtd += d.quantidade;
            somaValor += d.total;
            linhas += `
                <tr>
                    <td><strong>${esc(nome)}</strong></td>
                    <td style="text-align:center;">${d.quantidade}</td>
                    <td style="text-align:right;"><strong>${formatarPreco(centavos(d.total))}</strong></td>
                </tr>`;
        }
        linhas += `
            <tr class="total-geral">
                <td><strong>TOTAL GERAL</strong></td>
                <td style="text-align:center;"><strong>${somaQtd}</strong></td>
                <td style="text-align:right;"><strong>${formatarPreco(centavos(somaValor))}</strong></td>
            </tr>`;
        corpoTotalProdutos.innerHTML = linhas;
    }

    async function excluirVenda(id) {
        if (!confirm(`Excluir venda #${id}?`)) return;
        const { data, error, status } = await db.from('vendas').delete().eq('id', id).select('id');
        if (error || !data || !data.length) {
            return aviso('Erro ao excluir venda: ' +
                (error ? mensagemDeErro(error, status) : 'sem permissão ou venda já excluída.'), 'erro', 6000);
        }
        vendas = vendas.filter(v => String(v.id) !== String(id));
        atualizarGestao();
    }

    async function excluirTodasVendas() {
        if (!vendas.length) return aviso('Não há vendas para excluir.', 'info');
        if (!confirm(`⚠️ Excluir TODAS as ${vendas.length} vendas? Esta ação não pode ser desfeita.`)) return;
        const { data, error, status } = await db.from('vendas').delete().not('id', 'is', null).select('id');
        if (error) return aviso('Erro ao excluir vendas: ' + mensagemDeErro(error, status), 'erro', 6000);
        if (!data || !data.length) return aviso('Nenhuma venda foi excluída (verifique as permissões).', 'erro', 6000);
        vendas = [];
        atualizarGestao();
        aviso(`✅ ${data.length} venda(s) excluída(s).`, 'sucesso');
    }

    // ============================================================
    // MIGRAÇÃO: imagens antigas em base64 -> Storage (roda uma vez, sozinha)
    // ============================================================
    let migrando = false;
    async function migrarImagensAntigas() {
        if (migrando) return;
        const ehBase64 = v => typeof v === 'string' && v.startsWith('data:');
        const pendentesProdutos = produtos.filter(p => ehBase64(p.imagem));
        const qrPendente = ehBase64(cfg.qrCodeImage);
        const total = pendentesProdutos.length + (qrPendente ? 1 : 0);
        if (!total) { avisoMigracao.classList.add('hidden'); return; }

        migrando = true;
        avisoMigracao.classList.remove('hidden');
        let feitos = 0;
        let falhas = 0;
        const progresso = () => {
            avisoMigracao.textContent = `⏳ Otimizando imagens antigas (${feitos}/${total})... não feche esta página.`;
        };
        progresso();

        try {
            for (const p of pendentesProdutos) {
                try {
                    const blob = await redimensionarImagem(p.imagem, 600, 'image/jpeg', 0.82);
                    const url = await enviarImagem(blob, 'produtos');
                    const { error } = await db.from('produtos').update({ imagem: url }).eq('id', p.id);
                    if (error) throw error;
                    p.imagem = url;
                    const linha = areaEdicaoProdutos.querySelector(`.produto-edit-item[data-id="${CSS.escape(String(p.id))}"]`);
                    if (linha) atualizarMiniatura(linha, p);
                } catch (err) {
                    falhas++;
                    console.error('Falha ao migrar imagem do produto', p.id, err);
                }
                feitos++;
                progresso();
            }
            if (qrPendente) {
                try {
                    const blob = await redimensionarImagem(cfg.qrCodeImage, 800, 'image/png');
                    const url = await enviarImagem(blob, 'config');
                    await salvarConfig('qrCodeImage', url);
                    cfg.qrCodeImage = url;
                    mostrarPreviewQR();
                } catch (err) {
                    falhas++;
                    console.error('Falha ao migrar QR Code', err);
                }
                feitos++;
                progresso();
            }
        } finally {
            migrando = false;
        }

        if (falhas) {
            avisoMigracao.textContent = `⚠️ ${falhas} imagem(ns) não puderam ser otimizadas. Confira se o script SQL foi executado e recarregue a página.`;
        } else {
            avisoMigracao.textContent = '✅ Imagens otimizadas! O atendimento agora carrega muito mais rápido.';
            setTimeout(() => avisoMigracao.classList.add('hidden'), 6000);
        }
    }

    // ============================================================
    // EVENTOS
    // ============================================================
    formLogin.addEventListener('submit', e => {
        e.preventDefault();
        comBotaoOcupado(btnLogin, 'Entrando...', fazerLogin);
    });

    document.addEventListener('click', e => {
        const alvo = e.target.closest('button');
        if (!alvo) return;
        const acao = alvo.dataset.acao;

        if (acao === 'recarregar') return comBotaoOcupado(alvo, 'Carregando...', carregarDados);
        if (acao === 'remover-produto') return comBotaoOcupado(alvo, '...', () => removerProduto(alvo.closest('.produto-edit-item')));
        if (acao === 'excluir-venda') return comBotaoOcupado(alvo, '...', () => excluirVenda(alvo.dataset.id));

        switch (alvo.id) {
            case 'btnSalvarConfig': return comBotaoOcupado(alvo, 'Salvando...', salvarConfiguracoes);
            case 'btnSalvarProdutos': return comBotaoOcupado(alvo, 'Salvando...', salvarProdutos);
            case 'btnAdicionarProduto': return comBotaoOcupado(alvo, 'Adicionando...', adicionarProduto);
            case 'btnBloqueio': return comBotaoOcupado(alvo, 'Aguarde...', toggleBloqueio).then(atualizarBotaoBloqueio);
            case 'btnExcluirTodasVendas': return comBotaoOcupado(alvo, 'Excluindo...', excluirTodasVendas);
            case 'btnAtualizar': return comBotaoOcupado(alvo, 'Atualizando...', carregarDados);
            case 'btnSair': return db.auth.signOut();
        }
    });

    // Prévia do QR Code antes de salvar
    inputQRCode.addEventListener('change', () => {
        const f = inputQRCode.files && inputQRCode.files[0];
        if (!f) return mostrarPreviewQR();
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.alt = 'Novo QR Code (ainda não salvo)';
        img.onload = () => URL.revokeObjectURL(img.src);
        previewQR.replaceChildren(img);
    });

    // Avisa se o gestor tentar sair com produtos alterados e não salvos
    window.addEventListener('beforeunload', e => {
        if (areaEdicaoProdutos.querySelector('.alterado') || migrando) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    window.addEventListener('online', () => { if (painelAtivo) carregarDados(); });

    // ============================================================
    // INICIALIZAÇÃO: se já houver sessão salva, entra direto
    // ============================================================
    (async () => {
        const { data } = await db.auth.getSession();
        if (data && data.session) await entrarNoPainel();
        else mostrarLogin();
    })();
})();