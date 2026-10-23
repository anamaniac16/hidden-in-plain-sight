/*
 * app.js
 * Everything the user sees: views, canvases, charts and the controls that
 * drive the engine in engine.js. Heavy work (training, scanning) runs in
 * small time slices inside requestAnimationFrame so the page stays smooth.
 */
(function () {
  'use strict';

  const C = window.Camo;
  const $ = (id) => document.getElementById(id);
  const W = 720, H = 432;
  const SHOWN = 12;            // creatures painted into the lab scene
  const FOOLED = 0.10;         // detection rate at which the AI counts as fooled
  const NAIVE_STEPS = 500;
  const HARDEN_STEPS = 450;
  const AUTO_ROUNDS = 4;
  const AUTO_MAX_GENS = 45;
  const SCAN_STRIDE = 8;
  const VIEWS = ['brief', 'lab', 'hunt', 'findings', 'method'];

  const css = getComputedStyle(document.documentElement);
  const COL = {
    bone: css.getPropertyValue('--bone').trim() || '#ebe3cf',
    muted: css.getPropertyValue('--muted').trim() || '#8f9b92',
    line: css.getPropertyValue('--line').trim() || '#2d3832',
    amber: css.getPropertyValue('--amber').trim() || '#efa43c',
    sage: css.getPropertyValue('--sage').trim() || '#9ec79a',
    coral: css.getPropertyValue('--coral').trim() || '#ee6a4d',
    ink: css.getPropertyValue('--ink').trim() || '#0e1311',
  };
  const MONO = '500 12px "JetBrains Mono", ui-monospace, monospace';

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const S = {
    view: 'brief',
    habitat: 'birch', species: 'moth',
    hab: null, net: null, naive: null, evo: null,
    baseline: null, falseAlarm: null,
    round: 1, roundStartGen: 0, roundStartDet: null,
    fooled: false, foolGen: null,
    history: [], hardenMarks: [], rounds: [], archive: [], firstAttack: null,
    xCounter: 0,
    phase: 'idle', running: false, auto: null, job: null,
    speed: 5, lastGenAt: 0,
    spots: [], spotP: [], sceneImg: null, sceneCanvas: document.createElement('canvas'),
    vision: false, reveal: false, grid: null, scanRow: 0,
    lossHist: [], lossMarks: [],
    robust: null, hunts: [],
  };
  S.sceneCanvas.width = W; S.sceneCanvas.height = H;

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  const pct = (v, d = 0) => (v === null || v === undefined || isNaN(v) ? '–' : (v * 100).toFixed(d) + '%');
  const pad4 = (n) => String(n).padStart(4, '0');
  const ctx2d = (c) => c.getContext('2d');

  function floatToCanvas(buf, w, h, canvas, scaleTo) {
    const tmp = scaleTo ? document.createElement('canvas') : canvas;
    if (scaleTo) { tmp.width = w; tmp.height = h; }
    const cx = ctx2d(tmp);
    const id = cx.createImageData(w, h);
    const d = id.data;
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      d[i * 4] = buf[j] * 255; d[i * 4 + 1] = buf[j + 1] * 255; d[i * 4 + 2] = buf[j + 2] * 255; d[i * 4 + 3] = 255;
    }
    cx.putImageData(id, 0, 0);
    if (scaleTo) {
      const out = ctx2d(canvas);
      out.imageSmoothingEnabled = scaleTo === 'smooth';
      out.clearRect(0, 0, canvas.width, canvas.height);
      out.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    }
  }

  // A size x size crop of the habitat with a creature pasted at (sx, sy).
  function cropWith(hab, x0, y0, size, sprite, sx, sy, rot) {
    const buf = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      const yy = Math.min(hab.H - 1, Math.max(0, y0 + y));
      for (let x = 0; x < size; x++) {
        const xx = Math.min(hab.W - 1, Math.max(0, x0 + x));
        const s = (yy * hab.W + xx) * 3, t = (y * size + x) * 3;
        buf[t] = hab.rgb[s]; buf[t + 1] = hab.rgb[s + 1]; buf[t + 2] = hab.rgb[s + 2];
      }
    }
    if (sprite) C.stamp(buf, size, size, sprite, sx, sy, rot || 0);
    return buf;
  }

  function tileSpot(id, size) {
    return { x: (id * 7919) % (W - size), y: (id * 104729 + 13) % (H - size) };
  }

  function toast(html, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = html;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 380); }, ms || 4200);
  }

  function setPhase(p, label) {
    S.phase = p;
    const el = $('phase');
    el.dataset.phase = p;
    el.textContent = label || {
      idle: 'Idle', ready: 'Ready', training: 'Training the AI', evolving: 'Prey evolving',
      hardening: 'Hardening the AI', fooled: 'AI fooled', testing: 'Robustness test',
    }[p] || p;
    updateGlobalStatus();
    syncButtons();
  }

  function updateGlobalStatus() {
    const el = $('globalStatus');
    const busy = !!S.job || S.running;
    el.dataset.state = busy ? 'busy' : S.net && S.naive ? 'ok' : 'busy';
    const t = el.querySelector('.txt');
    if (S.job && S.job.label) t.textContent = S.job.label;
    else if (S.running) t.textContent = `Round ${S.round} · gen ${S.evo.generation}`;
    else if (S.naive) t.textContent = 'Ready';
    else t.textContent = 'Starting';
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  function showView(v, push) {
    if (!VIEWS.includes(v)) v = 'brief';
    S.view = v;
    document.querySelectorAll('.view').forEach((sec) => {
      const on = sec.dataset.view === v;
      sec.hidden = !on;
      if (on) { sec.classList.remove('entering'); void sec.offsetWidth; sec.classList.add('entering'); }
    });
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (push !== false) { try { history.replaceState(null, '', '#' + v); } catch (e) { /* viewer may block */ } }
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    if (v === 'findings') renderFindings();
    if (v === 'hunt') drawHunt();
    if (v === 'lab') { drawLab(); drawRace(); drawLoss(); drawMind(); }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-view]');
    if (!a || a.tagName === 'SECTION') return;
    e.preventDefault();
    const hab = a.dataset.habitat;
    if (hab && hab !== S.habitat) { S.habitat = hab; buildSegs(); startExperiment(); }
    showView(a.dataset.view);
  });

  // ------------------------------------------------------------------
  // Experiment lifecycle
  // ------------------------------------------------------------------
  function startExperiment() {
    S.job = null; S.running = false; S.auto = null;
    C.resetIds();
    S.hab = C.paintHabitat(S.habitat, W, H, 1234 + Object.keys(C.HABITATS).indexOf(S.habitat) * 17);
    S.net = C.createPredator();
    S.naive = null; S.baseline = null; S.falseAlarm = null;
    S.evo = new C.Evolution();
    S.round = 1; S.roundStartGen = 0; S.roundStartDet = null; S.fooled = false; S.foolGen = null;
    S.history = []; S.hardenMarks = []; S.rounds = []; S.archive = []; S.firstAttack = null; S.xCounter = 0;
    S.lossHist = []; S.lossMarks = []; S.robust = null; S.grid = null; S.scanRow = 0;
    S.lastFooled = null;
    S.spots = C.placeCreatures(S.hab, SHOWN, 6);
    S.spotP = new Array(SHOWN).fill(null);
    for (const ind of S.evo.pop) { ind.sprite = C.renderSprite(ind.g, S.species); ind.sprite.species = S.species; ind.p = null; }

    const name = C.HABITATS[S.habitat].name;
    $('labPlateName').textContent = name;
    $('heroPlateName').textContent = name;
    $('huntPlateName').textContent = name;
    resetHunt();
    updateScene();
    buildDrawer();
    updateDrawer();
    updateReadout(null);
    $('paramCount').textContent = S.net.paramCount().toLocaleString('en-IN') + ' weights';

    // Train the naive predator
    const tr = new C.Trainer(S.net, S.hab, S.species, () => C.randomGenome(), { steps: NAIVE_STEPS });
    S.lossMarks.push({ at: 0, label: 'trained' });
    showVeil('Training the predator', 'Showing it habitat patches with and without random creatures');
    S.job = {
      label: 'Training the AI',
      tick(budget) {
        const t0 = performance.now();
        while (performance.now() - t0 < budget && !tr.finished()) S.lossHist.push(tr.run(1));
        setVeil(tr.done / tr.steps);
        return tr.finished();
      },
      onDone() {
        S.naive = S.net.clone();
        const sample = Array.from({ length: 60 }, () => C.randomGenome());
        S.baseline = C.detectionRate(S.naive, S.hab, S.species, sample, 3).rate;
        S.falseAlarm = C.falseAlarmRate(S.naive, S.hab, 200);
        hideVeil();
        const st = S.evo.evaluate(S.net, S.hab, S.species);
        S.roundStartDet = st.detection;
        afterEvaluate(st);
        drawMind();
        setPhase('ready');
        toast(`<b>Predator trained.</b> It catches ${pct(S.baseline)} of random creatures, with ${pct(S.falseAlarm)} false alarms on empty bark. Now let the prey evolve.`);
      },
    };
    setPhase('training');
    drawRace(); drawLoss();
  }

  function afterEvaluate(st, noHistory) {
    if (!noHistory) {
      S.history.push({ x: S.xCounter, det: st.detection, meanP: st.meanP, round: S.round });
    }
    updateScene();
    updateDrawer();
    updateReadout(st);
    drawRace();
    if (S.sheetInd) refreshSheet();

    // while the AI stays fooled this round, keep the most hidden prey for the hunt
    if (S.fooled && st.detection <= FOOLED && S.lastFooled && S.lastFooled.round === S.round) {
      S.lastFooled.inds = S.evo.pop.slice(0, 8);
      S.lastFooled.gen = S.evo.generation;
    }

    if (!S.fooled && st.detection <= FOOLED && S.history.length > 1) {
      S.fooled = true;
      S.foolGen = S.evo.generation;
      const gens = S.evo.generation - S.roundStartGen;
      if (!S.firstAttack) S.firstAttack = S.evo.pop.map((i) => new Float32Array(i.g));
      // keep the prey that fooled this predator, for the human-vs-AI hunt
      S.lastFooled = { inds: S.evo.pop.slice(0, 8), net: S.net.clone(), round: S.round, gen: S.evo.generation };
      updateHuntSource();
      setPhase('fooled');
      toast(`<b>Blind spot found in ${gens} generation${gens === 1 ? '' : 's'}.</b> The AI now misses ${pct(1 - st.detection)} of the population. ${S.auto ? '' : 'Harden the AI to fight back.'}`, 5200);
      if (!S.auto) { S.running = false; syncButtons(); }
    }
  }

  function doGeneration() {
    if (!S.naive || S.job) return;
    S.evo.nextGeneration();
    S.xCounter++;
    const st = S.evo.evaluate(S.net, S.hab, S.species);
    if (S.phase !== 'fooled' && S.phase !== 'evolving') setPhase('evolving');
    afterEvaluate(st);
    autoCheck(st);
    updateGlobalStatus();
  }

  function harden(then) {
    if (!S.naive || S.job) return;
    S.running = false;
    const evolved = S.evo.pop.map((i) => i.g);
    const endDet = S.evo.stats().detection;
    S.archive.push(...evolved.slice(0, 12).map((g) => new Float32Array(g)));
    if (S.archive.length > 120) S.archive.splice(0, S.archive.length - 120);
    const archive = S.archive;
    const pool = () => {
      const u = C.random();
      if (u < 0.5) return evolved[C.randInt(evolved.length)];
      if (u < 0.85) return archive[C.randInt(archive.length)];
      return C.randomGenome();
    };
    const tr = new C.Trainer(S.net, S.hab, S.species, pool, { steps: HARDEN_STEPS });
    S.lossMarks.push({ at: S.lossHist.length, label: 'R' + S.round });
    showVeil('Hardening the AI', `Retraining on the ${evolved.length} survivors and ${archive.length} earlier camouflaged creatures`);
    setPhase('hardening');
    const roundRec = {
      round: S.round,
      startDet: S.roundStartDet,
      fooledAt: S.fooled ? S.foolGen - S.roundStartGen : null,
      gens: S.evo.generation - S.roundStartGen,
      endDet,
      afterDet: null,
    };
    S.job = {
      label: 'Hardening the AI',
      tick(budget) {
        const t0 = performance.now();
        while (performance.now() - t0 < budget && !tr.finished()) S.lossHist.push(tr.run(1));
        setVeil(tr.done / tr.steps);
        if (S.view === 'lab') drawLoss();
        return tr.finished();
      },
      onDone() {
        hideVeil();
        S.hardenMarks.push({ x: S.xCounter, round: S.round });
        const st = S.evo.evaluate(S.net, S.hab, S.species);
        roundRec.afterDet = st.detection;
        S.rounds.push(roundRec);
        S.round++;
        S.roundStartGen = S.evo.generation;
        S.roundStartDet = st.detection;
        S.fooled = st.detection <= FOOLED;
        S.foolGen = S.fooled ? S.evo.generation : null;
        afterEvaluate(st);
        if (S.fooled) {
          toast('<b>Hardening was not enough this time.</b> The AI still misses most of these creatures. Evolve more and harden again.');
          setPhase('fooled');
        } else {
          setPhase('ready', 'AI hardened');
          toast(`<b>AI hardened.</b> It now catches ${pct(st.detection)} of the creatures that had fooled it. Round ${S.round} begins.`);
        }
        drawMind();
        if (then) then();
      },
    };
  }

  function autoCheck(st) {
    if (!S.auto) return;
    const gensThis = S.evo.generation - S.roundStartGen;
    const doneEvolving = (S.fooled && S.evo.generation - S.foolGen >= 3) || gensThis >= AUTO_MAX_GENS;
    if (!doneEvolving) return;
    if (gensThis >= AUTO_MAX_GENS && !S.fooled) {
      toast(`<b>The AI held out for ${AUTO_MAX_GENS} generations</b> this round. Hardening anyway.`);
    }
    autoHarden();
  }

  function autoHarden() {
    S.running = false;
    harden(() => {
      if (!S.auto) return;
      S.auto.left--;
      if (S.auto.left > 0) { S.running = true; setPhase('evolving'); }
      else {
        S.auto = null;
        toast('<b>Arms race finished.</b> The Findings page now has the full report.', 6000);
        syncButtons();
      }
    });
  }

  // ------------------------------------------------------------------
  // Lab scene
  // ------------------------------------------------------------------
  function shownMembers() {
    const pop = S.evo.pop;
    const out = [];
    for (let i = 0; i < SHOWN; i++) out.push(pop[(i * 3) % pop.length]);
    return out;
  }

  function updateScene() {
    const members = shownMembers();
    const placed = S.spots.map((sp, i) => ({ ...sp, sprite: members[i].sprite || C.renderSprite(members[i].g, S.species), ind: members[i] }));
    S.placed = placed;
    S.sceneImg = C.composeScene(S.hab, placed);
    floatToCanvas(S.sceneImg, W, H, S.sceneCanvas);
    // exact predator response at each creature's own position
    if (S.naive) {
      const x = new Float32Array(C.INPUT_LEN);
      placed.forEach((c, i) => {
        C.viewWindow(S.sceneImg, W, c.x, c.y, x);
        S.spotP[i] = S.net.forward(x);
      });
    }
    drawLab();
  }

  function drawLab() {
    if (!S.hab) return;
    const cx = ctx2d($('labCanvas'));
    cx.drawImage(S.sceneCanvas, 0, 0);
    drawLabOverlay();
  }

  function drawHeat(cx, grid, alphaScale) {
    if (!grid) return;
    const tmp = drawHeat.tmp || (drawHeat.tmp = document.createElement('canvas'));
    tmp.width = grid.cols; tmp.height = grid.rows;
    const t = ctx2d(tmp);
    const id = t.createImageData(grid.cols, grid.rows);
    for (let i = 0; i < grid.p.length; i++) {
      const p = grid.p[i];
      const a = Math.min(1, Math.pow(p, 1.3) * (alphaScale || 0.9));
      id.data[i * 4] = 239; id.data[i * 4 + 1] = 150 + 30 * p; id.data[i * 4 + 2] = 50;
      id.data[i * 4 + 3] = a * 255;
    }
    t.putImageData(id, 0, 0);
    cx.save();
    cx.imageSmoothingEnabled = true;
    cx.globalCompositeOperation = 'screen';
    const off = C.WIN / 2 - grid.stride / 2;
    cx.drawImage(tmp, off, off, grid.cols * grid.stride, grid.rows * grid.stride);
    cx.restore();
  }

  function drawScanline(cx, y) {
    const g = cx.createLinearGradient(0, y - 26, 0, y + 2);
    g.addColorStop(0, 'rgba(239,164,60,0)');
    g.addColorStop(1, 'rgba(239,164,60,0.28)');
    cx.fillStyle = g;
    cx.fillRect(0, y - 26, W, 28);
    cx.fillStyle = COL.amber;
    cx.fillRect(0, y, W, 1.5);
  }

  function brackets(cx, x, y, s, color, label) {
    const k = 8;
    cx.strokeStyle = color; cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(x, y + k); cx.lineTo(x, y); cx.lineTo(x + k, y);
    cx.moveTo(x + s - k, y); cx.lineTo(x + s, y); cx.lineTo(x + s, y + k);
    cx.moveTo(x + s, y + s - k); cx.lineTo(x + s, y + s); cx.lineTo(x + s - k, y + s);
    cx.moveTo(x + k, y + s); cx.lineTo(x, y + s); cx.lineTo(x, y + s - k);
    cx.stroke();
    if (label) {
      cx.font = MONO;
      const w = cx.measureText(label).width + 8;
      const ly = y - 18 < 0 ? y + s + 3 : y - 18;
      cx.fillStyle = 'rgba(14,19,17,0.82)';
      cx.fillRect(x, ly, w, 16);
      cx.fillStyle = color;
      cx.fillText(label, x + 4, ly + 12);
    }
  }

  function drawLabOverlay() {
    const cx = ctx2d($('labOverlay'));
    cx.clearRect(0, 0, W, H);
    if (S.vision && S.naive) {
      cx.fillStyle = 'rgba(10,14,12,0.55)';
      cx.fillRect(0, 0, W, H);
      drawHeat(cx, S.grid, 1);
      if (S.grid) drawScanline(cx, Math.min(H - 2, S.scanRow * SCAN_STRIDE + C.WIN / 2));
    }
    if (S.reveal && S.placed) {
      S.placed.forEach((c, i) => {
        const p = S.spotP[i];
        const seen = p !== null && p > 0.5;
        brackets(cx, c.x - 3, c.y - 3, C.S + 6, seen ? COL.coral : COL.sage, p === null ? '' : `${Math.round(p * 100)}%`);
      });
    }
  }

  // Predator vision: keep sweeping the scene a few rows per frame.
  function scanTick(budget) {
    if (!S.naive || !S.sceneImg) return;
    const t0 = performance.now();
    if (!S.grid) { S.grid = C.scanScene(S.net, S.sceneImg, W, H, SCAN_STRIDE, 0, 0); S.scanRow = 0; }
    while (performance.now() - t0 < budget) {
      C.scanScene(S.net, S.sceneImg, W, H, SCAN_STRIDE, S.scanRow, S.scanRow + 1, S.grid);
      S.scanRow++;
      if (S.scanRow >= S.grid.rows) { S.scanRow = 0; break; }
    }
  }

  // ------------------------------------------------------------------
  // Readout + drawer
  // ------------------------------------------------------------------
  function updateReadout(st) {
    $('roundGen').textContent = `Round ${S.round} · Gen ${S.evo ? S.evo.generation : 0}`;
    const det = st ? st.detection : null;
    const big = $('detRate');
    big.textContent = det === null ? '–' : pct(det);
    big.classList.toggle('low', det !== null && det <= FOOLED);
    const bar = $('detBar');
    bar.style.width = det === null ? '0' : det * 100 + '%';
    bar.style.background = det !== null && det <= FOOLED ? COL.coral : COL.bone;
    $('meanP').textContent = st ? pct(st.meanP) : '–';
    $('bestP').textContent = st ? pct(st.best.p, 1) + ' seen' : '–';
    $('baseline').textContent = S.baseline === null ? '–' : pct(S.baseline);
  }

  function buildDrawer() {
    const box = $('specimens');
    box.innerHTML = '';
    S.tiles = [];
    for (let i = 0; i < S.evo.popSize; i++) {
      const b = document.createElement('button');
      b.className = 'specimen';
      b.type = 'button';
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const row = document.createElement('div');
      row.className = 'lab-row';
      row.innerHTML = '<span class="no"></span><span class="seen"></span>';
      b.append(c, row);
      b.addEventListener('click', () => openSheet(S.evo.pop[i]));
      box.appendChild(b);
      S.tiles.push({ b, c, no: row.firstChild, seen: row.lastChild, id: null });
    }
  }

  function updateDrawer() {
    if (!S.tiles) return;
    S.evo.pop.forEach((ind, i) => {
      const t = S.tiles[i];
      if (!t) return;
      if (t.id !== ind.id) {
        const spot = tileSpot(ind.id, 48);
        const buf = cropWith(S.hab, spot.x, spot.y, 48, ind.sprite, 8, 8, 0);
        floatToCanvas(buf, 48, 48, t.c, 'smooth');
        t.id = ind.id;
        t.no.textContent = 'No. ' + pad4(ind.id);
      }
      t.seen.textContent = ind.p === null || ind.p === undefined ? '' : Math.round(ind.p * 100) + '% seen';
      t.b.classList.toggle('spotted', ind.p > 0.5);
      t.b.classList.toggle('elite', !!ind.elite);
      t.b.setAttribute('aria-label', `Specimen ${ind.id}, ${ind.p === null ? 'not yet tested' : Math.round(ind.p * 100) + ' percent detection'}`);
    });
  }

  // ------------------------------------------------------------------
  // Inspector sheet
  // ------------------------------------------------------------------
  function openSheet(ind) {
    S.sheetInd = ind;
    $('sheet').hidden = false;
    refreshSheet();
    $('sheetClose').focus();
  }
  function closeSheet() { $('sheet').hidden = true; S.sheetInd = null; }
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

  function refreshSheet() {
    const ind = S.sheetInd;
    if (!ind) return;
    const sp = C.SPECIES[S.species];
    $('sheetLatin').textContent = sp.latin;
    $('sheetTitle').textContent = 'Specimen No. ' + pad4(ind.id);
    const spot = tileSpot(ind.id, 64);
    const sprite = ind.sprite || C.renderSprite(ind.g, S.species);
    floatToCanvas(cropWith(S.hab, spot.x, spot.y, 64, sprite, 16, 16, 0), 64, 64, $('sheetBig'), 'pixel');
    const rank = S.evo.pop.indexOf(ind);
    const seen = ind.p > 0.5;
    const parents = ind.parents ? ind.parents.map((p) => 'No. ' + pad4(p)).join(ind.parents.length > 1 ? ' × ' : '') : 'none (random)';
    $('sheetStats').innerHTML = [
      ['Born', 'Generation ' + ind.gen],
      ['Parents', ind.elite ? parents + ' (elite copy)' : parents],
      ['Detection', ind.p === null ? 'untested' : pct(ind.p, 1)],
      ['Fitness', ind.p === null ? '–' : ind.fitness.toFixed(3)],
      ['Status', ind.p === null ? '–' : `<span style="color:${seen ? COL.coral : COL.sage}">${seen ? 'Spotted' : 'Hidden'}</span>`],
      ['Rank', rank < 0 ? 'not in current population' : `${rank + 1} of ${S.evo.pop.length}`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    // gene grid
    const g = ctx2d($('sheetGenes'));
    const cell = 160 / C.G;
    for (let y = 0; y < C.G; y++) {
      for (let x = 0; x < C.G; x++) {
        const i = (y * C.G + x) * 3;
        g.fillStyle = `rgb(${ind.g[i] * 255 | 0},${ind.g[i + 1] * 255 | 0},${ind.g[i + 2] * 255 | 0})`;
        g.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }

  // ------------------------------------------------------------------
  // Charts
  // ------------------------------------------------------------------
  // Size a chart canvas to its on-screen width so text stays crisp and readable.
  function prepCanvas(c, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.max(240, Math.round(c.clientWidth || c.parentElement.clientWidth || 320));
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) { c.width = cssW * dpr; c.height = cssH * dpr; }
    c.style.height = cssH + 'px';
    const cx = ctx2d(c);
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx.clearRect(0, 0, cssW, cssH);
    return { cx, cw: cssW, ch: cssH };
  }

  function drawRace() {
    const c = $('raceChart');
    const { cx, cw, ch } = prepCanvas(c, 210);
    const L = 40, R = 12, T = 14, B = 28;
    const w = cw - L - R, h = ch - T - B;
    const pts = S.history;
    const maxX = Math.max(10, S.xCounter);
    const X = (x) => L + (x / maxX) * w;
    const Y = (v) => T + (1 - v) * h;
    cx.font = MONO;
    // grid
    cx.strokeStyle = COL.line; cx.lineWidth = 1; cx.fillStyle = COL.muted; cx.textAlign = 'right';
    [0, 0.5, 1].forEach((v) => {
      cx.beginPath(); cx.moveTo(L, Y(v)); cx.lineTo(L + w, Y(v)); cx.stroke();
      cx.fillText(Math.round(v * 100) + '%', L - 8, Y(v) + 4);
    });
    // fooled threshold
    cx.setLineDash([4, 4]); cx.strokeStyle = COL.coral;
    cx.beginPath(); cx.moveTo(L, Y(FOOLED)); cx.lineTo(L + w, Y(FOOLED)); cx.stroke();
    cx.setLineDash([]);
    cx.textAlign = 'left'; cx.fillStyle = COL.coral;
    cx.fillText('fooled', L + 4, Y(FOOLED) - 5);
    // x labels
    cx.fillStyle = COL.muted; cx.textAlign = 'center';
    const step = maxX > 120 ? 40 : maxX > 50 ? 20 : maxX > 20 ? 10 : 5;
    for (let x = 0; x <= maxX; x += step) if (X(x) < L + w - 70) cx.fillText(String(x), X(x), ch - 8);
    cx.textAlign = 'right';
    cx.fillText('generation', L + w, ch - 8);
    // hardening markers
    S.hardenMarks.forEach((m) => {
      cx.strokeStyle = COL.amber; cx.lineWidth = 2;
      cx.beginPath(); cx.moveTo(X(m.x), T); cx.lineTo(X(m.x), T + h); cx.stroke();
      cx.fillStyle = COL.amber; cx.textAlign = 'left';
      cx.fillText('R' + (m.round + 1), X(m.x) + 4, T + 10);
    });
    if (pts.length < 1) {
      cx.fillStyle = COL.muted; cx.textAlign = 'center';
      cx.fillText('Waiting for the predator to finish training', L + w / 2, T + h / 2);
      return;
    }
    // mean suspicion (dotted)
    cx.setLineDash([2, 4]); cx.strokeStyle = COL.muted; cx.lineWidth = 1.5;
    cx.beginPath();
    pts.forEach((p, i) => (i ? cx.lineTo(X(p.x), Y(p.meanP)) : cx.moveTo(X(p.x), Y(p.meanP))));
    cx.stroke(); cx.setLineDash([]);
    // detection area + line
    const grad = cx.createLinearGradient(0, T, 0, T + h);
    grad.addColorStop(0, 'rgba(235,227,207,0.18)');
    grad.addColorStop(1, 'rgba(235,227,207,0)');
    cx.beginPath();
    cx.moveTo(X(pts[0].x), Y(0));
    pts.forEach((p) => cx.lineTo(X(p.x), Y(p.det)));
    cx.lineTo(X(pts[pts.length - 1].x), Y(0));
    cx.closePath(); cx.fillStyle = grad; cx.fill();
    cx.beginPath();
    pts.forEach((p, i) => (i ? cx.lineTo(X(p.x), Y(p.det)) : cx.moveTo(X(p.x), Y(p.det))));
    cx.strokeStyle = COL.bone; cx.lineWidth = 2; cx.lineJoin = 'round'; cx.stroke();
    const last = pts[pts.length - 1];
    cx.beginPath(); cx.arc(X(last.x), Y(last.det), 4, 0, Math.PI * 2);
    cx.fillStyle = last.det <= FOOLED ? COL.coral : COL.bone; cx.fill();
  }

  function drawLoss() {
    const c = $('lossChart');
    const { cx, cw, ch } = prepCanvas(c, 96);
    const L = 40, R = 10, T = 10, B = 22;
    const w = cw - L - R, h = ch - T - B;
    const n = S.lossHist.length;
    cx.font = MONO; cx.fillStyle = COL.muted; cx.textAlign = 'right';
    cx.fillText('loss', L - 8, T + 8);
    cx.strokeStyle = COL.line; cx.beginPath(); cx.moveTo(L, T + h); cx.lineTo(L + w, T + h); cx.stroke();
    if (n < 2) return;
    // smoothed
    const sm = []; let e = S.lossHist[0];
    for (const v of S.lossHist) { e = e * 0.9 + v * 0.1; sm.push(e); }
    const maxV = Math.max(0.75, ...sm);
    const X = (i) => L + (i / Math.max(n - 1, 1)) * w;
    const Y = (v) => T + (1 - Math.min(v, maxV) / maxV) * h;
    S.lossMarks.forEach((m) => {
      if (m.at === 0) return;
      cx.strokeStyle = COL.amber; cx.beginPath(); cx.moveTo(X(m.at), T); cx.lineTo(X(m.at), T + h); cx.stroke();
    });
    cx.beginPath();
    sm.forEach((v, i) => (i ? cx.lineTo(X(i), Y(v)) : cx.moveTo(X(i), Y(v))));
    cx.strokeStyle = COL.sage; cx.lineWidth = 1.5; cx.stroke();
    cx.fillStyle = COL.muted; cx.textAlign = 'left';
    cx.fillText(sm[sm.length - 1].toFixed(3), L + 4, ch - 6);
    cx.textAlign = 'right';
    cx.fillText(n + ' training steps', L + w, ch - 6);
  }

  // First-layer weights shown as little images (opponent channels mapped back to RGB).
  function drawMind() {
    const c = $('mindCanvas');
    const cx = ctx2d(c);
    cx.clearRect(0, 0, c.width, c.height);
    if (!S.net) return;
    const Wt = S.net.W[0], nin = S.net.sizes[0], nh = S.net.sizes[1];
    const norms = [];
    for (let j = 0; j < nh; j++) {
      let s = 0;
      for (let i = 0; i < nin; i++) s += Wt[j * nin + i] * Wt[j * nin + i];
      norms.push([s, j]);
    }
    norms.sort((a, b) => b[0] - a[0]);
    const pick = norms.slice(0, 24).map((n) => n[1]);
    const tile = 16, cols = 6, sz = 64, gap = 0;
    const tmp = document.createElement('canvas');
    tmp.width = tile; tmp.height = tile;
    const t = ctx2d(tmp);
    cx.imageSmoothingEnabled = false;
    pick.forEach((j, k) => {
      let m = 1e-6;
      for (let i = 0; i < nin; i++) m = Math.max(m, Math.abs(Wt[j * nin + i]));
      const id = t.createImageData(tile, tile);
      for (let p = 0; p < tile * tile; p++) {
        const Lw = Wt[j * nin + p * 3] / m, A = Wt[j * nin + p * 3 + 1] / m, Bw = Wt[j * nin + p * 3 + 2] / m;
        const r = Lw + A * 0.5 - Bw * 0.25, g = Lw - A * 0.5 - Bw * 0.25, b = Lw + Bw * 0.5;
        id.data[p * 4] = Math.max(0, Math.min(255, 128 + r * 127));
        id.data[p * 4 + 1] = Math.max(0, Math.min(255, 128 + g * 127));
        id.data[p * 4 + 2] = Math.max(0, Math.min(255, 128 + b * 127));
        id.data[p * 4 + 3] = 255;
      }
      t.putImageData(id, 0, 0);
      const x = (k % cols) * (sz + gap), y = Math.floor(k / cols) * (sz + gap);
      cx.drawImage(tmp, x, y, sz, sz);
    });
    cx.strokeStyle = COL.ink; cx.lineWidth = 2;
    for (let i = 1; i < cols; i++) { cx.beginPath(); cx.moveTo(i * sz, 0); cx.lineTo(i * sz, c.height); cx.stroke(); }
    for (let i = 1; i < 4; i++) { cx.beginPath(); cx.moveTo(0, i * sz); cx.lineTo(c.width, i * sz); cx.stroke(); }
  }

  // ------------------------------------------------------------------
  // Veil (progress over the lab canvas)
  // ------------------------------------------------------------------
  function showVeil(title, sub) {
    $('veilTitle').textContent = title;
    $('veilSub').textContent = sub;
    $('veilBar').style.width = '0';
    $('labVeil').hidden = false;
  }
  function setVeil(f) { $('veilBar').style.width = Math.round(f * 100) + '%'; S.veilFrac = f; }
  function hideVeil() { $('labVeil').hidden = true; S.veilFrac = null; }

  // ------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------
  function syncButtons() {
    const busy = !!S.job || !S.naive;
    const evolve = $('btnEvolve');
    evolve.disabled = busy || !!S.auto;
    evolve.textContent = S.running && !S.auto ? 'Pause evolution' : 'Evolve prey';
    evolve.classList.toggle('running', S.running && !S.auto);
    $('btnStep').disabled = busy || S.running;
    $('btnHarden').disabled = busy || S.running || !!S.auto;
    const auto = $('btnAuto');
    auto.disabled = busy && !S.auto;
    auto.textContent = S.auto ? `Stop arms race (${AUTO_ROUNDS - S.auto.left + 1}/${AUTO_ROUNDS})` : `Run ${AUTO_ROUNDS}-round arms race`;
    $('btnRobust').disabled = !S.naive || !!S.job || S.running;
  }

  $('btnEvolve').addEventListener('click', () => {
    S.running = !S.running;
    if (S.running) setPhase('evolving'); else setPhase(S.fooled ? 'fooled' : 'ready', S.fooled ? 'AI fooled' : 'Paused');
  });
  $('btnStep').addEventListener('click', () => { doGeneration(); syncButtons(); });
  $('btnHarden').addEventListener('click', () => harden());
  $('btnAuto').addEventListener('click', () => {
    if (S.auto) { S.auto = null; S.running = false; setPhase('ready', 'Stopped'); return; }
    S.auto = { left: AUTO_ROUNDS };
    // if this round is already fooled, harden first
    if (S.fooled) autoHarden();
    else { S.running = true; setPhase('evolving'); }
    syncButtons();
  });
  $('btnReset').addEventListener('click', () => startExperiment());
  $('speed').addEventListener('input', (e) => {
    S.speed = +e.target.value;
    $('speedOut').textContent = S.speed + ' gen/s';
  });
  $('toggleVision').addEventListener('change', (e) => { S.vision = e.target.checked; S.grid = null; drawLab(); });
  $('toggleReveal').addEventListener('change', (e) => { S.reveal = e.target.checked; drawLab(); });

  function buildSegs() {
    const hs = $('habitatSeg');
    hs.innerHTML = '';
    Object.keys(C.HABITATS).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = k === S.habitat ? 'on' : '';
      b.title = C.HABITATS[k].blurb;
      const c = document.createElement('canvas');
      c.width = 20; c.height = 20;
      const sw = SWATCH[k];
      if (sw) floatToCanvas(sw, 20, 20, c);
      b.append(c, document.createTextNode(C.HABITATS[k].short));
      b.addEventListener('click', () => {
        if (S.habitat === k) return;
        S.habitat = k; buildSegs(); startExperiment();
        toast(`<b>New experiment:</b> ${C.HABITATS[k].name}. ${C.HABITATS[k].blurb}`);
      });
      hs.appendChild(b);
    });
    const ss = $('speciesSeg');
    ss.innerHTML = '';
    Object.keys(C.SPECIES).forEach((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = k === S.species ? 'on' : '';
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const g = new Float32Array(C.GENOME_LEN).fill(0.86);
      const sp = C.renderSprite(g, k);
      const buf = new Float32Array(32 * 32 * 3).fill(0.14);
      C.stamp(buf, 32, 32, sp, 0, 0, 0);
      floatToCanvas(buf, 32, 32, c);
      b.append(c, document.createTextNode(C.SPECIES[k].name));
      b.addEventListener('click', () => {
        if (S.species === k) return;
        S.species = k; buildSegs(); startExperiment();
        toast(`<b>New experiment:</b> evolving ${C.SPECIES[k].name.toLowerCase()} camouflage.`);
      });
      ss.appendChild(b);
    });
  }

  // small habitat swatches for the toolbar
  const SWATCH = {};
  Object.keys(C.HABITATS).forEach((k) => {
    const h = C.paintHabitat(k, 60, 60, 77);
    SWATCH[k] = cropWith(h, 20, 20, 20, null);
  });

  // ------------------------------------------------------------------
  // Hero (brief view): the lab scene with a sweeping scan
  // ------------------------------------------------------------------
  function heroTick(t) {
    const c = $('heroCanvas');
    const cx = ctx2d(c);
    cx.drawImage(S.sceneCanvas, 0, 0);
    if (!S.naive) {
      cx.fillStyle = 'rgba(10,14,12,0.45)'; cx.fillRect(0, 0, W, H);
      const f = S.veilFrac || 0;
      cx.fillStyle = COL.amber; cx.fillRect(0, H - 4, W * f, 4);
      $('heroCaption').textContent = `Training the predator on random creatures… ${Math.round(f * 100)}%`;
      return;
    }
    const period = 3600;
    const y = ((t % period) / period) * (H + 60) - 30;
    let caught = 0;
    S.placed.forEach((cr, i) => {
      const p = S.spotP[i];
      if (p > 0.5) caught++;
      if (p > 0.5 && cr.y + C.S / 2 < y) brackets(cx, cr.x - 3, cr.y - 3, C.S + 6, COL.amber, Math.round(p * 100) + '%');
    });
    drawScanline(cx, y);
    const txt = `The predator scans the bark. Amber boxes are creatures it caught: ${caught} of ${SHOWN} at round ${S.round}, generation ${S.evo.generation}.`;
    if ($('heroCaption').textContent !== txt) $('heroCaption').textContent = txt;
  }

  function drawMothSwatches() {
    const box = $('mothSwatches');
    const habs = { birch: C.paintHabitat('birch', 160, 80, 1240), soot: C.paintHabitat('soot', 160, 80, 1240) };
    const pale = new Float32Array(C.GENOME_LEN), dark = new Float32Array(C.GENOME_LEN);
    for (let i = 0; i < C.G * C.G; i++) {
      const speck = (i * 37) % 7 === 0 ? 0.35 : 1; // "peppered" dark flecks
      pale[i * 3] = 0.84 * speck; pale[i * 3 + 1] = 0.82 * speck; pale[i * 3 + 2] = 0.76 * speck;
      dark[i * 3] = 0.18; dark[i * 3 + 1] = 0.17; dark[i * 3 + 2] = 0.16;
    }
    const sp = { pale: C.renderSprite(pale, 'moth'), dark: C.renderSprite(dark, 'moth') };
    const cases = [
      ['birch', 'pale', 'Pale moth on lichen bark', true],
      ['birch', 'dark', 'Dark moth on lichen bark', false],
      ['soot', 'pale', 'Pale moth on soot bark', false],
      ['soot', 'dark', 'Dark moth on soot bark', true],
    ];
    box.innerHTML = '';
    cases.forEach(([h, m, label, hidden]) => {
      const d = document.createElement('div');
      d.className = 'mswatch';
      const c = document.createElement('canvas');
      c.width = 320; c.height = 160;
      const buf = cropWith(habs[h], 40, 20, 80, sp[m], 24, 4, 0);
      const crop = new Float32Array(80 * 40 * 3);
      crop.set(buf.subarray(0, 80 * 40 * 3));
      floatToCanvas(crop, 80, 40, c, 'smooth');
      const s = document.createElement('span');
      s.innerHTML = `${label} · <b class="${hidden ? 'hid' : 'vis'}">${hidden ? 'hidden' : 'exposed'}</b>`;
      d.append(c, s);
      box.appendChild(d);
    });
  }

  // ------------------------------------------------------------------
  // Hunt: human vs AI
  // ------------------------------------------------------------------
  const HUNT_N = 8, HUNT_MS = 30000;
  const Hn = { phase: 'ready' };

  function resetHunt() {
    Object.assign(Hn, { phase: 'ready', placed: null, img: null, found: [], misses: [], grid: null, row: 0, ai: null });
    $('huntVeil').hidden = false;
    $('huntVeilTitle').textContent = 'Ready when you are';
    updateHuntSource();
    $('btnHunt').textContent = 'Start the hunt';
    $('huntResult').hidden = true;
    $('huntYou').textContent = '0';
    $('huntAI').textContent = '–';
    $('huntTime').textContent = '30';
    $('timerRing').style.strokeDashoffset = '0';
    drawHunt();
  }

  S.huntSource = 'fooled';
  function huntSet() {
    if (S.huntSource === 'fooled' && S.lastFooled) {
      const f = S.lastFooled;
      return { inds: f.inds, net: f.net, label: `Round ${f.round} prey that fooled the AI, against that same AI` };
    }
    return { inds: S.evo.pop.slice(0, HUNT_N), net: S.net, label: `Current prey against the current AI (round ${S.round})` };
  }
  function updateHuntSource() {
    const seg = $('huntSeg');
    if (!seg) return;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.src === S.huntSource));
    const fb = seg.querySelector('[data-src=fooled]');
    fb.disabled = !S.lastFooled;
    fb.title = S.lastFooled ? '' : 'Evolve the prey in the lab until the AI is fooled first';
    if (Hn.phase === 'ready') $('huntVeilSub').textContent = (S.naive ? huntSet().label + '. ' : '') + 'Click or tap each creature you find. Wrong clicks cost nothing.';
  }
  document.querySelectorAll('#huntSeg button').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    S.huntSource = b.dataset.src;
    updateHuntSource();
  }));

  function startHunt() {
    if (!S.naive) { toast('The predator is still training. Give it a few seconds.'); return; }
    const set = huntSet();
    Hn.net = set.net;
    const pick = set.inds;
    const spots = C.placeCreatures(S.hab, HUNT_N, 10);
    Hn.placed = spots.map((sp, i) => ({ ...sp, sprite: pick[i].sprite, ind: pick[i] }));
    Hn.img = C.composeScene(S.hab, Hn.placed);
    Hn.canvas = Hn.canvas || document.createElement('canvas');
    Hn.canvas.width = W; Hn.canvas.height = H;
    floatToCanvas(Hn.img, W, H, Hn.canvas);
    Hn.found = []; Hn.misses = []; Hn.grid = null; Hn.row = 0; Hn.ai = null;
    Hn.phase = 'human';
    Hn.t0 = performance.now();
    Hn.meta = { label: set.label };
    $('huntVeil').hidden = true;
    $('huntResult').hidden = true;
    $('huntYou').textContent = '0';
    $('huntAI').textContent = '–';
    drawHunt();
  }
  $('btnHunt').addEventListener('click', startHunt);

  $('huntCanvas').addEventListener('click', (e) => {
    if (Hn.phase !== 'human') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    let hit = -1, best = 26;
    Hn.placed.forEach((c, i) => {
      if (Hn.found.includes(i)) return;
      const d = Math.hypot(c.x + C.S / 2 - x, c.y + C.S / 2 - y);
      if (d < best) { best = d; hit = i; }
    });
    if (hit >= 0) {
      Hn.found.push(hit);
      $('huntYou').textContent = Hn.found.length;
      if (Hn.found.length === HUNT_N) endHuman();
    } else {
      Hn.misses.push({ x, y, t: performance.now() });
    }
  });

  function endHuman() {
    Hn.phase = 'ai';
    Hn.grid = C.scanScene(Hn.net, Hn.img, W, H, SCAN_STRIDE, 0, 0);
    Hn.row = 0;
    $('huntTime').textContent = '0';
  }

  function huntTick(t) {
    if (Hn.phase === 'human') {
      const left = Math.max(0, HUNT_MS - (t - Hn.t0));
      $('huntTime').textContent = Math.ceil(left / 1000);
      $('timerRing').style.strokeDashoffset = String(119.4 * (1 - left / HUNT_MS));
      if (left <= 0) endHuman();
    } else if (Hn.phase === 'ai') {
      const t0 = performance.now();
      while (performance.now() - t0 < 10 && Hn.row < Hn.grid.rows) {
        C.scanScene(Hn.net, Hn.img, W, H, SCAN_STRIDE, Hn.row, Hn.row + 1, Hn.grid);
        Hn.row++;
      }
      if (Hn.row >= Hn.grid.rows) finishHunt();
    }
    drawHunt(t);
  }

  function finishHunt() {
    Hn.phase = 'done';
    const scores = Hn.placed.map((c) => C.creatureScore(Hn.grid, c.x + C.S / 2, c.y + C.S / 2));
    Hn.ai = scores.map((s) => s > 0.5);
    Hn.scores = scores;
    // false alarms: strong responses far from any creature (clustered)
    const alarms = [];
    for (let r = 0; r < Hn.grid.rows; r++) {
      for (let c = 0; c < Hn.grid.cols; c++) {
        if (Hn.grid.p[r * Hn.grid.cols + c] <= 0.5) continue;
        const x = c * SCAN_STRIDE + C.WIN / 2, y = r * SCAN_STRIDE + C.WIN / 2;
        if (Hn.placed.some((cr) => Math.hypot(cr.x + C.S / 2 - x, cr.y + C.S / 2 - y) < 26)) continue;
        if (alarms.some((a) => Math.hypot(a.x - x, a.y - y) < 30)) continue;
        alarms.push({ x, y });
      }
    }
    Hn.alarms = alarms;
    const you = Hn.found.length, ai = Hn.ai.filter(Boolean).length;
    $('huntAI').textContent = ai;
    let both = 0, onlyYou = 0, onlyAI = 0, neither = 0;
    Hn.placed.forEach((c, i) => {
      const h = Hn.found.includes(i), a = Hn.ai[i];
      if (h && a) both++; else if (h) onlyYou++; else if (a) onlyAI++; else neither++;
    });
    const rec = { you, ai, both, onlyYou, onlyAI, neither, alarms: alarms.length, ...Hn.meta };
    S.hunts.push(rec);
    renderHuntResult(rec);
    $('huntVeil').hidden = true;
  }

  function renderHuntResult(r) {
    const box = $('huntResult');
    let title, body;
    if (r.you > r.ai) title = `You beat the AI, ${r.you} to ${r.ai}.`;
    else if (r.ai > r.you) title = `The AI wins, ${r.ai} to ${r.you}.`;
    else title = `A draw: ${r.you} each.`;
    const lines = [];
    if (r.onlyYou) lines.push(`<b>${r.onlyYou}</b> creature${r.onlyYou > 1 ? 's' : ''} fooled the AI but not you. That is an adversarial blind spot: a pattern the network misses even though a person can see it.`);
    if (r.onlyAI) lines.push(`<b>${r.onlyAI}</b> slipped past you but not the AI. The network picks up colour differences that human eyes ignore.`);
    if (r.neither) lines.push(`<b>${r.neither}</b> fooled both of you. That is real camouflage.`);
    if (r.alarms) lines.push(`The AI also raised <b>${r.alarms}</b> false alarm${r.alarms > 1 ? 's' : ''} on empty habitat.`);
    body = lines.join(' ');
    const tiles = Hn.placed.map((c, i) => {
      const h = Hn.found.includes(i), a = Hn.ai[i];
      const [k, label] = h && a ? ['k-both', 'Both found'] : h ? ['k-you', 'Only you'] : a ? ['k-ai', 'Only the AI'] : ['k-none', 'Nobody'];
      return { c, k, label, i };
    });
    box.innerHTML = `
      <div class="panel verdict"><p class="eyebrow">Result · ${r.label}</p><h3>${title}</h3><p>${body}</p>
      <button class="btn primary" id="btnHuntAgain">Hunt again</button></div>
      <div class="panel"><div class="panel-head"><h3>Each creature</h3><p class="panel-sub">Who spotted it. The AI's score is its confidence at that spot.</p></div><div class="outcomes" id="outcomes"></div></div>`;
    const oc = box.querySelector('#outcomes');
    tiles.forEach((t) => {
      const d = document.createElement('div');
      d.className = 'outcome';
      const cv = document.createElement('canvas');
      cv.width = 96; cv.height = 96;
      const buf = cropWith(S.hab, t.c.x - 8, t.c.y - 8, 48, t.c.sprite, 8, 8, t.c.rot);
      floatToCanvas(buf, 48, 48, cv, 'smooth');
      const s = document.createElement('span');
      s.innerHTML = `<b class="${t.k}">${t.label}</b> · AI ${Math.round(Hn.scores[t.i] * 100)}%`;
      d.append(cv, s);
      oc.appendChild(d);
    });
    box.hidden = false;
    box.querySelector('#btnHuntAgain').addEventListener('click', startHunt);
  }

  function drawHunt(t) {
    const c = $('huntCanvas'), o = $('huntOverlay');
    if (!c || !S.hab) return;
    const cx = ctx2d(c), ox = ctx2d(o);
    if (Hn.phase === 'ready' || !Hn.canvas) {
      floatToCanvas(S.hab.rgb, W, H, c);
      ox.clearRect(0, 0, W, H);
      return;
    }
    cx.drawImage(Hn.canvas, 0, 0);
    ox.clearRect(0, 0, W, H);
    if (Hn.phase === 'ai' || Hn.phase === 'done') {
      ox.fillStyle = 'rgba(10,14,12,0.35)'; ox.fillRect(0, 0, W, H);
      drawHeat(ox, Hn.grid, 0.8);
      if (Hn.phase === 'ai') drawScanline(ox, Math.min(H - 2, Hn.row * SCAN_STRIDE + C.WIN / 2));
    }
    // human finds
    Hn.found.forEach((i) => {
      const cr = Hn.placed[i];
      ox.strokeStyle = COL.sage; ox.lineWidth = 2.5;
      ox.beginPath(); ox.arc(cr.x + C.S / 2, cr.y + C.S / 2, 22, 0, Math.PI * 2); ox.stroke();
    });
    const now = t || performance.now();
    Hn.misses = Hn.misses.filter((m) => now - m.t < 700);
    Hn.misses.forEach((m) => {
      const a = 1 - (now - m.t) / 700;
      ox.strokeStyle = `rgba(143,155,146,${a})`; ox.lineWidth = 2;
      ox.beginPath(); ox.moveTo(m.x - 6, m.y - 6); ox.lineTo(m.x + 6, m.y + 6); ox.moveTo(m.x + 6, m.y - 6); ox.lineTo(m.x - 6, m.y + 6); ox.stroke();
    });
    if (Hn.phase === 'done') {
      Hn.placed.forEach((cr, i) => {
        if (Hn.ai[i]) brackets(ox, cr.x - 5, cr.y - 5, C.S + 10, COL.amber, 'AI ' + Math.round(Hn.scores[i] * 100) + '%');
        else if (!Hn.found.includes(i)) {
          ox.setLineDash([3, 3]); ox.strokeStyle = COL.coral; ox.lineWidth = 2;
          ox.beginPath(); ox.arc(cr.x + C.S / 2, cr.y + C.S / 2, 22, 0, Math.PI * 2); ox.stroke(); ox.setLineDash([]);
        }
      });
      (Hn.alarms || []).forEach((a) => {
        ox.strokeStyle = 'rgba(239,164,60,0.6)'; ox.lineWidth = 1.5; ox.setLineDash([2, 3]);
        ox.strokeRect(a.x - 16, a.y - 16, 32, 32); ox.setLineDash([]);
      });
    }
  }

  // ------------------------------------------------------------------
  // Robustness test (findings)
  // ------------------------------------------------------------------
  function runRobust() {
    if (!S.naive || S.job) return;
    S.running = false;
    const models = [['naive', S.naive], ['hardened', S.net.clone()]];
    const res = { naive: [], hardened: [], hardenRounds: S.rounds.length };
    S.robust = res;
    let mi = 0, attack = 0, evo = null, st = null;
    const MAXG = 60, REPEATS = 3;
    setPhase('testing');
    S.job = {
      label: 'Robustness test',
      tick(budget) {
        const t0 = performance.now();
        while (performance.now() - t0 < budget) {
          const [key, model] = models[mi];
          if (!evo) { evo = new C.Evolution(); st = evo.evaluate(model, S.hab, S.species); }
          if (st.detection <= FOOLED || evo.generation >= MAXG) {
            res[key].push({ gens: evo.generation, fooled: st.detection <= FOOLED });
            evo = null; attack++;
            if (attack >= REPEATS) { attack = 0; mi++; }
            if (mi >= models.length) return true;
            continue;
          }
          evo.nextGeneration();
          st = evo.evaluate(model, S.hab, S.species);
        }
        res.progress = (mi * REPEATS + attack + (evo ? evo.generation / MAXG : 0)) / (models.length * REPEATS);
        if (S.view === 'findings') renderRobust();
        return false;
      },
      onDone() {
        res.progress = 1;
        setPhase(S.fooled ? 'fooled' : 'ready');
        renderFindings();
        toast('<b>Robustness test finished.</b>');
      },
    };
    renderRobust();
    syncButtons();
  }
  $('btnRobust').addEventListener('click', runRobust);

  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

  function renderRobust() {
    const box = $('robust');
    const r = S.robust;
    if (!r) {
      box.innerHTML = '<p class="panel-sub">Not run yet. It takes about half a minute. For a meaningful result, harden the AI at least once in the lab first.</p>';
      return;
    }
    const rows = [['Original AI', r.naive, COL.coral], ['Hardened AI', r.hardened, COL.sage]];
    const all = [...r.naive, ...r.hardened].map((v) => v.gens);
    const max = Math.max(10, ...all);
    box.innerHTML = rows.map(([name, arr, col]) => {
      if (!arr.length) return `<div class="robust-row"><span>${name}</span><div class="bar"><span style="width:0"></span></div><b>…</b></div>`;
      const a = avg(arr.map((v) => v.gens));
      const held = arr.some((v) => !v.fooled);
      return `<div class="robust-row"><span>${name}</span><div class="bar"><span style="width:${(a / max) * 100}%;background:${col}"></span></div><b>${a.toFixed(1)}${held ? '+' : ''}</b></div>`;
    }).join('') +
      `<p class="panel-sub">Average generations a fresh attack needed to cut detection to 10%.${r.progress < 1 ? ` Running… ${Math.round((r.progress || 0) * 100)}%` : ''}${[...r.naive, ...r.hardened].some((v) => !v.fooled) ? ' A “+” means at least one attack gave up at 60 generations.' : ''}</p>`;
  }

  // ------------------------------------------------------------------
  // Findings
  // ------------------------------------------------------------------
  function renderFindings() {
    const claims = [];
    const r1 = S.rounds[0] || null;
    const firstFoolGens = r1 ? r1.fooledAt : S.firstAttack ? S.evo.generation - S.roundStartGen : null;
    // 1 baseline
    claims.push(S.baseline === null
      ? { cls: 'pending', tag: 'Before the attack', num: '––', text: 'The predator is still training.' }
      : { cls: '', tag: 'Before the attack', num: pct(S.baseline), text: `of randomly coloured creatures are caught by the freshly trained network. False alarms on empty habitat: ${pct(S.falseAlarm)}.` });
    // 2 attack
    let attackDet = null;
    if (S.firstAttack) attackDet = C.detectionRate(S.naive, S.hab, S.species, S.firstAttack, 4).rate;
    claims.push(attackDet === null
      ? { cls: 'coral pending', tag: 'The attack', num: '––', text: 'Evolve the prey in the lab until the AI is fooled.' }
      : { cls: 'coral', tag: 'The attack', num: pct(attackDet), small: firstFoolGens !== null ? `in ${firstFoolGens} gen` : '', text: `is all the original network catches of the first population that evolved against it. Evolution found its blind spot without ever looking inside it.` });
    // 3 hardening
    let hardDet = null;
    if (S.firstAttack && S.rounds.length) hardDet = C.detectionRate(S.net, S.hab, S.species, S.firstAttack, 4).rate;
    claims.push(hardDet === null
      ? { cls: 'sage pending', tag: 'The fix', num: '––', text: 'Harden the AI in the lab to see how much of that camouflage it learns to catch.' }
      : { cls: 'sage', tag: 'The fix', num: pct(hardDet), text: `of that same camouflage is caught by the network after ${S.rounds.length} round${S.rounds.length > 1 ? 's' : ''} of adversarial training.` });

    $('claims').innerHTML = claims.map((c) => `
      <div class="claim ${c.cls}"><span class="tag">${c.tag}</span><span class="num">${c.num}${c.small ? `<small>${c.small}</small>` : ''}</span><p>${c.text}</p></div>`).join('');

    // conclusion
    const parts = [];
    if (attackDet !== null) parts.push(`A genetic algorithm that could only see the network's yes/no answers took ${firstFoolGens} generations to evolve creatures the network catches ${pct(attackDet)} of the time, down from ${pct(S.baseline)}.`);
    if (hardDet !== null) parts.push(`Retraining on those creatures raised that to ${pct(hardDet)}.`);
    const fooledRounds = S.rounds.filter((r) => r.fooledAt !== null);
    if (fooledRounds.length >= 2) {
      const a = fooledRounds[0].fooledAt, b = fooledRounds[fooledRounds.length - 1].fooledAt;
      parts.push(`The first blind spot took ${a} generations to find; in round ${fooledRounds[fooledRounds.length - 1].round} it took ${b}.`);
    }
    if (S.robust && S.robust.progress >= 1 && S.robust.naive.length && S.robust.hardened.length) {
      const a = avg(S.robust.naive.map((v) => v.gens)), b = avg(S.robust.hardened.map((v) => v.gens));
      parts.push(`A fresh attack needed ${a.toFixed(1)} generations against the original network and ${b.toFixed(1)} against the hardened one${b > a ? `, ${(b / a).toFixed(1)}× more effort` : ''}.`);
    }
    if (S.hunts.length) {
      const h = S.hunts.reduce((acc, r) => ({ onlyYou: acc.onlyYou + r.onlyYou, onlyAI: acc.onlyAI + r.onlyAI, n: acc.n + HUNT_N }), { onlyYou: 0, onlyAI: 0, n: 0 });
      parts.push(`In ${S.hunts.length} human-vs-AI hunt${S.hunts.length > 1 ? 's' : ''}, ${h.onlyYou} of ${h.n} creatures were seen by the person but missed by the AI, and ${h.onlyAI} the other way round: people and the network do not share blind spots.`);
    }
    $('findingsIntro').innerHTML = parts.length
      ? `<span class="conclusion">${parts.join(' ')}</span>`
      : 'Every number below is measured live in your browser from the lab, the hunt and the robustness test. Start in the lab: evolve the prey, then harden the AI, or run the 4-round arms race.';

    drawGens();
    renderRobust();
    // round log
    const t = $('roundLog');
    const head = '<tr><th>Round</th><th>Detection at start</th><th>Generations to fool</th><th>Detection at end</th><th>After hardening</th></tr>';
    const rows = S.rounds.map((r) => `<tr><td>${r.round}</td><td>${pct(r.startDet)}</td><td>${r.fooledAt === null ? `not fooled in ${r.gens}` : r.fooledAt}</td><td>${pct(r.endDet)}</td><td>${pct(r.afterDet)}</td></tr>`).join('');
    t.innerHTML = head + (rows || '<tr><td colspan="5" class="empty">No completed rounds yet. A round ends each time the AI is hardened.</td></tr>');
    syncButtons();
  }

  function drawGens() {
    const c = $('gensChart');
    const { cx, cw, ch } = prepCanvas(c, 240);
    const L = 40, R = 12, T = 22, B = 30;
    const w = cw - L - R, h = ch - T - B;
    cx.font = MONO;
    const data = S.rounds.map((r) => ({ round: r.round, v: r.fooledAt === null ? r.gens : r.fooledAt, held: r.fooledAt === null }));
    if (!data.length) {
      cx.fillStyle = COL.muted; cx.textAlign = 'center';
      cx.fillText('Bars appear after the first hardening round', cw / 2, ch / 2);
      return;
    }
    const max = Math.max(10, ...data.map((d) => d.v));
    const nice = max <= 10 ? 10 : max <= 20 ? 20 : max <= 30 ? 30 : max <= 50 ? 50 : Math.ceil(max / 20) * 20;
    const Y = (v) => T + (1 - v / nice) * h;
    cx.strokeStyle = COL.line; cx.fillStyle = COL.muted; cx.textAlign = 'right';
    [0, nice / 2, nice].forEach((v) => {
      cx.beginPath(); cx.moveTo(L, Y(v)); cx.lineTo(L + w, Y(v)); cx.stroke();
      cx.fillText(String(v), L - 8, Y(v) + 4);
    });
    const slot = w / data.length, bw = Math.min(56, slot * 0.6);
    data.forEach((d, i) => {
      const x = L + slot * i + (slot - bw) / 2;
      cx.fillStyle = d.held ? 'rgba(158,199,154,0.35)' : COL.sage;
      cx.fillRect(x, Y(d.v), bw, Y(0) - Y(d.v));
      cx.fillStyle = COL.bone; cx.textAlign = 'center';
      cx.fillText(d.held ? d.v + '+' : String(d.v), x + bw / 2, Y(d.v) - 6);
      cx.fillStyle = COL.muted;
      cx.fillText('Round ' + d.round, x + bw / 2, ch - 8);
    });
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  function frame(t) {
    try {
      if (S.job) {
        const done = S.job.tick(14);
        if (done) { const j = S.job; S.job = null; j.onDone && j.onDone(); syncButtons(); }
        updateGlobalStatus();
      } else if (S.running) {
        const rate = S.auto ? Math.max(S.speed, 8) : S.speed;
        if (t - S.lastGenAt >= 1000 / rate) { S.lastGenAt = t; doGeneration(); syncButtons(); }
      }
      if (S.view === 'lab' && S.vision && !S.job) { scanTick(6); drawLabOverlay(); }
      if (S.view === 'brief') heroTick(t);
      if (S.view === 'hunt' && Hn.phase !== 'ready') huntTick(t);
    } catch (err) {
      console.error(err);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (S.view === 'lab') { drawRace(); drawLoss(); }
      if (S.view === 'findings') drawGens();
    }, 120);
  });

  buildSegs();
  drawMothSwatches();
  startExperiment();
  let start = (location.hash || '').replace('#', '');
  showView(VIEWS.includes(start) ? start : 'brief', false);
  syncButtons();
  requestAnimationFrame(frame);
})();
