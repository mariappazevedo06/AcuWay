'use strict';

const $ = id => document.getElementById(id);
const status = $('status');

const state = {
  origem: null,
  destino: null,
  rotas: [],
  selecionada: 0,
  modoMapa: 'destino',
  request: 0
};

const colors = [
  '#70e0ae', '#73baff', '#e8ad62',
  '#d3a0ed', '#f28f91', '#e2d16d',
  '#65d2d4'
];

const ROUTE_CONFIG = {
  maxRotas: 20,
  maxConsultasExtras: 16,
  desvioMaximo: 2.5,
  timeout: 15000
};

function atualizarIcones() {
  if (window.lucide) {
    lucide.createIcons();
  }
}

const map = L.map('map', {
  zoomControl: true
}).setView([-21.78, -41.05], 10);

L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }
).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);

let drawn = [];

function msg(texto) {
  status.textContent = texto;
}

function fmtKm(m) {
  return (m / 1000).toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1
  }) + ' km';
}

function fmtTime(s) {
  const m = Math.round(s / 60);
  return m < 60
    ? m + ' min'
    : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

function invalidate() {
  state.request++;
  state.rotas = [];
  state.selecionada = 0;
  routeLayer.clearLayers();
  drawn = [];

  $('lista').innerHTML =
    '<p class="empty">Busque rotas para visualizar alternativas.</p>';

  $('contagem').textContent = '0 rotas';
}

function setPoint(type, point) {
  state[type] = point;
  $(type).value = point.name;
  invalidate();
  markers();

  msg(
    (type === 'origem' ? 'Origem' : 'Destino') +
    ' definida.'
  );
}

function markers() {
  pointLayer.clearLayers();

  for (const type of ['origem', 'destino']) {
    const p = state[type];
    if (!p) continue;

    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 9,
      color: '#fff',
      weight: 2,
      fillColor: type === 'origem'
        ? '#36c58e'
        : '#e88d67',
      fillOpacity: 1
    }).addTo(pointLayer);

    const popup = document.createElement('div');
    popup.textContent =
      (type === 'origem' ? 'Origem: ' : 'Destino: ') +
      p.name;

    marker.bindPopup(popup);
  }
}

// PESQUISA DE LUGARES

function normalizeFeature(f) {
  const p = f.properties || {};
  const c = f.geometry?.coordinates;

  if (!c || c.length < 2) return null;

  const titulo =
    p.name || p.street || p.city ||
    p.locality || 'Local encontrado';

  const endereco = [
    p.street,
    p.housenumber,
    p.suburb || p.district,
    p.city || p.locality,
    p.state,
    p.country
  ].filter(Boolean);

  const descricao = [...new Set(endereco)].join(', ');

  return {
    lat: c[1],
    lon: c[0],
    name: descricao
      ? titulo + ' — ' + descricao
      : titulo,
    short: titulo
  };
}

function hide(type) {
  $('sug' + (
    type === 'origem' ? 'Origem' : 'Destino'
  )).hidden = true;
}

async function photon(q, signal) {
  const url = new URL('https://photon.komoot.io/api/');

  url.searchParams.set('q', q);
  url.searchParams.set('limit', '10');

  const centro = map.getCenter();

  url.searchParams.set('lat', centro.lat);
  url.searchParams.set('lon', centro.lng);

  const resposta = await fetch(url, { signal });

  if (!resposta.ok) {
    throw new Error(
      'Pesquisa indisponível (HTTP ' +
      resposta.status + ').'
    );
  }

  const dados = await resposta.json();
  return dados.features || [];
}

