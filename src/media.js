import { icon } from './icons.js';

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 1600;
const supportedImage = /^(image\/(?:jpeg|png|webp|gif|avif))$/i;
const imageID = () => globalThis.crypto?.randomUUID?.() || `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось прочитать изображение. Попробуйте JPEG, PNG или WebP.'));
    image.src = src;
  });
}

/** Normalize imported images to a bounded raster; strip metadata and keep data on this device. */
export async function fileToImage(file) {
  if (!file || typeof file.size !== 'number') throw new Error('Выберите файл изображения.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Изображение слишком большое. Максимальный размер — 12 МБ.');
  if (!supportedImage.test(file.type)) throw new Error('Поддерживаются JPEG, PNG, WebP, GIF и AVIF.');
  const url = URL.createObjectURL(file);
  try {
    const source = await loadImage(url);
    if (!source.naturalWidth || !source.naturalHeight) throw new Error('Изображение пустое или повреждено.');
    const scale = Math.min(1, MAX_EDGE / Math.max(source.naturalWidth, source.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('В этом браузере недоступна обработка изображений.');
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const src = canvas.toDataURL(type, 0.86);
    if (src === 'data:,') throw new Error('Не удалось сохранить изображение.');
    return { id: imageID(), src, caption: '' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Invoke from a user click. Android's capture option opens the rear camera when supported. */
export function pickImage({ capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.append(input);
    let settled = false;
    let processing = false;
    let focusTimer;
    const clean = () => {
      settled = true;
      clearTimeout(focusTimer);
      window.removeEventListener('focus', handleFocus);
      input.remove();
    };
    const cancel = () => { if (!settled && !processing) { clean(); resolve(null); } };
    const handleFocus = () => {
      // Old browsers do not emit "cancel". Give a pending change event time to arrive.
      focusTimer = setTimeout(() => { if (!input.files?.length) cancel(); }, 1200);
    };
    input.addEventListener('cancel', cancel, { once: true });
    input.addEventListener('change', async () => {
      if (settled) return;
      const file = input.files?.[0];
      if (!file) { cancel(); return; }
      processing = true;
      try { const image = await fileToImage(file); clean(); resolve(image); }
      catch (error) { clean(); reject(error); }
    }, { once: true });
    window.addEventListener('focus', handleFocus);
    try { input.click(); } catch (error) { clean(); reject(error); }
  });
}

/** Call in a paste listener; text-only paste is left completely unchanged. */
export async function pasteImage(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find(item => item.kind === 'file' && item.type.startsWith('image/'));
  const file = imageItem?.getAsFile();
  if (!file) return null;
  event.preventDefault();
  return fileToImage(file);
}

function ensureDrawingStyles() {
  if (document.getElementById('mob-drawing-styles')) return;
  const style = document.createElement('style');
  style.id = 'mob-drawing-styles';
  style.textContent = `
    .mob-drawing{color:#eef0f7;background:#171b25;border:1px solid #373c4b;border-radius:24px;padding:22px;width:min(900px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;box-sizing:border-box;box-shadow:0 24px 100px #0009;font:15px/1.5 system-ui,sans-serif}
    .mob-drawing::backdrop{background:#050811c9;backdrop-filter:blur(6px)}
    .mob-drawing *{box-sizing:border-box}.mob-drawing h2{margin:0;font-size:22px;font-weight:650}.mob-drawing p{margin:4px 0 14px;color:#adb4c6;font-size:13px}
    .mob-drawing-header,.mob-drawing-tools,.mob-drawing-footer{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.mob-drawing-header{justify-content:space-between;margin-bottom:4px}.mob-drawing-tools{margin:14px 0}.mob-drawing-footer{justify-content:flex-end;margin-top:16px}
    .mob-drawing button,.mob-drawing input[type=color]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;border:1px solid #3d4351;border-radius:11px;color:#edf0f7;background:#232937;font:inherit;padding:8px 12px;cursor:pointer}
    .mob-drawing button:focus-visible,.mob-drawing input:focus-visible,.mob-drawing canvas:focus-visible{outline:3px solid #c8b7ff;outline-offset:3px}.mob-drawing button:hover{background:#34374c}.mob-drawing button:disabled{opacity:.45;cursor:default}.mob-drawing button[aria-pressed=true]{border-color:#b2a0ff;background:#50436f}
    .mob-drawing .mob-drawing-color{width:32px;min-height:32px;height:32px;border-radius:50%;padding:0;background:var(--swatch);border:2px solid #626879}.mob-drawing .mob-drawing-color[aria-pressed=true]{outline:2px solid #e9e1ff;outline-offset:3px;border-color:#171b25;background:var(--swatch)}
    .mob-drawing input[type=color]{width:36px;min-height:36px;padding:3px}.mob-drawing input[type=range]{width:90px;accent-color:#b7a1f8}.mob-drawing label{display:flex;align-items:center;gap:8px;font-size:12px;color:#c3c8d7}.mob-drawing .mob-drawing-tools-separator{width:1px;height:28px;background:#3d4351;margin:0 3px}
    .mob-drawing-canvas-wrap{position:relative;overflow:hidden;border-radius:12px;background:#f7f3eb}.mob-drawing canvas{display:block;width:100%;height:auto;max-height:58dvh;aspect-ratio:4/3;object-fit:contain;touch-action:none;cursor:crosshair}.mob-drawing .mob-drawing-save{background:#c8b6f5;color:#211a35;border-color:#c8b6f5;font-weight:650}.mob-drawing .mob-drawing-save:hover{background:#d6c7f9}.mob-drawing-status{margin-right:auto;font-size:13px;color:#e9b4b8}.mob-drawing .mob-drawing-close{padding:8px;min-width:42px}
    @media(max-width:560px){.mob-drawing{padding:15px;border-radius:18px}.mob-drawing h2{font-size:19px}.mob-drawing-tools{gap:8px}.mob-drawing .mob-drawing-tool-label{display:none}.mob-drawing canvas{max-height:none}.mob-drawing label{gap:4px}.mob-drawing input[type=range]{width:64px}.mob-drawing .mob-drawing-tools-separator{display:none}}
  `;
  document.head.append(style);
}

/** Local drawing editor. Saves a PNG attachment via onSave; Escape/cancel makes no changes. */
export function openDrawing({ initial, onSave } = {}) {
  ensureDrawingStyles();
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'mob-drawing';
  const titleId = `drawing-${imageID()}`;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `
    <div class="mob-drawing-header"><h2 id="${titleId}">Нарисовать воспоминание</h2><button type="button" class="mob-drawing-close" data-drawing="cancel" aria-label="Закрыть рисунок">${icon('close')}</button></div>
    <p>Рисуйте пальцем, стилусом или мышью. Рисунок останется на вашем устройстве.</p>
    <div class="mob-drawing-tools" role="toolbar" aria-label="Инструменты рисования">
      <button type="button" data-drawing="pen" aria-label="Кисть" aria-pressed="true">${icon('draw')}<span class="mob-drawing-tool-label">Кисть</span></button>
      <button type="button" data-drawing="eraser" aria-label="Ластик" aria-pressed="false">${icon('eraser')}</button>
      <span class="mob-drawing-tools-separator"></span>
      ${[['#252832', 'Графитовый'], ['#8062b8', 'Фиолетовый'], ['#d9746e', 'Коралловый'], ['#4b9086', 'Бирюзовый'], ['#d5a34d', 'Золотистый']].map(([color, name]) => `<button type="button" class="mob-drawing-color" data-color="${color}" style="--swatch:${color}" aria-label="${name} цвет" aria-pressed="${color === '#252832'}"></button>`).join('')}
      <input type="color" value="#252832" aria-label="Выбрать другой цвет">
      <label>Размер <input type="range" min="1" max="32" value="4" aria-label="Толщина кисти"></label>
      <span class="mob-drawing-tools-separator"></span>
      <button type="button" data-drawing="undo" aria-label="Отменить штрих" disabled>${icon('undo')}</button>
      <button type="button" data-drawing="clear" aria-label="Очистить рисунок">${icon('trash')}</button>
    </div>
    <div class="mob-drawing-canvas-wrap"><canvas width="1024" height="768" tabindex="0" aria-label="Холст для рисования. Используйте мышь, палец или стилус."></canvas></div>
    <div class="mob-drawing-footer"><span class="mob-drawing-status" role="status" aria-live="polite"></span><button type="button" data-drawing="cancel">Отмена</button><button type="button" class="mob-drawing-save" data-drawing="save">${icon('check')}Сохранить рисунок</button></div>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = 1024;
  const height = 768;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) { dialog.remove(); throw new Error('В этом браузере рисование недоступно.'); }
  context.scale(dpr, dpr);
  const paper = '#f7f3eb';
  context.fillStyle = paper;
  context.fillRect(0, 0, width, height);
  let color = '#252832';
  let brushWidth = 4;
  let eraser = false;
  let activePointer = null;
  let previousPoint = null;
  let initialLoading = false;
  let saving = false;
  let disposed = false;
  const history = [];
  const undoButton = dialog.querySelector('[data-drawing=undo]');
  const saveButton = dialog.querySelector('[data-drawing=save]');
  const status = dialog.querySelector('.mob-drawing-status');
  const snapshot = () => { history.push(context.getImageData(0, 0, canvas.width, canvas.height)); if (history.length > 8) history.shift(); undoButton.disabled = false; };
  const selectTool = value => {
    eraser = value;
    dialog.querySelector('[data-drawing=eraser]').setAttribute('aria-pressed', String(value));
    dialog.querySelector('[data-drawing=pen]').setAttribute('aria-pressed', String(!value));
  };
  const selectColor = value => {
    color = value;
    selectTool(false);
    dialog.querySelector('input[type=color]').value = value;
    dialog.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === value)));
  };
  const point = event => {
    const bounds = canvas.getBoundingClientRect();
    // object-fit can letterbox the canvas when its maximum height applies.
    const scale = Math.min(bounds.width / width, bounds.height / height);
    const offsetX = (bounds.width - width * scale) / 2;
    const offsetY = (bounds.height - height * scale) / 2;
    return { x: (event.clientX - bounds.left - offsetX) / scale, y: (event.clientY - bounds.top - offsetY) / scale };
  };
  const stroke = (from, to, pressure) => {
    const lineWidth = brushWidth * (eraser ? 4 : 1) * (pressure > 0 && pressure !== 0.5 ? Math.max(0.35, pressure * 1.6) : 1);
    context.strokeStyle = eraser ? paper : color;
    context.fillStyle = context.strokeStyle;
    context.lineWidth = lineWidth;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    if (from.x === to.x && from.y === to.y) { context.beginPath(); context.arc(to.x, to.y, lineWidth / 2, 0, Math.PI * 2); context.fill(); }
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || activePointer !== null || initialLoading || saving) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    snapshot();
    previousPoint = point(event);
    stroke(previousPoint, previousPoint, event.pressure);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== activePointer) return;
    event.preventDefault();
    const events = event.getCoalescedEvents?.() || [event];
    for (const sample of events.length ? events : [event]) {
      const next = point(sample);
      stroke(previousPoint, next, sample.pressure);
      previousPoint = next;
    }
  });
  const endStroke = event => {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = null;
    previousPoint = null;
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('lostpointercapture', () => { activePointer = null; previousPoint = null; });
  const undo = () => {
    if (initialLoading || saving || activePointer !== null) return;
    const previous = history.pop();
    if (previous) context.putImageData(previous, 0, 0);
    undoButton.disabled = !history.length;
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    history.length = 0;
    dialog.remove();
    previousFocus?.focus?.({ preventScroll: true });
  };
  const close = () => { dialog.close(); cleanup(); };
  dialog.addEventListener('close', cleanup, { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!saving) close(); });
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.color) { selectColor(button.dataset.color); return; }
    const action = button.dataset.drawing;
    if (action === 'cancel' && !saving) close();
    else if (action === 'pen') selectTool(false);
    else if (action === 'eraser') selectTool(true);
    else if (action === 'undo') undo();
    else if (action === 'clear' && !initialLoading && !saving) { snapshot(); context.fillStyle = paper; context.fillRect(0, 0, width, height); }
    else if (action === 'save' && !initialLoading && !saving) {
      saving = true;
      saveButton.disabled = true;
      status.textContent = 'Сохранение…';
      try {
        // Export at 1024×768 independently of the screen's DPR.
        const output = document.createElement('canvas');
        output.width = width; output.height = height;
        const outputContext = output.getContext('2d');
        if (!outputContext) throw new Error('Не удалось сохранить рисунок.');
        outputContext.drawImage(canvas, 0, 0, width, height);
        const image = { id: imageID(), src: output.toDataURL('image/png'), caption: '' };
        if (typeof onSave === 'function') await onSave(image);
        dialog.dispatchEvent(new CustomEvent('drawing-save', { detail: image }));
        close();
      } catch (error) {
        status.textContent = error.message || 'Не удалось сохранить рисунок. Попробуйте ещё раз.';
        saving = false;
        saveButton.disabled = false;
      }
    }
  });
  dialog.querySelector('input[type=color]').addEventListener('input', event => selectColor(event.target.value));
  dialog.querySelector('input[type=range]').addEventListener('input', event => { brushWidth = Number(event.target.value); });
  const initialSource = typeof initial === 'string' ? initial : initial?.src;
  if (initialSource && /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,|blob:)/i.test(initialSource)) {
    initialLoading = true;
    saveButton.disabled = true;
    status.textContent = 'Загрузка рисунка…';
    loadImage(initialSource).then(image => {
      if (disposed) return;
      const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      context.drawImage(image, (width - image.naturalWidth * scale) / 2, (height - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
      status.textContent = '';
    }).catch(error => { status.textContent = error.message; }).finally(() => { initialLoading = false; saveButton.disabled = false; });
  }
  dialog.showModal();
  return dialog;
}
