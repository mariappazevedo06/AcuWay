'use strict';

// ==================================================
// SECURWAY - SEGURANÇA CORPORATIVA
// ==================================================

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
  '#70e0ae',
  '#73baff',
  '#e8ad62',
  '#d3a0ed',
  '#f28f91',
  '#e2d16d',
  '#65d2d4',
  '#ff9f68',
  '#a5b4fc',
  '#f472b6'
];

const ROUTE_CONFIG = {
  maxRotas: 10,
  maxConsultasExtras: 12,
  desvioMaximo: 1.8,
  timeout: 15000,
  toleranciaDuplicidade: 100,
  diferencaMinima: 0.08
};

const NAV_CONFIG = {
  maxPontos: 3,
  maxTestes: 5,
  raioValidacao: 25,
  toleranciaGeometria: 80,
  diferencaMaxima: 0.03,
  intervaloConsultas: 1100
};

const cacheNavegacao = new WeakMap();

let filaNavegacao = Promise.resolve();
let filaOSRM = Promise.resolve();
let ultimaConsultaOSRM = 0;
let navegacaoEmAndamento = false;

// ==================================================
// INICIALIZAÇÃO DO MAPA
// ==================================================

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

// ==================================================
// FUNÇÕES AUXILIARES
// ==================================================

function msg(texto) {
  status.textContent = texto;
}

function esperar(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
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
    : Math.floor(m / 60) +
      ' h ' + (m % 60) + ' min';
}

function invalidate() {
  state.request++;

  $('buscar').disabled = false;

  state.rotas = [];
  state.selecionada = 0;

  routeLayer.clearLayers();

  drawn = [];

  $('lista').innerHTML =
    '<p class="empty">' +
    'Busque rotas para visualizar alternativas.' +
    '</p>';

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

// ==================================================
// MARCADORES DO MAPA
// ==================================================

function markers() {

  pointLayer.clearLayers();

  for (const type of ['origem', 'destino']) {

    const p = state[type];

    if (!p) continue;

    const marker = L.circleMarker(
      [p.lat, p.lon],
      {
        radius: 9,
        color: '#fff',
        weight: 2,

        fillColor:
          type === 'origem'
            ? '#36c58e'
            : '#e88d67',

        fillOpacity: 1
      }
    ).addTo(pointLayer);

    const popup = document.createElement('div');

    popup.textContent =
      (type === 'origem' ? 'Origem: ' : 'Destino: ') +
      p.name;

    marker.bindPopup(popup);

  }

}

// ==================================================
// PESQUISA DE LUGARES
// ==================================================

function normalizeFeature(f) {

  const p = f.properties || {};
  const c = f.geometry?.coordinates;

  if (!c || c.length < 2) {
    return null;
  }

  const titulo =
    p.name ||
    p.street ||
    p.city ||
    p.locality ||
    'Local encontrado';

  const endereco = [
    p.street,
    p.housenumber,
    p.suburb || p.district,
    p.city || p.locality,
    p.state,
    p.country
  ].filter(Boolean);

  const descricao =
    [...new Set(endereco)].join(', ');

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
    type === 'origem'
      ? 'Origem'
      : 'Destino'
  )).hidden = true;

}

async function photon(q, signal) {

  const url = new URL(
    'https://photon.komoot.io/api/'
  );

  url.searchParams.set('q', q);
  url.searchParams.set('limit', '10');

  const centro = map.getCenter();

  url.searchParams.set('lat', centro.lat);
  url.searchParams.set('lon', centro.lng);

  const resposta = await fetch(url, {
    signal
  });

  if (!resposta.ok) {

    throw new Error(
      'Pesquisa indisponível (HTTP ' +
      resposta.status + ').'
    );

  }

  const dados = await resposta.json();

  return dados.features || [];

}

// ==================================================
// AUTOCOMPLETE DE ORIGEM E DESTINO
// ==================================================