for (const type of ['origem', 'destino']) {
  const el = $(type);
  const box = $('sug' + (
    type === 'origem' ? 'Origem' : 'Destino'
  ));

  let timer;
  let ctrl;
  let seq = 0;

  el.addEventListener('input', () => {
    state[type] = null;
    invalidate();
    markers();

    clearTimeout(timer);
    ctrl?.abort();

    const current = ++seq;
    box.hidden = true;
    const q = el.value.trim();

    if (q.length < 3) {
      msg('Digite pelo menos 3 caracteres.');
      return;
    }

    msg('Pesquisando lugares...');

    timer = setTimeout(async () => {
      ctrl = new AbortController();

      try {
        const features = await photon(q, ctrl.signal);
        if (current !== seq) return;

        box.replaceChildren();
        const seen = new Set();

        for (const f of features) {
          const p = normalizeFeature(f);
          if (!p) continue;

          const chave =
            p.lat.toFixed(6) + ',' +
            p.lon.toFixed(6);

          if (seen.has(chave)) continue;
          seen.add(chave);

          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = p.short;

          const sm = document.createElement('small');
          sm.textContent = p.name;
          b.append(sm);

          b.addEventListener('click', () => {
            setPoint(type, p);
            box.hidden = true;
            el.focus();

            map.setView(
              [p.lat, p.lon],
              Math.max(map.getZoom(), 12)
            );
          });

          box.append(b);
        }

        if (!box.children.length) {
          const d = document.createElement('div');
          d.style.padding = '12px';
          d.textContent =
            'Nenhum local encontrado. Tente incluir cidade e estado.';
          box.append(d);
          msg('Nenhum local encontrado.');
        } else {
          msg(
            box.children.length +
            ' local(is) encontrado(s). Selecione uma sugestão.'
          );
        }

        box.hidden = false;
      } catch (e) {
        if (
          e.name !== 'AbortError' &&
          current === seq
        ) {
          msg(e.message);
        }
      }
    }, 750);
  });

  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') hide(type);

    if (e.key === 'Enter' && !box.hidden) {
      const b = box.querySelector('button');
      if (b) {
        e.preventDefault();
        b.click();
      }
    }
  });

  el.addEventListener('blur', () => {
    setTimeout(() => hide(type), 180);
  });
}

// CONTROLES DO MAPA

$('inverter').onclick = () => {
  const a = state.origem;
  const b = state.destino;

  state.origem = b;
  state.destino = a;

  $('origem').value = b?.name || '';
  $('destino').value = a?.name || '';

  invalidate();
  markers();
  msg('Origem e destino invertidos.');
};

$('localizar').onclick = () => {
  if (!navigator.geolocation) {
    msg('Geolocalização não suportada.');
    return;
  }

  if (!window.isSecureContext) {
    msg('A localização exige HTTPS ou localhost.');
    return;
  }

  msg('Solicitando sua localização...');

  navigator.geolocation.getCurrentPosition(
    pos => {
      const p = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        name: 'Minha localização atual'
      };

      setPoint('origem', p);
      map.setView([p.lat, p.lon], 14);
    },
    e => msg(
      e.code === 1
        ? 'Permissão de localização negada.'
        : 'Não foi possível obter a localização.'
    ),
    {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000
    }
  );
};

$('modoOrigem').onclick = () => {
  state.modoMapa = 'origem';
  msg('Clique no mapa para marcar a origem.');
};

$('modoDestino').onclick = () => {
  state.modoMapa = 'destino';
  msg('Clique no mapa para marcar o destino.');
};

map.on('click', e => {
  setPoint(state.modoMapa, {
    lat: e.latlng.lat,
    lon: e.latlng.lng,
    name:
      'Ponto no mapa (' +
      e.latlng.lat.toFixed(5) + ', ' +
      e.latlng.lng.toFixed(5) + ')'
  });

  state.modoMapa =
    state.modoMapa === 'origem'
      ? 'destino'
      : 'origem';
});

function bounds() {
  const layers = [
    ...pointLayer.getLayers(),
    ...routeLayer.getLayers()
  ];

  if (!layers.length) return;

  const g = L.featureGroup(layers);

  map.fitBounds(g.getBounds().pad(.15), {
    maxZoom: 15
  });
}

$('ajustar').onclick = bounds;

// DESENHO E SELEÇÃO DAS ROTAS

function draw() {
  routeLayer.clearLayers();
  drawn = [];

  state.rotas.forEach((r, i) => {
    const coords = r.geometry.coordinates.map(
      c => [c[1], c[0]]
    );

    const line = L.polyline(coords, {
      color: colors[i % colors.length],
      weight: i === state.selecionada ? 7 : 4,
      opacity: i === state.selecionada ? 1 : .65
    }).addTo(routeLayer);

    line.on('click', () => select(i));
    drawn.push(line);
  });

  drawn[state.selecionada]?.bringToFront();
}

function select(i) {
  if (!state.rotas[i] || !drawn[i]) return;

  state.selecionada = i;
  draw();
  render();

  map.fitBounds(drawn[i].getBounds().pad(.12), {
    maxZoom: 15
  });

  msg('Rota ' + (i + 1) + ' selecionada.');
}

// DISTÂNCIA GEOGRÁFICA

function distanciaMetros(a, b) {
  const R = 6371000;
  const rad = n => n * Math.PI / 180;

  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) *
    Math.cos(rad(b.lat)) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(x));
}

