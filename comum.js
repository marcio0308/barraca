/* ============================================================
   PASTORAL FAMILIAR - CÓDIGO COMUM (atendimento e gestão)
   ============================================================ */
(function () {
    'use strict';

    // ---------- Configuração do Supabase ----------
    const SUPABASE_URL = 'https://ysdfnaoyyeplvxxgzvhv.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzZGZuYW95eWVwbHZ4eGd6dmh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMjIyOTYsImV4cCI6MjA5ODU5ODI5Nn0._5A6tieplyU7Oy2DPV93kUYAJLd4caevKLnS8ZuOu54';
    const BUCKET_IMAGENS = 'imagens';
    const TEMPO_LIMITE_MS = 20000; // 20 s: depois disso a requisição é cancelada

    // fetch com tempo limite: sem isso, uma conexão ruim deixa a tela "carregando" para sempre
    function fetchComTempoLimite(url, opcoes = {}) {
        const controle = new AbortController();
        const timer = setTimeout(() => controle.abort(), TEMPO_LIMITE_MS);
        if (opcoes.signal) {
            if (opcoes.signal.aborted) controle.abort();
            else opcoes.signal.addEventListener('abort', () => controle.abort());
        }
        return fetch(url, { ...opcoes, signal: controle.signal }).finally(() => clearTimeout(timer));
    }

    if (!window.supabase || !window.supabase.createClient) {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.insertAdjacentHTML('afterbegin',
                '<div style="background:#b05a3a;color:#fff;padding:14px;text-align:center;font-weight:600">' +
                'Não foi possível carregar a biblioteca do banco de dados. Verifique a internet e recarregue a página.</div>');
        });
        throw new Error('SDK do Supabase não carregou');
    }

    const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        global: { fetch: fetchComTempoLimite },
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 5 } }
    });

    // ---------- Utilidades ----------
    function esc(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    const formatoBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
    function formatarPreco(valor) {
        const n = Number(valor);
        return formatoBRL.format(Number.isFinite(n) ? n : 0);
    }

    // Arredonda para centavos (evita 0.1 + 0.2 = 0.30000000000000004)
    function centavos(valor) {
        return Math.round(Number(valor) * 100) / 100;
    }

    // Erro de rede/servidor indisponível (vale a pena tentar de novo) x erro de regra/permissão
    function ehErroDeRede(error, status) {
        if (!error) return false;
        if (status === 0 || status >= 500) return true;
        return /failed to fetch|networkerror|network request|abort|timeout|load failed/i.test(String(error.message || error));
    }

    function mensagemDeErro(error, status) {
        if (!error) return '';
        const msg = String(error.message || error);
        if (/abort/i.test(msg)) return 'O servidor demorou demais para responder. Tente novamente.';
        if (error.code === '42501' || /row-level security|permission denied|unauthorized/i.test(msg)) {
            return 'Sem permissão para esta operação (regras de segurança do banco).';
        }
        if (error.code === 'PGRST202' || /eh_gestor/i.test(msg)) {
            return 'O script SQL de configuração ainda não foi executado no Supabase.';
        }
        if (/bucket not found/i.test(msg)) {
            return 'O bucket "imagens" não existe no Storage. Execute o script SQL de configuração.';
        }
        if (ehErroDeRede(error, status)) {
            return navigator.onLine
                ? 'Não foi possível falar com o banco de dados. Verifique a internet ou se o projeto Supabase está pausado.'
                : 'Sem internet no aparelho.';
        }
        if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
        if (/email not confirmed/i.test(msg)) return 'E-mail ainda não confirmado no Supabase.';
        return msg;
    }

    // ---------- Status de conexão ----------
    function definirStatus(estado, texto) {
        const el = document.getElementById('statusConexao');
        if (!el) return;
        const icones = { online: '🟢', offline: '🔴', conectando: '🟡' };
        el.textContent = `${icones[estado] || ''} ${texto}`;
        el.className = estado;
    }

    window.addEventListener('offline', () => definirStatus('offline', 'Sem internet'));

    // ---------- Avisos (toast) não bloqueantes ----------
    function aviso(mensagem, tipo = 'info', duracao = 3500) {
        let area = document.getElementById('areaAvisos');
        if (!area) {
            area = document.createElement('div');
            area.id = 'areaAvisos';
            area.setAttribute('role', 'status');
            area.setAttribute('aria-live', 'polite');
            document.body.appendChild(area);
        }
        const el = document.createElement('div');
        el.className = `aviso aviso-${tipo}`;
        el.textContent = mensagem;
        area.appendChild(el);
        setTimeout(() => {
            el.classList.add('saindo');
            setTimeout(() => el.remove(), 300);
        }, duracao);
    }

    // Desabilita o botão durante a operação (impede clique duplo e venda duplicada)
    async function comBotaoOcupado(botao, textoOcupado, funcao) {
        if (!botao || botao.disabled) return;
        const textoOriginal = botao.textContent;
        botao.disabled = true;
        botao.classList.add('ocupado');
        if (textoOcupado) botao.textContent = textoOcupado;
        try {
            return await funcao();
        } finally {
            botao.disabled = false;
            botao.classList.remove('ocupado');
            botao.textContent = textoOriginal;
        }
    }

    // ---------- Imagens ----------
    function carregarImagem(origem) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = origem instanceof Blob ? URL.createObjectURL(origem) : origem;
            img.onload = () => { if (origem instanceof Blob) URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { if (origem instanceof Blob) URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
            img.src = url;
        });
    }

    // Reduz a imagem (lado maior = maxLado) e devolve um Blob leve
    async function redimensionarImagem(origem, maxLado = 600, tipo = 'image/jpeg', qualidade = 0.82) {
        const img = await carregarImagem(origem);
        const escala = Math.min(1, maxLado / Math.max(img.naturalWidth, img.naturalHeight));
        const largura = Math.max(1, Math.round(img.naturalWidth * escala));
        const altura = Math.max(1, Math.round(img.naturalHeight * escala));
        const canvas = document.createElement('canvas');
        canvas.width = largura;
        canvas.height = altura;
        const ctx = canvas.getContext('2d');
        if (tipo === 'image/jpeg') {           // JPEG não tem transparência: fundo branco
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, largura, altura);
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, largura, altura);
        return new Promise((resolve, reject) => {
            canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Falha ao processar imagem'))), tipo, qualidade);
        });
    }

    async function enviarImagem(blob, pasta) {
        const ext = blob.type === 'image/png' ? 'png' : 'jpg';
        const caminho = `${pasta}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error } = await db.storage.from(BUCKET_IMAGENS).upload(caminho, blob, {
            contentType: blob.type,
            cacheControl: '31536000', // 1 ano: o nome do arquivo muda a cada envio
            upsert: false
        });
        if (error) throw error;
        return db.storage.from(BUCKET_IMAGENS).getPublicUrl(caminho).data.publicUrl;
    }

    // Remove do Storage uma imagem antiga (só se for do nosso bucket)
    async function removerImagem(url) {
        if (!url || typeof url !== 'string') return;
        const marcador = `/storage/v1/object/public/${BUCKET_IMAGENS}/`;
        const pos = url.indexOf(marcador);
        if (pos === -1) return;
        const caminho = decodeURIComponent(url.slice(pos + marcador.length).split('?')[0]);
        try { await db.storage.from(BUCKET_IMAGENS).remove([caminho]); } catch (_) { /* não crítico */ }
    }

    // ---------- Armazenamento local seguro ----------
    const local = {
        ler(chave, padrao) {
            try { const v = localStorage.getItem(chave); return v ? JSON.parse(v) : padrao; }
            catch (_) { return padrao; }
        },
        gravar(chave, valor) {
            try { localStorage.setItem(chave, JSON.stringify(valor)); return true; }
            catch (_) { return false; }
        }
    };

    // ---------- Service Worker (PWA) ----------
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW não registrado:', err));
        });
    }

    window.PF = {
        db, esc, formatarPreco, centavos, ehErroDeRede, mensagemDeErro,
        definirStatus, aviso, comBotaoOcupado,
        redimensionarImagem, enviarImagem, removerImagem, local
    };
})();