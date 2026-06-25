'use strict';
/* Act2Answer asset creator — vanilla JS, no backend.
 * Builds asset sets compatible with ManiSkill carrot/<set> (more_celeb_v2 format):
 *   <set>/model_db.json, <set>/pairs.json, <set>/shapes/<name>/{textured.glb,collision.obj}
 * Each tile's textured.glb is the bundled base tile with ONLY its face PNG swapped
 * (geometry/UV/material bytes kept identical). */

(function () {
  const TEX_SIZE = 512;                      // square face texture
  const DENSITY = 6368;
  const BBOX = { min: [-0.055, -0.055, -0.003], max: [0.055, 0.055, 0.003] };

  // GLB chunk type tags (little-endian uint32)
  const T_JSON = 0x4e4f534a; // "JSON"
  const T_BIN  = 0x004e4942; // "BIN\0"
  const MAGIC  = 0x46546c67; // "glTF"

  // ---- base template (loaded once) ----
  let baseJson = null, baseBin = null, geomEnd = 0, imgBv = 0, collisionText = '';

  // ---- editor state ----
  const tasks = [];                          // {leftPng, rightPng, question, answer}
  const cur = {
    leftFile: null, rightFile: null, leftPng: null, rightPng: null,
    leftFlip: false, rightFlip: false,
  };
  let answer = null;                         // 'Left' | 'Right'

  const pad4 = (n) => (n + 3) & ~3;
  const $ = (id) => document.getElementById(id);
  const fileKey = (s) => (s === 'Left' ? 'leftFile' : 'rightFile');
  const pngKey = (s) => (s === 'Left' ? 'leftPng' : 'rightPng');
  const flipKey = (s) => (s === 'Left' ? 'leftFlip' : 'rightFlip');
  const mvId = (s) => (s === 'Left' ? 'mv-left' : 'mv-right');

  async function loadBase() {
    const buf = await (await fetch('base/tile.glb')).arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('base/tile.glb is not a GLB');
    const total = dv.getUint32(8, true);
    let off = 12, jsonStr = null, bin = null;
    while (off < total) {
      const clen = dv.getUint32(off, true);
      const ctype = dv.getUint32(off + 4, true);
      const body = new Uint8Array(buf, off + 8, clen);
      if (ctype === T_JSON) jsonStr = new TextDecoder().decode(body);
      else if (ctype === T_BIN) bin = body.slice();
      off += 8 + clen;
    }
    baseJson = JSON.parse(jsonStr);
    baseBin = bin;
    imgBv = baseJson.images[0].bufferView;
    geomEnd = baseJson.bufferViews[imgBv].byteOffset || 0;   // image is the last bufferView
    collisionText = await (await fetch('base/collision.obj')).text();
  }

  // Center-crop an uploaded image to a square (cover) filling the whole tile face,
  // optionally flipped vertically; return PNG bytes.
  function imageToSquarePng(file, flip) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = TEX_SIZE;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);              // center "cover" crop to square
        const sx = (img.width - s) / 2, sy = (img.height - s) / 2;
        if (flip) { ctx.translate(0, TEX_SIZE); ctx.scale(1, -1); }
        ctx.drawImage(img, sx, sy, s, s, 0, 0, TEX_SIZE, TEX_SIZE);
        c.toBlob((blob) => blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))), 'image/png');
      };
      img.onerror = () => reject(new Error('could not load image'));
      img.src = URL.createObjectURL(file);
    });
  }

  // Build a GLB = base geometry bytes + new PNG, with offsets/lengths fixed.
  function makeTileGlb(pngBytes) {
    const json = JSON.parse(JSON.stringify(baseJson));
    json.images[0].mimeType = 'image/png';
    const bv = json.bufferViews[imgBv];
    bv.byteOffset = geomEnd;
    bv.byteLength = pngBytes.length;
    const binLen = geomEnd + pngBytes.length;
    json.buffers[0].byteLength = binLen;

    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = pad4(jsonBytes.length);
    const jsonChunk = new Uint8Array(jsonPad).fill(0x20);
    jsonChunk.set(jsonBytes);

    const binPad = pad4(binLen);
    const binChunk = new Uint8Array(binPad);
    binChunk.set(baseBin.subarray(0, geomEnd), 0);
    binChunk.set(pngBytes, geomEnd);

    const totalLen = 12 + 8 + jsonPad + 8 + binPad;
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, totalLen, true);
    let o = 12;
    dv.setUint32(o, jsonPad, true); dv.setUint32(o + 4, T_JSON, true); o += 8;
    out.set(jsonChunk, o); o += jsonPad;
    dv.setUint32(o, binPad, true); dv.setUint32(o + 4, T_BIN, true); o += 8;
    out.set(binChunk, o);
    return out;
  }

  function modelDbEntry(name) {
    return { name, sign: name, bbox: BBOX, scales: [1.0], density: DENSITY };
  }

  // ---- preview ----
  function setPreview(side, pngBytes) {
    const mv = $(mvId(side));
    if (mv._url) URL.revokeObjectURL(mv._url);
    const url = URL.createObjectURL(new Blob([makeTileGlb(pngBytes)], { type: 'model/gltf-binary' }));
    mv._url = url; mv.src = url;
    mv.closest('.card').classList.add('filled');
  }

  async function handleFile(side, file) {
    if (!file || !file.type.startsWith('image/')) return;
    cur[fileKey(side)] = file;
    const png = await imageToSquarePng(file, cur[flipKey(side)]);
    cur[pngKey(side)] = png;
    setPreview(side, png);
    refreshControls();
  }

  // Toggle vertical flip for one tile and re-render it.
  async function flipSide(side) {
    cur[flipKey(side)] = !cur[flipKey(side)];
    $(`flip-${side.toLowerCase()}`).classList.toggle('active', cur[flipKey(side)]);
    if (cur[fileKey(side)]) {
      const png = await imageToSquarePng(cur[fileKey(side)], cur[flipKey(side)]);
      cur[pngKey(side)] = png;
      setPreview(side, png);
    }
  }

  function refreshControls() {
    const ready = cur.leftPng && cur.rightPng && $('question').value.trim() && answer;
    $('done').disabled = !ready;
    $('finish').disabled = tasks.length === 0;
    $('task-count').textContent = tasks.length;
  }

  function resetCurrent() {
    cur.leftFile = cur.rightFile = cur.leftPng = cur.rightPng = null;
    cur.leftFlip = cur.rightFlip = false;
    answer = null;
    $('question').value = '';
    document.querySelectorAll('.ans-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.flipbtn').forEach((b) => b.classList.remove('active'));
    ['Left', 'Right'].forEach((s) => {
      const mv = $(mvId(s));
      if (mv._url) { URL.revokeObjectURL(mv._url); mv._url = null; }
      mv.removeAttribute('src');
      mv.closest('.card').classList.remove('filled');
    });
    refreshControls();
  }

  function addTask() {
    tasks.push({ leftPng: cur.leftPng, rightPng: cur.rightPng, question: $('question').value.trim(), answer });
    renderTasks();
    resetCurrent();
  }

  function pngThumb(pngBytes) {
    const url = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));
    return `<img src="${url}" class="thumb">`;
  }

  function renderTasks() {
    $('tasks').innerHTML = tasks.map((t, i) => `
      <div class="task">
        <span class="ti">#${i}</span>
        ${pngThumb(t.leftPng)}${pngThumb(t.rightPng)}
        <span class="tq">${t.question}</span>
        <span class="ta ${t.answer.toLowerCase()}">${t.answer}</span>
        <button data-i="${i}" class="del">✕</button>
      </div>`).join('');
    $('tasks').querySelectorAll('.del').forEach((b) =>
      b.onclick = () => { tasks.splice(+b.dataset.i, 1); renderTasks(); refreshControls(); });
    refreshControls();
  }

  async function finish() {
    const set = ($('set-name').value.trim() || 'my_act2answer_set').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const zip = new JSZip();
    const root = zip.folder(set);
    const modelDb = {}, pairs = [];
    tasks.forEach((t, i) => {
      const ln = `tile_${2 * i}`, rn = `tile_${2 * i + 1}`;
      root.file(`shapes/${ln}/textured.glb`, makeTileGlb(t.leftPng));
      root.file(`shapes/${ln}/collision.obj`, collisionText);
      root.file(`shapes/${rn}/textured.glb`, makeTileGlb(t.rightPng));
      root.file(`shapes/${rn}/collision.obj`, collisionText);
      modelDb[ln] = modelDbEntry(ln);
      modelDb[rn] = modelDbEntry(rn);
      pairs.push({ index: i, left: ln, right: rn, question: t.question, answer: t.answer });
    });
    root.file('model_db.json', JSON.stringify(modelDb, null, 2));
    root.file('pairs.json', JSON.stringify(pairs, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${set}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---- wiring ----
  function wireDrop(side) {
    const zone = $(side === 'Left' ? 'tile-left' : 'tile-right');
    const input = zone.querySelector('input[type=file]');
    zone.querySelector('.zone').addEventListener('click', (e) => {
      if (e.target.tagName !== 'MODEL-VIEWER' && !e.target.classList.contains('flipbtn')) input.click();
    });
    input.addEventListener('change', () => handleFile(side, input.files[0]));
    const z = zone.querySelector('.zone');
    ['dragover', 'dragenter'].forEach((ev) => z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => z.addEventListener(ev, (e) => { e.preventDefault(); z.classList.remove('drag'); }));
    z.addEventListener('drop', (e) => handleFile(side, e.dataTransfer.files[0]));
    $(`flip-${side.toLowerCase()}`).addEventListener('click', (e) => { e.stopPropagation(); flipSide(side); });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    try { await loadBase(); } catch (e) { $('status').textContent = 'Failed to load base tile: ' + e.message; return; }
    wireDrop('Left'); wireDrop('Right');
    $('question').addEventListener('input', refreshControls);
    document.querySelectorAll('.ans-btn').forEach((b) => b.onclick = () => {
      answer = b.dataset.ans;
      document.querySelectorAll('.ans-btn').forEach((x) => x.classList.toggle('active', x === b));
      refreshControls();
    });
    $('done').onclick = addTask;
    $('finish').onclick = finish;
    refreshControls();
    $('status').textContent = 'Ready.';
  });
})();