// GOOGLE MAPS: SELEÇÃO DE PONTOS
// Baseada nos trechos retornados pelo OSRM.
// Evita forçar pontos próximos às manobras e em vias sem nome.

function selecionarPontosPassagem(rota, limite = 2) {
  const coordenadas = rota.geometry?.coordinates || [];
  if (coordenadas.length < 3 || limite < 1) return [];

  const candidatos = [];

  for (const leg of rota.legs || []) {
    for (const step of leg.steps || []) {
      if (!step.geometry?.coordinates?.length) continue;
      if ((step.distance || 0) < 4000) continue; // Apenas trechos longos (>= 4 km)

      const nome = (step.name || '').trim();
      const ref = (step.ref || '').trim();
      if (!nome && !ref) continue;

      const pontos = step.geometry.coordinates;
      const meio = pontos[Math.floor(pontos.length / 2)];

      candidatos.push({
        lat: meio[1],
        lon: meio[0],
        distancia: step.distance,
        prioridade: ref ? 2 : 1 // Prioriza rodovias identificadas (BR/RJ)
      });
    }
  }

  if (!candidatos.length) return [];

  // Ordena priorizando rodovias (ref) e trechos mais longos
  candidatos.sort((a, b) => (b.prioridade - a.prioridade) || (b.distancia - a.distancia));

  const quantidade = Math.min(limite, candidatos.length, rota.distance > 50000 ? 2 : 1);
  return candidatos.slice(0, quantidade).map(p => ({ lat: p.lat, lon: p.lon }));
}
// GERAÇÃO DO LINK DO GOOGLE MAPS

function googleLink(rota, usarPontos = true) {
  const url = new URL(
    'https://www.google.com/maps/dir/'
  );

  url.searchParams.set('api', '1');

  url.searchParams.set(
    'origin',
    state.origem.lat + ',' + state.origem.lon
  );

  url.searchParams.set(
    'destination',
    state.destino.lat + ',' + state.destino.lon
  );

  url.searchParams.set('travelmode', 'driving');

  const navegadorMovel =
    /Android|iPhone|iPad|iPod/i.test(
      navigator.userAgent
    );

  const limite = navegadorMovel ? 3 : 3;

  const pontos = usarPontos
    ? selecionarPontosPassagem(rota, limite)
    : [];

  if (pontos.length) {
    url.searchParams.set(
      'waypoints',
      pontos.map(p =>
        p.lat.toFixed(6) + ',' +
        p.lon.toFixed(6)
      ).join('|')
    );
  }

  console.log(
    'SECURWAY | Google Maps',
    {
      distanciaOriginal: fmtKm(rota.distance),
      quantidadePontos: pontos.length,
      pontos,
      url: url.toString()
    }
  );

  return url.toString();
}

// IDENTIFICAÇÃO DAS VIAS

function identificarVias(rota) {
  const vias = [];
  const nomes = new Set();

  for (const trecho of rota.legs || []) {
    for (const etapa of trecho.steps || []) {
      const nome = etapa.name?.trim();
      if (!nome) continue;

      const chave = nome.toLowerCase();

      if (!nomes.has(chave)) {
        nomes.add(chave);
        vias.push(nome);
      }
    }
  }

  return vias;
}

// RESULTADOS E BOTÕES