for (const type of ['origem', 'destino']) {

  const el = $(type);

  const box = $('sug' + (
    type === 'origem'
      ? 'Origem'
      : 'Destino'
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

        const features = await photon(
          q,
          ctrl.signal
        );

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

          const b =
            document.createElement('button');

          b.type = 'button';

          b.textContent = p.short;

          const sm =
            document.createElement('small');

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

          const d =
            document.createElement('div');

          d.style.padding = '12px';

          d.textContent =
            'Nenhum local encontrado. ' +
            'Tente incluir cidade e estado.';

          box.append(d);

          msg('Nenhum local encontrado.');

        } else {

          msg(
            box.children.length +
            ' local(is) encontrado(s). ' +
            'Selecione uma sugestão.'
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

    if (e.key === 'Escape') {

      hide(type);

    }

    if (
      e.key === 'Enter' &&
      !box.hidden
    ) {

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

// ==================================================
// CONTROLES DO MAPA
// ==================================================

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

      map.setView(
        [p.lat, p.lon],
        14
      );

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

  map.fitBounds(
    g.getBounds().pad(.15),
    {
      maxZoom: 15
    }
  );

}

$('ajustar').onclick = bounds;

// ==================================================
// DESENHO E SELEÇÃO DAS ROTAS
// ==================================================

function draw() {

  routeLayer.clearLayers();

  drawn = [];

  state.rotas.forEach((r, i) => {

    const coords =
      r.geometry.coordinates.map(
        c => [c[1], c[0]]
      );

    const line = L.polyline(coords, {

      color: colors[i % colors.length],

      weight:
        i === state.selecionada ? 7 : 4,

      opacity:
        i === state.selecionada ? 1 : .65,

      bubblingMouseEvents: false

    }).addTo(routeLayer);

    line.on('click', () => select(i));

    drawn.push(line);

  });

  drawn[state.selecionada]?.bringToFront();

}

function select(i) {

  if (!state.rotas[i] || !drawn[i]) {
    return;
  }

  state.selecionada = i;

  draw();
  render();

  map.fitBounds(
    drawn[i].getBounds().pad(.12),
    {
      maxZoom: 15
    }
  );

  msg(
    i === 0
      ? 'Rota principal selecionada.'
      : 'Alternativa ' + i + ' selecionada.'
  );

}

// ==================================================
// DISTÂNCIA GEOGRÁFICA
// ==================================================

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

  return 2 * R * Math.asin(
    Math.sqrt(
      Math.max(0, Math.min(1, x))
    )
  );

}

// ==================================================
// AMOSTRAGEM DA GEOMETRIA
// ==================================================

function amostrarTrajeto(
  rota,
  intervalo = 150,
  maxAmostras = 300
) {

  const coords =
    rota.geometry?.coordinates || [];

  if (coords.length < 2) return [];

  const acumulado = [0];

  for (let i = 1; i < coords.length; i++) {

    acumulado.push(

      acumulado[i - 1] +

      distanciaMetros(

        {
          lat: coords[i - 1][1],
          lon: coords[i - 1][0]
        },

        {
          lat: coords[i][1],
          lon: coords[i][0]
        }

      )

    );

  }

  const total = acumulado.at(-1);

  if (total <= 0) return [];

  const n = Math.min(
    maxAmostras,
    Math.max(2, Math.ceil(total / intervalo))
  );

  const pontos = [];

  let j = 1;

  for (let i = 0; i <= n; i++) {

    const d = total * i / n;

    while (
      j < coords.length - 1 &&
      acumulado[j] < d
    ) {

      j++;

    }

    const t =
      (d - acumulado[j - 1]) /

      (
        acumulado[j] -
        acumulado[j - 1] || 1
      );

    pontos.push({

      lon:
        coords[j - 1][0] +
        t * (
          coords[j][0] -
          coords[j - 1][0]
        ),

      lat:
        coords[j - 1][1] +
        t * (
          coords[j][1] -
          coords[j - 1][1]
        ),

      d

    });

  }

  return pontos;

}

// ==================================================
// DISTÂNCIA ENTRE PONTO E ROTA
// ==================================================

function distanciaAteRota(p, rota) {

  const c =
    rota.geometry?.coordinates || [];

  const k =
    111320 *
    Math.cos(p.lat * Math.PI / 180);

  let menor = Infinity;

  for (let i = 1; i < c.length; i++) {

    const ax =
      (c[i - 1][0] - p.lon) * k;

    const ay =
      (c[i - 1][1] - p.lat) * 111320;

    const bx =
      (c[i][0] - p.lon) * k;

    const by =
      (c[i][1] - p.lat) * 111320;

    const dx = bx - ax;
    const dy = by - ay;

    const t = Math.max(

      0,

      Math.min(

        1,

        -(ax * dx + ay * dy) /

        (dx * dx + dy * dy || 1)

      )

    );

    menor = Math.min(

      menor,

      Math.hypot(
        ax + t * dx,
        ay + t * dy
      )

    );

  }

  return menor;

}

function diferencaRotas(a, b) {

  const pontos = amostrarTrajeto(a);

  if (!pontos.length) return 1;

  return pontos.filter(

    p =>
      distanciaAteRota(p, b) >
      ROUTE_CONFIG.toleranciaDuplicidade

  ).length / pontos.length;

}

// ==================================================
// DETECÇÃO DE RETORNOS E LAÇOS
// ==================================================

function rotaTemRetornoOuLaco(rota) {

  const coords = rota.geometry?.coordinates || [];

  if (coords.length < 2) return false;

  const segmentos = new Set();

  let distanciaRepetida = 0;

  // Identifica retornos explícitos.
  for (const leg of rota.legs || []) {

    for (const step of leg.steps || []) {

      const tipo = step.maneuver?.type || '';
      const modificador = step.maneuver?.modifier || '';

      if (
        modificador === 'uturn' &&
        tipo !== 'depart' &&
        tipo !== 'arrive' &&
        step.distance > 300
      ) {

        console.log(
          'Retorno explícito identificado:',
          step.name,
          step.distance
        );

        return true;

      }

    }

  }

  // Identifica segmentos percorridos
  // novamente no sentido contrário.

  function chave(p) {

    return p[0].toFixed(5) + ',' +
           p[1].toFixed(5);

  }

  for (let i = 1; i < coords.length; i++) {

    const a = coords[i - 1];
    const b = coords[i];

    const ida = chave(a) + '|' + chave(b);
    const volta = chave(b) + '|' + chave(a);

    if (ida === volta) continue;

    if (segmentos.has(volta)) {

      distanciaRepetida += distanciaMetros(
        {
          lat: a[1],
          lon: a[0]
        },
        {
          lat: b[1],
          lon: b[0]
        }
      );

    }

    segmentos.add(ida);

  }

  // Tolera pequenas repetições, mas rejeita
  // retornos significativos no percurso.

  const limite = Math.min(
    300,
    Math.max(100, rota.distance * 0.005)
  );

  if (distanciaRepetida > limite) {

    console.log(
      'Retorno real identificado:',
      distanciaRepetida.toFixed(2) + ' metros'
    );

    return true;

  }

  return false;

}
// ==================================================
// COMUNICAÇÃO COM OSRM
// ==================================================

function consultarOSRM(
  pontos,
  alternativas = false,
  raioIntermediario = 800,
  request = state.request
) {

  // Centraliza as consultas para evitar
  // solicitações simultâneas ao servidor.

  async function executar() {

    if (request !== state.request) {

      throw new Error('Pesquisa alterada.');

    }

    const intervalo =
      NAV_CONFIG.intervaloConsultas -
      (Date.now() - ultimaConsultaOSRM);

    if (intervalo > 0) {

      await esperar(intervalo);

    }

    if (request !== state.request) {

      throw new Error('Pesquisa alterada.');

    }

    const coordenadas = pontos
      .map(p => `${p.lon},${p.lat}`)
      .join(';');

    const url = new URL(

      'https://router.project-osrm.org/' +

      'route/v1/driving/' +

      coordenadas

    );

    url.searchParams.set(
      'overview',
      'full'
    );

    url.searchParams.set(
      'geometries',
      'geojson'
    );

    url.searchParams.set(
      'alternatives',
      String(alternativas)
    );

    url.searchParams.set(
      'steps',
      'true'
    );

    url.searchParams.set(
      'continue_straight',
      'true'
    );

    if (pontos.length > 2) {

      url.searchParams.set(

        'radiuses',

        pontos.map((_, idx) =>

          (
            idx === 0 ||
            idx === pontos.length - 1
          )

            ? 'unlimited'

            : String(raioIntermediario)

        ).join(';')

      );

    }

    const controller =
      new AbortController();

    const timer = setTimeout(

      () => controller.abort(),

      ROUTE_CONFIG.timeout

    );

    try {

      ultimaConsultaOSRM = Date.now();

      const resposta = await fetch(url, {

        signal: controller.signal

      });

      if (!resposta.ok) {

        throw new Error(

          'OSRM retornou HTTP ' +

          resposta.status

        );

      }

      const dados = await resposta.json();

      if (request !== state.request) {

        throw new Error('Pesquisa alterada.');

      }

      if (dados.code !== 'Ok') {

        return [];

      }

      return (dados.routes || []).filter(

        rota =>

          rota.geometry?.coordinates?.length > 1

      );

    } finally {

      clearTimeout(timer);

    }

  }

  const tarefa =
    filaOSRM.then(executar);

  filaOSRM = tarefa.catch(() => {});

  return tarefa;

}

// ==================================================
// EXPLORAÇÃO DE ROTAS ALTERNATIVAS
// ==================================================

function pontoIntermediario(
  a,
  b,
  t,
  deslocamento
) {

  const lat =
    a.lat + (b.lat - a.lat) * t;

  const lon =
    a.lon + (b.lon - a.lon) * t;

  const dx =
    (b.lon - a.lon) *
    Math.cos(lat * Math.PI / 180);

  const dy = b.lat - a.lat;

  const tamanho =
    Math.hypot(dx, dy) || 1;

  const metrosPorGrau = 111320;

  const latOffset =

    (dx / tamanho) *

    deslocamento / metrosPorGrau;

  const lonOffset =

    (-dy / tamanho) *

    deslocamento /

    (

      metrosPorGrau *

      Math.max(
        .1,
        Math.cos(lat * Math.PI / 180)
      )

    );

  return {

    lat: lat + latOffset,

    lon: lon + lonOffset

  };

}

function gerarPontosAlternativos(
  origem,
  destino
) {

  const distancia = distanciaMetros(
    origem,
    destino
  );

  const deslocamento = Math.min(

    5000,

    Math.max(
      400,
      distancia * 0.08
    )

  );

  const pontos = [];

  const posicoes = [
    0.25,
    0.50,
    0.75
  ];

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

// ==================================================
// FILTRO DE ROTAS
// ==================================================

function adicionarRotaUnica(
  lista,
  candidata,
  distanciaPrincipal
) {

  if (

    !candidata?.geometry?.coordinates ||

    candidata.geometry.coordinates.length < 2

  ) {

    return false;

  }

  if (

    !Number.isFinite(candidata.distance) ||

    candidata.distance <= 0

  ) {

    return false;

  }

  if (

    lista.length >= ROUTE_CONFIG.maxRotas

  ) {

    return false;

  }

  // Preserva a primeira rota nativa do OSRM.

  if (!lista.length) {

    lista.push(candidata);

    return true;

  }

  if (rotaTemRetornoOuLaco(candidata)) {

    console.log(
      'Rota descartada: retorno ou laço.'
    );

    return false;

  }

  if (

    candidata.distance >

    distanciaPrincipal *
    ROUTE_CONFIG.desvioMaximo

  ) {

    console.log(
      'Rota descartada: distância excessiva.'
    );

    return false;

  }

  for (const existente of lista) {

    const diferencaAB =
      diferencaRotas(candidata, existente);

    const diferencaBA =
      diferencaRotas(existente, candidata);

    if (

      diferencaAB <
        ROUTE_CONFIG.diferencaMinima &&

      diferencaBA <
        ROUTE_CONFIG.diferencaMinima

    ) {

      console.log(
        'Rota descartada: trajeto semelhante.'
      );

      return false;

    }

  }

  lista.push(candidata);

  return true;

}

// ==================================================
// IDENTIFICAÇÃO DAS PRINCIPAIS VIAS
// ==================================================

function identificarVias(rota) {

  const vias = [];
  const nomes = new Set();

  for (const trecho of rota.legs || []) {

    for (const etapa of trecho.steps || []) {

      const nome =
        etapa.name?.trim() ||
        etapa.ref?.trim();

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

// ==================================================
// NOVO SISTEMA DE PONTOS DE PASSAGEM
// ==================================================

function obterCandidatosPassagem(rota) {

  const candidatos = [];

  let acumulado = 0;

  const margem = Math.min(

    1000,

    rota.distance * 0.10

  );

  for (const leg of rota.legs || []) {

    for (const step of leg.steps || []) {

      const distancia =
        step.distance || 0;

      const inicio = acumulado;

      acumulado += distancia;

      const coords =
        step.geometry?.coordinates || [];

      const nome =
        (step.name || '').trim();

      const ref =
        (step.ref || '').trim();

      const tipo =
        step.maneuver?.type || '';

      const modificador =
        step.maneuver?.modifier || '';

      // Evita trechos muito curtos.

      if (

        distancia < 500 ||

        coords.length < 2 ||

        (!nome && !ref)

      ) {

        continue;

      }

      // Evita pontos em retornos,
      // rotatórias e acessos.

      if (

        modificador === 'uturn' ||

        /roundabout|rotary|ramp|fork|merge/i
          .test(tipo)

      ) {

        continue;

      }

      if (

        /acesso|alça|retorno|rampa|serviço/i
          .test(nome)

      ) {

        continue;

      }

      const amostra = amostrarTrajeto(

        {
          geometry: step.geometry
        },

        75,

        400

      );

      const total =
        amostra.at(-1)?.d || 0;

      if (total < 500) continue;

      const rodovia =

        /\b(BR|RJ)[\s-]*\d+/i.test(
          ref + ' ' + nome
        ) ||

        /rodovia/i.test(nome);

      for (
        let i = 1;
        i < amostra.length - 1;
        i++
      ) {

        const p = amostra[i];

        const proporcao = p.d / total;

        // Prioriza o interior do trecho.

        if (

          proporcao < 0.20 ||

          proporcao > 0.80

        ) {

          continue;

        }

        if (

          p.d < 180 ||

          total - p.d < 180

        ) {

          continue;

        }

        // Evita pontos próximos a interseções
        // registradas pelo OSRM.

        const pertoIntersecao =

          (step.intersections || []).some(

            intersecao => {

              const c =
                intersecao.location;

              if (!c) return false;

              return distanciaMetros(

                p,

                {
                  lat: c[1],
                  lon: c[0]
                }

              ) < 60;

            }

          );

        if (pertoIntersecao) {

          continue;

        }

        const anterior = amostra[i - 1];

        const posterior = amostra[i + 1];

        const percorrido =
          posterior.d - anterior.d;

        if (percorrido <= 0) continue;

        const continuidade =

          distanciaMetros(
            anterior,
            posterior
          ) / percorrido;

        if (continuidade < 0.975) {

          continue;

        }

        const posicao =

          inicio +

          proporcao * distancia;

        if (

          posicao < margem ||

          posicao > rota.distance - margem

        ) {

          continue;

        }

        const centralidade =

          1 -

          Math.abs(proporcao - 0.5) * 2;

        candidatos.push({

          lat: Number(p.lat.toFixed(6)),

          lon: Number(p.lon.toFixed(6)),

          d: posicao,

          nome: ref || nome,

          rodovia,

          continuidade,

          qualidade:

            continuidade * 4000 +

            centralidade * 2000 +

            (rodovia ? 1500 : 0) +

            Math.min(distancia, 5000) / 5

        });

      }

    }

  }

  return candidatos;

}

// ==================================================
// SELEÇÃO INTELIGENTE DOS PONTOS
// ==================================================

function selecionarPontosPassagem(
  rota,
  limite = 3,
  candidatos = obterCandidatosPassagem(rota),
  posicoes = null
) {

  limite = Math.max(

    0,

    Math.min(
      NAV_CONFIG.maxPontos,
      limite
    )

  );

  if (!limite) return [];

  const escolhidos = [];

  const alvos = posicoes ||

    Array.from(

      { length: limite },

      (_, i) =>
        (i + 1) / (limite + 1)

    );

  for (const proporcao of alvos) {

    if (escolhidos.length >= limite) {

      break;

    }

    const alvo =
      rota.distance * proporcao;

    let melhor = null;

    let melhorNota = -Infinity;

    for (const p of candidatos) {

      const separacao = Math.min(

        1000,

        rota.distance / (limite + 2)

      );

      if (

        escolhidos.some(

          q =>

            Math.abs(q.d - p.d) <
            separacao

        )

      ) {

        continue;

      }

      const distanciaAlvo =

        Math.abs(p.d - alvo);

      const nota =

        p.qualidade -

        distanciaAlvo /

        Math.max(1, rota.distance) *

        20000;

      if (nota > melhorNota) {

        melhorNota = nota;

        melhor = p;

      }

    }

    if (melhor) {

      escolhidos.push(melhor);

    }

  }

  return escolhidos.sort(

    (a, b) => a.d - b.d

  );

}

// ==================================================
// COMPARAÇÃO DE PERCURSOS
// ==================================================

function compararPercursos(
  original,
  recalculada
) {

  const pontosA = amostrarTrajeto(
    original,
    50,
    1200
  );

  const pontosB = amostrarTrajeto(
    recalculada,
    50,
    1200
  );

  if (

    !pontosA.length ||

    !pontosB.length ||

    original.distance <= 0

  ) {

    return {

      aprovada: false,

      retorno: false,

      divergenciaA: 1,

      divergenciaB: 1,

      divergenciaOrdem: 1,

      diferencaDistancia: 1,

      nota: Infinity

    };

  }

  const tolerancia =
    NAV_CONFIG.toleranciaGeometria;

  const divergenciaA = pontosA.filter(

    p =>

      distanciaAteRota(p, recalculada) >
      tolerancia

  ).length / pontosA.length;

  const divergenciaB = pontosB.filter(

    p =>

      distanciaAteRota(p, original) >
      tolerancia

  ).length / pontosB.length;

  const diferencaDistancia =

    Math.abs(

      recalculada.distance -
      original.distance

    ) / original.distance;

  const maiorDivergencia = Math.max(

    divergenciaA,

    divergenciaB

  );

  const retorno =
    rotaTemRetornoOuLaco(recalculada);

  // Compara a sequência do percurso.

  let divergenciaOrdem = 0;

  for (let i = 0; i <= 20; i++) {

    const a = pontosA[

      Math.round(

        i / 20 *

        (pontosA.length - 1)

      )

    ];

    const b = pontosB[

      Math.round(

        i / 20 *

        (pontosB.length - 1)

      )

    ];

    if (

      distanciaMetros(a, b) > 500

    ) {

      divergenciaOrdem++;

    }

  }

  divergenciaOrdem /= 21;

  const aprovada =

    !retorno &&

    maiorDivergencia <=
      NAV_CONFIG.diferencaMaxima &&

    diferencaDistancia <=
      NAV_CONFIG.diferencaMaxima &&

    divergenciaOrdem <= 0.10;

  return {

    aprovada,

    retorno,

    divergenciaA,

    divergenciaB,

    divergenciaOrdem,

    diferencaDistancia,

    nota:

      maiorDivergencia * 100 +

      diferencaDistancia * 100 +

      divergenciaOrdem * 50 +

      (retorno ? 1000 : 0)

  };

}

// ==================================================
// COMBINAÇÕES DE PONTOS INTERMEDIÁRIOS
// ==================================================

function gerarCombinacoesPassagem(rota) {

  const combinacoes = [];

  const existentes = new Set();

  const candidatos =
    obterCandidatosPassagem(rota);

  function adicionar(pontos) {

    const ordenados = [...pontos].sort(

      (a, b) => a.d - b.d

    );

    const chave = ordenados.map(

      p => `${p.lat},${p.lon}`

    ).join('|');

    if (existentes.has(chave)) {

      return;

    }

    existentes.add(chave);

    combinacoes.push(ordenados);

  }

  const um = selecionarPontosPassagem(

    rota,

    1,

    candidatos

  );

  const dois = selecionarPontosPassagem(

    rota,

    2,

    candidatos

  );

  const tres = selecionarPontosPassagem(

    rota,

    3,

    candidatos

  );

  // Testa inicialmente se nenhum ponto
  // intermediário é necessário.

  adicionar([]);

  adicionar(um);

  adicionar(dois);

  adicionar(tres);

  // Testa uma distribuição alternativa.

  adicionar(

    selecionarPontosPassagem(

      rota,

      3,

      candidatos,

      [0.15, 0.50, 0.85]

    )

  );

  if (tres.length === 3) {

    adicionar([tres[0], tres[2]]);

  }

  return combinacoes.slice(

    0,

    NAV_CONFIG.maxTestes

  );

}

// ==================================================
// VALIDAÇÃO AUTOMÁTICA DOS PONTOS
// ==================================================

async function validarPontosPassagem(
  rota,
  origem,
  destino,
  pontos,
  request
) {

  const coordenadas = [

    origem,

    ...pontos,

    destino

  ];

  const resultado = await consultarOSRM(

    coordenadas,

    false,

    NAV_CONFIG.raioValidacao,

    request

  );

  if (!resultado.length) {

    return null;

  }

  const recalculada = resultado[0];

  const comparacao = compararPercursos(

    rota,

    recalculada

  );

  return {

    pontos,

    recalculada,

    ...comparacao

  };

}

// ==================================================
// PREPARAÇÃO DA NAVEGAÇÃO E CACHE
// ==================================================

function prepararNavegacao(rota) {

  const request = state.request;

  const cache =
    cacheNavegacao.get(rota);

  if (cache?.request === request) {

    return cache.tarefa;

  }

  const origem = { ...state.origem };

  const destino = { ...state.destino };

  async function executar() {

    // Aguarda a conclusão da busca de rotas.

    while ($('buscar').disabled) {

      if (request !== state.request) {

        throw new Error('Pesquisa alterada.');

      }

      await esperar(300);

    }

    if (request !== state.request) {

      throw new Error('Pesquisa alterada.');

    }

    const combinacoes =
      gerarCombinacoesPassagem(rota);

    let melhor = null;

    let falhas = 0;

    for (
      let i = 0;
      i < combinacoes.length;
      i++
    ) {

      if (request !== state.request) {

        throw new Error('Pesquisa alterada.');

      }

      msg(

        'Validando percurso: ' +

        (i + 1) +

        ' de ' +

        combinacoes.length

      );

      try {

        const teste =

          await validarPontosPassagem(

            rota,

            origem,

            destino,

            combinacoes[i],

            request

          );

        if (request !== state.request) {

          throw new Error('Pesquisa alterada.');

        }

        if (!teste) continue;

        console.log(

          'SECURWAY | Validação:',

          {

            pontos: teste.pontos,

            aprovada: teste.aprovada,

            distanciaOriginal:
              fmtKm(rota.distance),

            distanciaRecalculada:
              fmtKm(teste.recalculada.distance),

            divergenciaOriginal:

              (
                teste.divergenciaA * 100
              ).toFixed(2) + '%',

            divergenciaRecalculada:

              (
                teste.divergenciaB * 100
              ).toFixed(2) + '%',

            diferencaDistancia:

              (
                teste.diferencaDistancia * 100
              ).toFixed(2) + '%',

            retorno: teste.retorno,

            nota: teste.nota

          }

        );

        if (

          !melhor ||

          teste.nota < melhor.nota

        ) {

          melhor = teste;

        }

        // Aprova a primeira combinação
        // que atende aos critérios.

        if (teste.aprovada) {

          console.table(

            teste.pontos.map(p => ({

              Via: p.nome,

              Rodovia: p.rodovia,

              KM: (p.d / 1000).toFixed(2),

              Latitude: p.lat,

              Longitude: p.lon

            }))

          );

          return {

            validada: true,

            pontos: teste.pontos,

            comparacao: teste,

            origem,

            destino

          };

        }

      } catch (erro) {

        if (request !== state.request) {

          throw erro;

        }

        falhas++;

        console.warn(

          'SECURWAY | Falha na validação:',

          erro

        );

        if (

          /HTTP (429|503)/.test(erro.message)

        ) {

          break;

        }

      }

    }

    // Não aprova pontos que não passaram
    // pelos critérios de validação.

    return {

      validada: false,

      pontos: [],

      comparacao: melhor,

      origem,

      destino,

      falhas

    };

  }

  const tarefa =
    filaNavegacao.then(executar);

  filaNavegacao =
    tarefa.catch(() => {});

  const entrada = {
    request,
    tarefa
  };

  cacheNavegacao.set(rota, entrada);

  function limparCache() {

    if (

      cacheNavegacao.get(rota) === entrada

    ) {

      cacheNavegacao.delete(rota);

    }

  }

  tarefa.then(

    resultado => {

      if (!resultado.validada) {

        limparCache();

      }

    },

    limparCache

  );

  return tarefa;

}

// ==================================================
// GERAÇÃO DO LINK DO GOOGLE MAPS
// ==================================================

function googleLink(
  rota,
  pontos = [],
  origem = state.origem,
  destino = state.destino
) {

  const url = new URL(

    'https://www.google.com/maps/dir/'

  );

  url.searchParams.set(

    'api',

    '1'

  );

  url.searchParams.set(

    'origin',

    origem.lat.toFixed(6) + ',' +

    origem.lon.toFixed(6)

  );

  url.searchParams.set(

    'destination',

    destino.lat.toFixed(6) + ',' +

    destino.lon.toFixed(6)

  );

  url.searchParams.set(

    'travelmode',

    'driving'

  );

  const ordenados = [...pontos].sort(

    (a, b) => a.d - b.d

  ).slice(0, NAV_CONFIG.maxPontos);

  if (ordenados.length) {

    url.searchParams.set(

      'waypoints',

      ordenados.map(p =>

        p.lat.toFixed(6) + ',' +

        p.lon.toFixed(6)

      ).join('|')

    );

  }

  console.log(

    'SECURWAY | Google Maps',

    {

      distanciaOriginal:
        fmtKm(rota.distance),

      quantidadePontos:
        ordenados.length,

      pontos: ordenados,

      url: url.toString()

    }

  );

  return url.toString();

}

// ==================================================
// NAVEGAÇÃO E COMPARTILHAMENTO
// ==================================================

async function abrirNavegacao(
  rota,
  indice,
  compartilhar = false
) {

  if (navegacaoEmAndamento) {

    msg('Aguarde a validação em andamento.');

    return;

  }

  if (!state.rotas.includes(rota)) {

    msg('Selecione uma rota válida.');

    return;

  }

  // Abre a aba antes das consultas
  // para reduzir bloqueios de pop-up.

  const aba = window.open(

    'about:blank',

    '_blank'

  );

  if (!aba) {

    msg(

      'Permita pop-ups para abrir a navegação.'

    );

    return;

  }

  navegacaoEmAndamento = true;

  const request = state.request;

  try {

    aba.opener = null;

    aba.document.title = 'SECURWAY';

    aba.document.body.style.cssText =

      'background:#101010;' +

      'color:#ffffff;' +

      'font-family:Arial,sans-serif;' +

      'padding:40px;';

    aba.document.body.textContent =

      'SECURWAY — Validando o percurso. ' +

      'Aguarde...';

    msg('Preparando pontos de navegação...');

    const resultado =

      await prepararNavegacao(rota);

    if (request !== state.request) {

      throw new Error('Pesquisa alterada.');

    }

    if (aba.closed) return;

    if (!resultado.validada) {

      const continuar = window.confirm(

        'Não foi possível validar a reprodução ' +

        'desta rota pelo OSRM.\n\n' +

        'Deseja continuar somente com origem ' +

        'e destino?\n\n' +

        'O percurso poderá ser diferente ' +

        'da alternativa selecionada.'

      );

      if (!continuar) {

        aba.close();

        msg(

          'Navegação cancelada: ' +

          'percurso não validado.'

        );

        return;

      }

    }

    const link = googleLink(

      rota,

      resultado.pontos,

      resultado.origem,

      resultado.destino

    );

    if (compartilhar) {

      const texto =

        'SECURWAY — ' +

        (

          indice === 0

            ? 'Rota principal'

            : 'Alternativa ' + indice

        ) +

        '\n\nOrigem: ' +

        resultado.origem.name +

        '\nDestino: ' +

        resultado.destino.name +

        '\nDistância no SECURWAY: ' +

        fmtKm(rota.distance) +

        '\nTempo estimado: ' +

        fmtTime(rota.duration) +

        '\n\nPrincipais vias: ' +

        identificarVias(rota)
          .slice(0, 5)
          .join(' • ') +

        '\n\n' +

        (

          resultado.validada

            ? 'Percurso validado pelo OSRM.'

            : 'Atenção: alternativa não validada. ' +

              'Link contém somente origem e destino.'

        ) +

        '\nConfira o percurso no Google Maps.' +

        '\n\nAbrir navegação:\n' +

        link;

      aba.location.replace(

        'https://wa.me/?text=' +

        encodeURIComponent(texto)

      );

    } else {

      aba.location.replace(link);

    }

    msg(

      resultado.validada

        ? 'Pontos validados pelo OSRM. ' +

          'Confira o percurso no Google Maps.'

        : 'Link gerado somente com origem e destino.'

    );

  } catch (erro) {

    if (!aba.closed) {

      aba.close();

    }

    console.error(

      'SECURWAY | Erro de navegação:',

      erro

    );

    if (request === state.request) {

      msg(

        'Não foi possível preparar a navegação: ' +

        erro.message

      );

    }

  } finally {

    navegacaoEmAndamento = false;

  }

}

// ==================================================
// RESULTADOS E BOTÕES
// ==================================================

function render() {

  const list = $('lista');

  list.replaceChildren();

  $('contagem').textContent =

    state.rotas.length +

    ' rota' +

    (state.rotas.length === 1 ? '' : 's');

  state.rotas.forEach((r, i) => {

    const card =
      document.createElement('div');

    const b =
      document.createElement('button');

    b.className =

      'route' +

      (

        i === state.selecionada

          ? ' active'

          : ''

      );

    b.type = 'button';

    const dot =
      document.createElement('span');

    dot.className = 'dot';

    dot.style.background =

      colors[i % colors.length];

    b.append(

      dot,

      document.createTextNode(

        i === 0

          ? 'Rota principal'

          : 'Alternativa ' + i

      )

    );

    const sm =
      document.createElement('small');

    sm.textContent =

      fmtKm(r.distance) +

      ' • ' +

      fmtTime(r.duration);

    b.append(sm);

    const vias = identificarVias(r);

    if (vias.length) {

      const detalhes =

        document.createElement('small');

      detalhes.textContent =

        'Principais vias: ' +

        vias.slice(0, 5).join(' • ');

      detalhes.style.marginTop = '8px';

      b.append(detalhes);

    }

    b.onclick = () => select(i);

    card.append(b);

    if (i === state.selecionada) {

      const tools =

        document.createElement('div');

      tools.className = 'route-tools';

      const actions = [

        [

          'Seguir por esta rota',

          'navigation',

          () => abrirNavegacao(r, i, false)

        ],

        [

          'WhatsApp',

          'share-2',

          () => abrirNavegacao(r, i, true)

        ]

      ];

      for (const [nome, icone, fn] of actions) {

        const x =

          document.createElement('button');

        x.type = 'button';

        x.className = 'btn small';

        if (icone === 'navigation') {

          x.classList.add('navigate');

        }

        const iEl =

          document.createElement('i');

        iEl.setAttribute(

          'data-lucide',

          icone

        );

        x.append(

          iEl,

          document.createTextNode(nome)

        );

        x.onclick = async () => {

          if (x.disabled) return;

          const botoes =

            tools.querySelectorAll('button');

          botoes.forEach(

            botao => botao.disabled = true

          );

          try {

            await fn();

          } finally {

            botoes.forEach(

              botao => botao.disabled = false

            );

          }

        };

        tools.append(x);

      }

      card.append(tools);

    }

    list.append(card);

  });

  atualizarIcones();

}

// ==================================================
// BUSCA PRINCIPAL DE ROTAS
// ==================================================

async function route() {

  if (!state.origem || !state.destino) {

    msg(

      'Selecione origem e destino antes de buscar.'

    );

    return;

  }

  const id = ++state.request;

  const botao = $('buscar');

  botao.disabled = true;

  const origem = { ...state.origem };

  const destino = { ...state.destino };

  let falhas = 0;

  state.rotas = [];

  state.selecionada = 0;

  draw();
  render();

  msg('Buscando a rota principal...');

  try {

    const principais = await consultarOSRM(

      [origem, destino],

      true,

      800,

      id

    );

    if (id !== state.request) return;

    if (!principais.length) {

      throw new Error(

        'Nenhuma rota encontrada.'

      );

    }

    principais.sort(

      (a, b) => a.duration - b.duration

    );

    const distanciaPrincipal =

      principais[0].distance;

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

    for (
      let i = 0;
      i < pontos.length;
      i++
    ) {

      if (id !== state.request) return;

      if (

        encontradas.length >=
        ROUTE_CONFIG.maxRotas

      ) {

        break;

      }

      msg(

        'Explorando alternativas: ' +

        (i + 1) +

        ' de ' +

        pontos.length +

        '. Encontradas: ' +

        encontradas.length

      );

      try {

        const alternativas =

          await consultarOSRM(

            [origem, pontos[i], destino],

            false,

            800,

            id

          );

        if (id !== state.request) return;

        for (const alternativa of alternativas) {

          adicionarRotaUnica(

            encontradas,

            alternativa,

            distanciaPrincipal

          );

        }

        const selecionada =

          state.rotas[state.selecionada];

        encontradas.sort(

          (a, b) => a.duration - b.duration

        );

        state.rotas = encontradas.slice(

          0,

          ROUTE_CONFIG.maxRotas

        );

        state.selecionada = Math.max(

          0,

          state.rotas.indexOf(selecionada)

        );

        draw();
        render();

      } catch (erro) {

        if (id !== state.request) return;

        falhas++;

        console.warn(

          'Consulta alternativa não concluída:',

          erro

        );

        if (

          /HTTP (429|503)/.test(erro.message)

        ) {

          break;

        }

      }

    }

    if (id !== state.request) return;

    const selecionadaFinal =

      state.rotas[state.selecionada];

    state.rotas = encontradas.slice(

      0,

      ROUTE_CONFIG.maxRotas

    );

    state.selecionada = Math.max(

      0,

      state.rotas.indexOf(selecionadaFinal)

    );

    draw();
    render();
    bounds();

    msg(

      'Pesquisa concluída: ' +

      state.rotas.length +

      ' rota(s) distinta(s) encontrada(s).' +

      (

        falhas

          ? ' Algumas consultas não foram concluídas.'

          : ''

      )

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

// ==================================================
// RECUPERAR PONTOS DE LINKS ANTIGOS
// ==================================================

(function restore() {

  const p =

    new URLSearchParams(location.search);

  const parse = s => {

    if (!s) return null;

    const partes = s.split(',');

    if (partes.length !== 2) {

      return null;

    }

    if (

      partes.some(
        parte => !parte.trim()
      )

    ) {

      return null;

    }

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

        lat.toFixed(5) +

        ', ' +

        lon.toFixed(5) +

        ')'

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

// ==================================================
// FINALIZAÇÃO
// ==================================================

atualizarIcones();

console.log(
  'SECURWAY | Sistema inicializado.'
);

console.log(
  'SECURWAY | Validação de navegação ativa.'
);
