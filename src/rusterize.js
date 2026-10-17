/** Real Rust/Rusterize dream atlas, embedded in the accessible MOB document. */
const CHARACTER_OFFSET = 10000;
const encoder = new TextEncoder();
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const count = value => Math.max(0, Math.min(1_000_000_000, Math.floor(number(value))));

async function imagePixels(source) {
  if (!source) return null;
  source = source.dataUrl || source.src || source.url || source;
  let temporary;
  if (source instanceof Blob) source = temporary = URL.createObjectURL(source);
  if (typeof source !== 'string') return null;
  // Diary illustrations are local. Never send an image request to a third party.
  const url = new URL(source, document.baseURI);
  if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin) return null;
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url.href;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    ctx.drawImage(image, (image.naturalWidth-size)/2, (image.naturalHeight-size)/2, size, size, 0, 0, 128, 128);
    return new Uint8Array(ctx.getImageData(0, 0, 128, 128).data.buffer);
  } finally {
    if (temporary) URL.revokeObjectURL(temporary);
  }
}

/**
 * @param {HTMLCanvasElement} canvas A canvas with its CSS width and height set.
 * @param {object} options {nodes, edges, characters, onOpen, onMove, onError, reducedMotion}
 * Nodes: {id, name, x?, y?, count, lucidCount, image?: Blob | data URL}.
 * Edges: {source: node id, target: node id, count}.
 * Characters: {id, name, locations: node ids[], image?}.
 * Coordinates are stable world units, not screen pixels. The initial world is 1000×700.
 */
export async function createDreamMap(canvas, options = {}) {
  const { start } = await import(new URL('../rusterize/rusterize.js', import.meta.url).href);
  let destroyed = false, generation = 0, nodeIds = [], characterIds = [], indices = new Map();
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const imageCache = new Map();
  const originalTitle = document.title;
  const runtime = await start(canvas, new URL('../rusterize/app.wasm', import.meta.url), {
    onError(error) { options.onError?.(error); },
  });
  // The embedded canvas does not own the outer application's document title.
  document.title = originalTitle;
  canvas.dataset.engine = 'rusterize-wasm';
  canvas.setAttribute('aria-label', 'Карта сновидений. Перетаскивайте локации, масштабируйте колесом. Tab — выйти к списку локаций.');
  const call = (name, ...args) => runtime.callExport(name, ...args);
  const write = bytes => {
    if (bytes.byteLength > 256 * 256 * 4) throw new RangeError('Atlas transfer exceeds its bounded buffer');
    const pointer = call('app_buffer', bytes.byteLength);
    runtime.writeBytes(pointer, bytes);
  };
  const setName = (index, name) => { write(encoder.encode(String(name || '').slice(0, 400))); call('app_name', index); };
  const setMotion = () => {
    if (destroyed || runtime.stopped) return;
    call('app_config', Number(options.reducedMotion ?? media.matches));
    runtime.refresh();
  };
  const drain = () => {
    if (destroyed || runtime.stopped) return;
    const events = [];
    for (let i = 0; i < 64; i++) {
      const kind = call('app_event_next');
      if (!kind) break;
      const index = call('app_event_value', 0);
      const id = index >= CHARACTER_OFFSET ? characterIds[index-CHARACTER_OFFSET] : nodeIds[index];
      if (id == null) continue;
      events.push({kind, id, x:call('app_event_value', 1), y:call('app_event_value', 2)});
    }
    // Collect first: a callback may replace this route and destroy the instance.
    for (const event of events) {
      if (event.kind === 1) options.onOpen?.(event.id);
      if (event.kind === 2) options.onMove?.(event.id, {x:event.x, y:event.y});
    }
  };
  // Upstream Canvas consumes Tab. The accessible web shell retains normal focus
  // navigation; DOM location buttons provide screen-reader access to every node.
  const keyboard = event => { if (event.key === 'Tab') event.stopImmediatePropagation(); };
  canvas.addEventListener('keydown', keyboard, true);
  canvas.addEventListener('keyup', keyboard, true);
  canvas.addEventListener('pointerup', drain);
  canvas.addEventListener('keydown', drain);
  media.addEventListener('change', setMotion);

  async function update(graph = {}) {
    if (destroyed || runtime.stopped) return;
    const epoch = ++generation;
    const nodes = (graph.nodes || []).slice(0, 500);
    const characters = (graph.characters || []).slice(0, 200);
    nodeIds = nodes.map(node => node.id);
    characterIds = characters.map(character => character.id);
    indices = new Map(nodeIds.map((id, index) => [id, index]));
    call('app_begin');
    nodes.forEach((node, index) => {
      const positioned = Number.isFinite(node.x) && Number.isFinite(node.y);
      call('app_node', number(node.x), number(node.y), count(node.count), count(node.lucidCount), index, nodes.length, Number(positioned));
      setName(index, node.name);
    });
    for (const edge of (graph.edges || []).slice(0, 2500)) {
      const source = indices.get(edge.source), target = indices.get(edge.target);
      if (source !== undefined && target !== undefined) call('app_edge', source, target, count(edge.count));
    }
    characters.forEach((character, index) => {
      call('app_character');
      setName(CHARACTER_OFFSET + index, character.name);
      for (const id of character.locations || []) {
        const node = indices.get(id);
        if (node !== undefined) call('app_character_home', index, node);
      }
    });
    setMotion();
    const pictures = [...nodes.map((node, index) => [index, node.image]), ...characters.map((character, index) => [CHARACTER_OFFSET+index, character.image])];
    const activeSources = new Set(pictures.map(([,source])=>source).filter(Boolean));
    for (const source of imageCache.keys()) if (!activeSources.has(source)) imageCache.delete(source);
    await Promise.all(pictures.map(async ([index, source]) => {
      if (!source) return;
      try {
        if (!imageCache.has(source)) imageCache.set(source, imagePixels(source));
        const pixels = await imageCache.get(source);
        if (!pixels || destroyed || runtime.stopped || generation !== epoch) return;
        write(pixels);
        call('app_image', index, 128, 128);
      } catch (error) {
        imageCache.delete(source);
        options.onImageError?.(error);
      }
    }));
  }
  const controller = {
    engine: 'Rusterize / Rust · WebAssembly',
    update,
    zoom(factor) { if (!destroyed && !runtime.stopped) call('app_zoom', number(factor, 1)); },
    reset() { if (!destroyed && !runtime.stopped) call('app_reset'); },
    focus(id) { const index=indices.get(id); if (index!==undefined && !destroyed && !runtime.stopped) { call('app_focus', index); canvas.focus({preventScroll:true}); } },
    /** Useful for accessible controls and integration tests; coordinates are CSS px. */
    position(id) {
      const index=indices.get(id);
      if (index===undefined || destroyed || runtime.stopped) return null;
      return {x:call('app_node_value',index,0), y:call('app_node_value',index,1), screenX:call('app_node_value',index,2), screenY:call('app_node_value',index,3)};
    },
    get frameCount() { return runtime.frameCount; },
    destroy() {
      if (destroyed) return;
      destroyed=true; generation++;
      canvas.removeEventListener('keydown', keyboard, true);
      canvas.removeEventListener('keyup', keyboard, true);
      canvas.removeEventListener('pointerup', drain);
      canvas.removeEventListener('keydown', drain);
      media.removeEventListener('change', setMotion);
      runtime.destroy(); imageCache.clear();
      delete canvas.dataset.engine;
    },
  };
  try { await update(options); } catch (error) { controller.destroy(); throw error; }
  return controller;
}