function render() {
  const list = $('lista');
  list.replaceChildren();

  $('contagem').textContent =
    state.rotas.length + ' rota' +
    (state.rotas.length === 1 ? '' : 's');

  state.rotas.forEach((r, i) => {
    const card = document.createElement('div');
    const b = document.createElement('button');

    b.className = 'route' +
      (i === state.selecionada ? ' active' : '');

    b.type = 'button';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colors[i % colors.length];

    b.append(
      dot,
      document.createTextNode(
        i === 0 ? 'Rota principal' : 'Alternativa ' + i
      )
    );

    const sm = document.createElement('small');
    sm.textContent =
      fmtKm(r.distance) + ' • ' + fmtTime(r.duration);

    b.append(sm);

    const vias = identificarVias(r);

    if (vias.length) {
      const detalhes = document.createElement('small');

      detalhes.textContent =
        'Principais vias: ' +
        vias.slice(0, 5).join(' • ');

      detalhes.style.marginTop = '8px';
      b.append(detalhes);
    }

    b.onclick = () => select(i);
    card.append(b);

    if (i === state.selecionada) {
      const tools = document.createElement('div');
      tools.className = 'route-tools';

      const actions = [
        [
          'Seguir por esta rota',
          'navigation',
          () => {
            window.open(
              googleLink(r),
              '_blank',
              'noopener,noreferrer'
            );

            msg(
              'Abrindo Google Maps com pontos de passagem. ' +
              'Confira o percurso antes de iniciar.'
            );
          }
        ],
        [
          'WhatsApp',
          'share-2',
          () => {
            const texto =
              'SECURWAY — ' +
              (i === 0 ? 'Rota principal' : 'Alternativa ' + i) +
              '\nDistância: ' + fmtKm(r.distance) +
              '\nTempo estimado: ' + fmtTime(r.duration) +
              '\nAbrir trajeto no Google Maps:\n' +
              googleLink(r);

            window.open(
              'https://wa.me/?text=' +
              encodeURIComponent(texto),
              '_blank',
              'noopener,noreferrer'
            );
          }
        ]
      ];

      for (const [nome, icone, fn] of actions) {
        const x = document.createElement('button');

        x.type = 'button';
        x.className = 'btn small';

        if (icone === 'navigation') {
          x.classList.add('navigate');
        }

        const iEl = document.createElement('i');
        iEl.setAttribute('data-lucide', icone);

        x.append(
          iEl,
          document.createTextNode(nome)
        );

        x.onclick = fn;
        tools.append(x);
      }

      card.append(tools);
    }

    list.append(card);
  });

  atualizarIcones();
}

// EXPLORAÇÃO DE ROTAS ALTERNATIVAS

function pontoIntermediario(a, b, t, deslocamento) {
  const lat = a.lat + (b.lat - a.lat) * t;
  const lon = a.lon + (b.lon - a.lon) * t;

  const dx =
    (b.lon - a.lon) *
    Math.cos(lat * Math.PI / 180);

  const dy = b.lat - a.lat;
  const tamanho = Math.hypot(dx, dy) || 1;
  const metrosPorGrau = 111320;

  const latOffset =
    (dx / tamanho) *
    deslocamento / metrosPorGrau;

  const lonOffset =
    (-dy / tamanho) *
    deslocamento /
    (
      metrosPorGrau *
      Math.max(.1, Math.cos(lat * Math.PI / 180))
    );

  return {
    lat: lat + latOffset,
    lon: lon + lonOffset
  };
}

function gerarPontosAlternativos(origem, destino) {
  const distancia = distanciaMetros(origem, destino);

  const deslocamento = Math.min(
    15000,
    Math.max(900, distancia * 0.15)
  );

  const pontos = [];

  const posicoes = [0.2, 0.4, 0.6, 0.8];
  const fatores = [1, 2];

  for (const fator of fatores) {
    for (const t of posicoes) {
      for (const lado of [1, -1]) {

        pontos.push(
          pontoIntermediario(
            origem,
            destino,
            t,
            deslocamento * fator * lado
          )
        );

      }
    }
  }

  return pontos.slice(
    0,
    ROUTE_CONFIG.maxConsultasExtras
  );
}
function amostrarTrajeto(rota) {
  const coords = rota.geometry.coordinates;
  const resultado = [];
  const total = 24;

  for (let i = 0; i <= total; i++) {
    const indice = Math.floor(
      (coords.length - 1) * i / total
    );

    resultado.push(coords[indice]);
  }

  return resultado;
}

function diferencaRotas(a, b) {
  const amostraA = amostrarTrajeto(a);
  const amostraB = amostrarTrajeto(b);
  let diferentes = 0;

  for (const ponto of amostraA) {
    let menor = Infinity;

    for (const outro of amostraB) {
      const distancia = distanciaMetros(
        { lat: ponto[1], lon: ponto[0] },
        { lat: outro[1], lon: outro[0] }
      );

      menor = Math.min(menor, distancia);
    }

    if (menor > 350) diferentes++;
  }

  return diferentes / amostraA.length;
}

function rotaTemRetornoOuLaco(rota) {
  for (const leg of rota.legs || []) {
    for (const step of leg.steps || []) {
      const mod = step.maneuver?.modifier || '';
      const tipo = step.maneuver?.type || '';
      if (mod === 'uturn' && tipo !== 'depart' && tipo !== 'arrive') {
        return true;
      }
    }
  }

  const coords = rota.geometry.coordinates;
  const passo = Math.max(1, Math.floor(coords.length / 80));

  for (let i = 0; i < coords.length; i += passo) {
    for (let j = i + passo * 5; j < coords.length; j += passo) {
      const dist = distanciaMetros(
        { lat: coords[i][1], lon: coords[i][0] },
        { lat: coords[j][1], lon: coords[j][0] }
      );
      // Se a rota volta a passar a menos de 400m de um ponto onde já passou antes, é um laço/desvio inútil
      if (dist < 400) return true;
    }
  }

  return false;
}

