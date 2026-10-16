/* ============================================================
   SERVICE WORKER - Pastoral Familiar
   Os arquivos do sistema são buscados na rede primeiro, então
   atualizações aparecem sozinhas. Aumente a VERSAO se trocar a
   versão do SDK ou a lista de arquivos abaixo.
   ============================================================ */
const VERSAO = 'pf-v2';
const CACHE_APP = `${VERSAO}-app`;
const CACHE_IMAGENS = 'pf-imagens';      // imagens dos produtos (nome de arquivo único: podem ficar)
const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';

const ARQUIVOS_APP = [
    './',
    './index.html',
    './gestao.html',
    './comum.js',
    './atendimento.js',
    './gestao.js',
    './manifest.json',
    './manifest-gestao.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png',
    './icons/apple-touch-icon.png',
    SDK
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_APP);
        // Um arquivo que falhe não impede a instalação dos demais
        await Promise.all(ARQUIVOS_APP.map(url =>
            cache.add(new Request(url, { cache: 'reload' })).catch(err => console.warn('SW: não armazenou', url, err))
        ));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const nomes = await caches.keys();
        await Promise.all(nomes
            .filter(n => n !== CACHE_APP && n !== CACHE_IMAGENS)
            .map(n => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;          // gravações vão sempre direto à rede

    const url = new URL(req.url);

    // Supabase: dados, login e tempo real NUNCA passam pelo cache (sempre atualizados)
    if (url.hostname.endsWith('.supabase.co')) {
        if (url.pathname.includes('/storage/v1/object/public/')) {
            event.respondWith(imagemCacheada(req));
        }
        return;
    }

    // Arquivos do próprio sistema (HTML, JS, ícones): rede primeiro, para que uma
    // atualização publicada apareça na hora; cache se estiver sem internet ou lento
    if (url.origin === self.location.origin) {
        event.respondWith(redePrimeiro(req));
        return;
    }

    // SDK do Supabase (versão fixa, nunca muda): cache primeiro
    if (req.url === SDK) {
        event.respondWith(cacheEAtualiza(req));
    }
});

async function redePrimeiro(req) {
    const ehPagina = req.mode === 'navigate';
    const cache = await caches.open(CACHE_APP);
    try {
        const controle = new AbortController();
        const timer = setTimeout(() => controle.abort(), ehPagina ? 5000 : 8000);
        const resp = await fetch(req, { signal: controle.signal });
        clearTimeout(timer);
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
    } catch (_) {
        const guardada = await cache.match(req, { ignoreSearch: true })
            || (ehPagina ? await cache.match('./index.html') : null);
        if (guardada) return guardada;
        return ehPagina
            ? new Response('<h1>Sem conexão</h1><p>Conecte-se à internet e tente novamente.</p>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 })
            : new Response('', { status: 504 });
    }
}

async function cacheEAtualiza(req) {
    const cache = await caches.open(CACHE_APP);
    const guardada = await cache.match(req, { ignoreSearch: true });
    const rede = fetch(req).then(resp => {
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
    }).catch(() => null);
    return guardada || (await rede) || new Response('', { status: 504 });
}

async function imagemCacheada(req) {
    const cache = await caches.open(CACHE_IMAGENS);
    const guardada = await cache.match(req);
    if (guardada) return guardada;
    try {
        const resp = await fetch(req);
        if (resp.ok) {
            cache.put(req, resp.clone());
            limitarCache(cache, 80);
        }
        return resp;
    } catch (_) {
        return new Response('', { status: 504 });
    }
}

// Evita que imagens trocadas várias vezes acumulem espaço no aparelho
async function limitarCache(cache, maximo) {
    const chaves = await cache.keys();
    for (let i = 0; i < chaves.length - maximo; i++) await cache.delete(chaves[i]);
}