function adicionarRotaUnica(
  lista,
  candidata,
  distanciaPrincipal
) {
  if (!candidata?.geometry?.coordinates) {
    return false;
  }

  if (rotaTemRetornoOuLaco(candidata)) {
    return false;
  }

  if (
    candidata.distance >
    distanciaPrincipal * ROUTE_CONFIG.desvioMaximo
  ) {
    return false;
  }

  for (const existente of lista) {
    const diferencaAB = diferencaRotas(
      candidata, existente
    );

    const diferencaBA = diferencaRotas(
      existente, candidata
    );

    if (
      diferencaAB < .25 &&
      diferencaBA < .25
    ) {
      return false;
    }
  }

  lista.push(candidata);
  return true;
}

// BUSCA PRINCIPAL

async function route() {
  if (!state.origem || !state.destino) {
    msg('Selecione origem e destino antes de buscar.');
    return;
  }

  const id = ++state.request;
  const botao = $('buscar');

  botao.disabled = true;

  const origem = { ...state.origem };
  const destino = { ...state.destino };

  msg('Buscando a rota principal...');

  try {
    const principais = await consultarOSRM(
      [origem, destino],
      true
    );

    if (id !== state.request) return;

    if (!principais.length) {
      throw new Error('Nenhuma rota encontrada.');
    }

    principais.sort(
      (a, b) => a.duration - b.duration
    );

    const distanciaPrincipal = principais[0].distance;
    const encontradas = [];

    for (const rota of principais) {
      adicionarRotaUnica(
        encontradas,
        rota,
        distanciaPrincipal
      );
    }

    state.rotas = [...encontradas];
    state.selecionada = 0;

    draw();
    render();
    bounds();

    const pontos = gerarPontosAlternativos(
      origem,
      destino
    );

    for (let i = 0; i < pontos.length; i++) {
      if (id !== state.request) return;

      if (
        encontradas.length >= ROUTE_CONFIG.maxRotas
      ) {
        break;
      }

      msg(
        'Explorando alternativas: ' +
        (i + 1) + ' de ' + pontos.length +
        '. Encontradas: ' + encontradas.length
      );

      try {
        const alternativas = await consultarOSRM(
          [origem, pontos[i], destino],
          false
        );

        if (id !== state.request) return;

        for (const alternativa of alternativas) {
          adicionarRotaUnica(
            encontradas,
            alternativa,
            distanciaPrincipal
          );
        }

        encontradas.sort(
          (a, b) => a.duration - b.duration
        );

        state.rotas = encontradas.slice(
          0,
          ROUTE_CONFIG.maxRotas
        );

        state.selecionada = 0;

        draw();
        render();

      } catch (erro) {
        console.warn(
          'Consulta alternativa não concluída:',
          erro
        );
      }
    }

    if (id !== state.request) return;

    state.rotas = encontradas.slice(
      0,
      ROUTE_CONFIG.maxRotas
    );

    state.selecionada = 0;

    draw();
    render();
    bounds();

    msg(
      'Pesquisa concluída: ' +
      state.rotas.length +
      ' rota(s) distinta(s) encontrada(s).'
    );

  } catch (erro) {
    if (id === state.request) {
      console.error(erro);
      msg(
        'Não foi possível calcular as rotas: ' +
        erro.message
      );
    }
  } finally {
    if (id === state.request) {
      botao.disabled = false;
    }
  }
}

$('buscar').onclick = route;

// RECUPERAR PONTOS DE UM LINK ANTIGO

(function restore() {
  const p = new URLSearchParams(location.search);

  const parse = s => {
    if (!s) return null;

    const partes = s.split(',');
    if (partes.length !== 2) return null;

    const lon = Number(partes[0]);
    const lat = Number(partes[1]);

    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return null;
    }

    return {
      lon,
      lat,
      name:
        'Local compartilhado (' +
        lat.toFixed(5) + ', ' +
        lon.toFixed(5) + ')'
    };
  };

  const o = parse(p.get('o'));
  const d = parse(p.get('d'));

  if (o && d) {
    state.origem = o;
    state.destino = d;

    $('origem').value = o.name;
    $('destino').value = d.name;

    markers();

    msg(
      'Pontos compartilhados carregados. ' +
      'Clique em Buscar rotas.'
    );
  }
})();

atualizarIcones();

