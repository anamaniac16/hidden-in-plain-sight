/*
 * engine.js
 * Core of the simulation. No DOM code in here, so it also runs in Node
 * (see tools/experiment.js).
 *
 *   Habitat   - procedurally painted backgrounds (bark, soot, leaf litter, sand)
 *   Creature  - sprite rendered from a genome (8x8 grid of RGB colour genes)
 *   Predator  - multilayer perceptron trained with backpropagation + Adam
 *   Evolution - genetic algorithm: tournament selection, 2D crossover,
 *               gaussian mutation, elitism
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------
  // Random numbers (seedable so experiments can be repeated)
  // ------------------------------------------------------------------
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let rand = mulberry32(Date.now() & 0xffffffff);
  function seed(s) { rand = mulberry32(s); }
  function random() { return rand(); }
  function randInt(n) { return Math.floor(rand() * n); }
  function gauss() {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // ------------------------------------------------------------------
  // Value noise + fractal brownian motion for textures
  // ------------------------------------------------------------------
  function makeNoise(seedValue) {
    const r = mulberry32(seedValue);
    const perm = new Uint16Array(512);
    const vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = r(); }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[256 + i] = perm[i];
    const lat = (x, y) => vals[perm[(x & 255) + perm[y & 255]]];
    return function (x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = x - ix, fy = y - iy;
      const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
      const a = lat(ix, iy), b = lat(ix + 1, iy);
      const c = lat(ix, iy + 1), d = lat(ix + 1, iy + 1);
      return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
    };
  }

  function fbm(noise, x, y, octaves) {
    let amp = 0.5, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }

  // ------------------------------------------------------------------
  // Habitats
  // ------------------------------------------------------------------
  const HABITATS = {
    birch: {
      name: 'Lichen birch bark', short: 'Lichen birch',
      blurb: 'Pale bark with dark lenticels and grey-green lichen. Home of the light peppered moth.',
    },
    soot: {
      name: 'Soot-covered bark', short: 'Soot bark',
      blurb: 'Bark blackened by factory smoke, as in 19th-century Manchester.',
    },
    litter: {
      name: 'Forest leaf litter', short: 'Leaf litter',
      blurb: 'Fallen leaves in browns, ochres and rust. Busy, high-contrast, hard to read.',
    },
    sand: {
      name: 'Thar desert sand', short: 'Desert sand',
      blurb: 'Wind ripples and scattered pebbles on warm sand.',
    },
  };

  function paintHabitat(type, W, H, seedValue) {
    const rgb = new Float32Array(W * H * 3);
    const n1 = makeNoise(seedValue + 1);
    const n2 = makeNoise(seedValue + 2);
    const n3 = makeNoise(seedValue + 3);
    const r = mulberry32(seedValue + 99);

    const set = (i, R, G, B) => { rgb[i] = R; rgb[i + 1] = G; rgb[i + 2] = B; };

    if (type === 'birch' || type === 'soot') {
      const soot = type === 'soot';
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const grain = fbm(n3, x / 3, y / 3, 2) - 0.5;
          let R, G, B;
          if (!soot) {
            const tone = 0.80 + 0.10 * (fbm(n1, x / 90, y / 60, 3) - 0.5) + grain * 0.10;
            R = tone + 0.02; G = tone; B = tone - 0.05;
            // lichen patches
            const lich = fbm(n2, x / 22, y / 22, 4);
            if (lich > 0.56) {
              const k = Math.min(1, (lich - 0.56) * 7);
              const lt = 0.62 + 0.15 * (fbm(n3, x / 5, y / 5, 2) - 0.5);
              R = R * (1 - k) + (lt - 0.02) * k;
              G = G * (1 - k) + (lt + 0.05) * k;
              B = B * (1 - k) + (lt - 0.08) * k;
            }
            // horizontal lenticels
            const len = fbm(n1, x / 26 + 40, y / 2.2, 3);
            if (len > 0.66) {
              const k = Math.min(1, (len - 0.66) * 9);
              R = R * (1 - k) + 0.18 * k; G = G * (1 - k) + 0.16 * k; B = B * (1 - k) + 0.15 * k;
            }
          } else {
            const tone = 0.20 + 0.08 * (fbm(n1, x / 70, y / 50, 3) - 0.5) + grain * 0.08;
            R = tone + 0.01; G = tone; B = tone - 0.01;
            const streak = fbm(n2, x / 30, y / 3, 3);
            if (streak > 0.62) {
              const k = Math.min(1, (streak - 0.62) * 6) * 0.5;
              R += 0.09 * k; G += 0.085 * k; B += 0.08 * k;
            }
            const fleck = fbm(n3, x / 8 + 100, y / 8, 3);
            if (fleck > 0.70) { const k = (fleck - 0.7) * 3; R += k * 0.15; G += k * 0.16; B += k * 0.13; }
          }
          set(i, clamp01(R), clamp01(G), clamp01(B));
        }
      }
    } else if (type === 'litter') {
      // soil underneath
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const t = 0.16 + 0.08 * fbm(n1, x / 12, y / 12, 3);
          set(i, t + 0.05, t + 0.02, t - 0.02);
        }
      }
      const palette = [
        [0.55, 0.33, 0.14], [0.70, 0.45, 0.18], [0.45, 0.26, 0.12], [0.76, 0.58, 0.30],
        [0.60, 0.22, 0.10], [0.38, 0.30, 0.16], [0.82, 0.66, 0.42], [0.50, 0.40, 0.22],
      ];
      const leaves = Math.round((W * H) / 380);
      for (let L = 0; L < leaves; L++) {
        const cx = r() * W, cy = r() * H;
        const len = 16 + r() * 26, wid = len * (0.28 + r() * 0.22);
        const ang = r() * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const base = palette[Math.floor(r() * palette.length)];
        const shade = 0.85 + r() * 0.3;
        const ext = len + 2;
        const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(W - 1, Math.ceil(cx + ext));
        const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(H - 1, Math.ceil(cy + ext));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const dx = x - cx, dy = y - cy;
            const u = (dx * ca + dy * sa) / len;      // along leaf, -1..1
            const v = (-dx * sa + dy * ca) / wid;     // across leaf
            if (u < -1 || u > 1) continue;
            const half = Math.pow(1 - u * u, 0.75);
            if (Math.abs(v) > half) continue;
            const i = (y * W + x) * 3;
            const edge = 1 - Math.abs(v) / half;
            const vein = Math.abs(v) < 0.06 ? 0.72 : 1;
            const tex = 0.9 + 0.2 * fbm(n2, x / 4 + L, y / 4, 2);
            const k = shade * tex * vein * (0.82 + 0.18 * Math.min(1, edge * 3));
            set(i, clamp01(base[0] * k), clamp01(base[1] * k), clamp01(base[2] * k));
          }
        }
      }
    } else {
      // sand
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 3;
          const warp = fbm(n1, x / 60, y / 60, 3) * 9;
          const ripple = Math.sin(y * 0.42 + x * 0.05 + warp) * 0.5 + 0.5;
          const grain = fbm(n3, x / 1.6, y / 1.6, 2) - 0.5;
          const big = fbm(n2, x / 120, y / 90, 3) - 0.5;
          const k = 0.92 + ripple * 0.10 + grain * 0.12 + big * 0.12;
          set(i, clamp01(0.84 * k), clamp01(0.67 * k), clamp01(0.45 * k));
        }
      }
      const pebbles = Math.round((W * H) / 900);
      for (let p = 0; p < pebbles; p++) {
        const cx = r() * W, cy = r() * H, rad = 1 + r() * 3.5;
        const tone = 0.35 + r() * 0.5;
        const tint = [tone * 1.05, tone * 0.95, tone * 0.85];
        for (let y = Math.floor(cy - rad); y <= cy + rad; y++) {
          for (let x = Math.floor(cx - rad); x <= cx + rad; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const d = Math.hypot(x - cx, y - cy) / rad;
            if (d > 1) continue;
            const i = (y * W + x) * 3;
            const lit = 1.1 - 0.3 * ((x - cx + y - cy) / rad + 1) * 0.5;
            set(i, clamp01(tint[0] * lit), clamp01(tint[1] * lit), clamp01(tint[2] * lit));
          }
        }
      }
    }
    return { type, W, H, rgb, name: HABITATS[type].name };
  }

  // ------------------------------------------------------------------
  // Creatures
  // ------------------------------------------------------------------
  const S = 32;          // sprite size in pixels
  const G = 8;           // genome is a G x G grid of colours
  const GENOME_LEN = G * G * 3;

  const SPECIES = {
    moth: { name: 'Moth', latin: 'Biston evolvens' },
    beetle: { name: 'Beetle', latin: 'Coleoptera algorithmica' },
    leaf: { name: 'Leaf insect', latin: 'Phyllium neuralis' },
  };

  function inEllipse(x, y, cx, cy, rx, ry, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = x - cx, dy = y - cy;
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
    return u * u + v * v;
  }
  function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - ax - t * vx, py - ay - t * vy);
  }

  // Returns {alpha, shade}: shape mask + a fixed shading map (veins, body).
  function buildBody(species) {
    const alpha = new Float32Array(S * S);
    const shade = new Float32Array(S * S).fill(1);
    const SS = 4; // supersampling for smooth edges
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let hit = 0;
        let sh = 1;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
            const mx = Math.abs(px - 16); // mirror symmetry
            let inside = false;
            if (species === 'moth') {
              const body = inEllipse(mx, py, 0, 16.5, 2.0, 8.5, 0) <= 1;
              const fore = inEllipse(mx, py, 7.5, 13.2, 8.6, 4.6, -0.42) <= 1;
              const hind = inEllipse(mx, py, 6.2, 19.5, 6.0, 4.4, 0.45) <= 1;
              const ant = distToSegment(mx, py, 0.8, 8.5, 4.5, 3.2) < 0.45;
              inside = body || fore || hind || ant;
              if (body) sh = 0.86;
              else if (fore && distToSegment(mx, py, 2, 13, 13, 9.5) < 0.35) sh = 0.9;
            } else if (species === 'beetle') {
              const body = inEllipse(mx, py, 0, 18, 8.2, 10.5, 0) <= 1;
              const head = inEllipse(mx, py, 0, 6.6, 3.6, 3.0, 0) <= 1;
              const pron = inEllipse(mx, py, 0, 9.8, 5.6, 3.2, 0) <= 1;
              const legs = distToSegment(mx, py, 6, 12, 11.5, 9) < 0.5 ||
                distToSegment(mx, py, 7.5, 17, 13, 17.5) < 0.5 ||
                distToSegment(mx, py, 6.5, 22, 11.5, 27) < 0.5;
              const ant = distToSegment(mx, py, 1.5, 4.5, 4.5, 1.2) < 0.4;
              inside = body || head || pron || legs || ant;
              if (body && mx < 0.45 && py > 10) sh = 0.82;
              else if (head || pron) sh = 0.9;
            } else {
              // leaf insect
              const t = (py - 3) / 27;
              let leaf = false;
              if (t >= 0 && t <= 1) {
                const half = 10.5 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.85);
                leaf = mx <= half;
              }
              const head = inEllipse(mx, py, 0, 3.2, 1.6, 2.0, 0) <= 1;
              const legs = distToSegment(mx, py, 4, 9, 9, 6) < 0.5 || distToSegment(mx, py, 5, 21, 10, 26) < 0.5;
              inside = leaf || head || legs;
              if (leaf && mx < 0.4) sh = 0.84;
              else if (leaf && (Math.abs(py - 3 - mx * 1.3 - 4) < 0.35 || Math.abs(py - 3 - mx * 1.3 - 12) < 0.35)) sh = 0.92;
            }
            if (inside) hit++;
          }
        }
        alpha[y * S + x] = hit / (SS * SS);
        shade[y * S + x] = sh;
      }
    }
    return { alpha, shade };
  }

  const bodyCache = {};
  function getBody(species) {
    if (!bodyCache[species]) bodyCache[species] = buildBody(species);
    return bodyCache[species];
  }

  // A "naive" creature. Half are plain (one base colour with a little
  // variation), half are patchy multi-colour. Showing the predator both kinds
  // teaches it that "anything that isn't habitat" is prey.
  function randomGenome() {
    const g = new Float32Array(GENOME_LEN);
    const base = [random(), random(), random()];
    const spread = random() < 0.5 ? 0.04 + random() * 0.12 : 0.2 + random() * 0.35;
    for (let i = 0; i < G * G; i++) {
      for (let c = 0; c < 3; c++) g[i * 3 + c] = clamp01(base[c] + gauss() * spread);
    }
    return g;
  }

  // Bilinear upsample of the 8x8 colour grid onto the body.
  function renderSprite(genome, species) {
    const body = getBody(species);
    const rgb = new Float32Array(S * S * 3);
    for (let y = 0; y < S; y++) {
      const gy = Math.min(G - 1.0001, Math.max(0, (y + 0.5) / S * G - 0.5));
      const y0 = Math.floor(gy), fy = gy - y0;
      for (let x = 0; x < S; x++) {
        const gx = Math.min(G - 1.0001, Math.max(0, (x + 0.5) / S * G - 0.5));
        const x0 = Math.floor(gx), fx = gx - x0;
        const sh = body.shade[y * S + x];
        for (let c = 0; c < 3; c++) {
          const a = genome[(y0 * G + x0) * 3 + c];
          const b = genome[(y0 * G + x0 + 1) * 3 + c];
          const d = genome[((y0 + 1) * G + x0) * 3 + c];
          const e = genome[((y0 + 1) * G + x0 + 1) * 3 + c];
          const top = a + (b - a) * fx, bot = d + (e - d) * fx;
          rgb[(y * S + x) * 3 + c] = (top + (bot - top) * fy) * sh;
        }
      }
    }
    return { rgb, alpha: body.alpha };
  }

  // Paint a sprite into an RGB float buffer. rot = 0..3 quarter turns.
  function stamp(buf, bw, bh, sprite, px, py, rot) {
    for (let y = 0; y < S; y++) {
      const by = py + y;
      if (by < 0 || by >= bh) continue;
      for (let x = 0; x < S; x++) {
        const bx = px + x;
        if (bx < 0 || bx >= bw) continue;
        let sx, sy;
        if (rot === 0) { sx = x; sy = y; }
        else if (rot === 1) { sx = y; sy = S - 1 - x; }
        else if (rot === 2) { sx = S - 1 - x; sy = S - 1 - y; }
        else { sx = S - 1 - y; sy = x; }
        const si = sy * S + sx;
        const a = sprite.alpha[si];
        if (a <= 0) continue;
        const bi = (by * bw + bx) * 3;
        buf[bi] = buf[bi] * (1 - a) + sprite.rgb[si * 3] * a;
        buf[bi + 1] = buf[bi + 1] * (1 - a) + sprite.rgb[si * 3 + 1] * a;
        buf[bi + 2] = buf[bi + 2] * (1 - a) + sprite.rgb[si * 3 + 2] * a;
      }
    }
  }

  // ------------------------------------------------------------------
  // The predator's eye: 32x32 window -> 16x16x3 input vector
  // ------------------------------------------------------------------
  const WIN = 32;
  const IN = 16;
  const INPUT_LEN = IN * IN * 3;

  const patchBuf = new Float32Array(WIN * WIN * 3);

  function copyWindow(src, sw, x0, y0, out) {
    for (let y = 0; y < WIN; y++) {
      const so = ((y0 + y) * sw + x0) * 3;
      out.set(src.subarray(so, so + WIN * 3), y * WIN * 3);
    }
  }

  function downsample(win, out) {
    for (let y = 0; y < IN; y++) {
      for (let x = 0; x < IN; x++) {
        const i0 = ((2 * y) * WIN + 2 * x) * 3;
        const i1 = i0 + WIN * 3;
        const o = (y * IN + x) * 3;
        const r = (win[i0] + win[i0 + 3] + win[i1] + win[i1 + 3]) * 0.25;
        const g = (win[i0 + 1] + win[i0 + 4] + win[i1 + 1] + win[i1 + 4]) * 0.25;
        const b = (win[i0 + 2] + win[i0 + 5] + win[i1 + 2] + win[i1 + 5]) * 0.25;
        // opponent colour channels, like animal vision:
        // brightness, red-vs-green, blue-vs-yellow
        out[o] = (r + g + b) / 3 - 0.5;
        out[o + 1] = (r - g) * 2;
        out[o + 2] = (b - (r + g) / 2) * 2;
      }
    }
    return out;
  }

  // Fill `out` with what the predator sees for a window of the scene/habitat.
  function viewWindow(img, iw, x0, y0, out) {
    copyWindow(img, iw, x0, y0, patchBuf);
    return downsample(patchBuf, out);
  }

  // Background window with a creature pasted at offset (ox, oy).
  function viewAt(hab, x0, y0, sprite, rot, ox, oy, out) {
    copyWindow(hab.rgb, hab.W, x0, y0, patchBuf);
    stamp(patchBuf, WIN, WIN, sprite, ox, oy, rot);
    return downsample(patchBuf, out);
  }

  // Same, with a random offset of up to `jitter` pixels.
  function viewWithCreature(hab, x0, y0, sprite, rot, jitter, out) {
    const ox = jitter ? Math.round((random() * 2 - 1) * jitter) : 0;
    const oy = jitter ? Math.round((random() * 2 - 1) * jitter) : 0;
    return viewAt(hab, x0, y0, sprite, rot, ox, oy, out);
  }

  // ------------------------------------------------------------------
  // Predator: multilayer perceptron, ReLU hidden layers, sigmoid output,
  // binary cross-entropy loss, trained with mini-batch backprop + Adam.
  // ------------------------------------------------------------------
  function MLP(sizes) {
    this.sizes = sizes.slice();
    this.L = sizes.length - 1;
    this.W = []; this.b = [];
    this.gW = []; this.gb = [];
    this.mW = []; this.vW = []; this.mb = []; this.vb = [];
    for (let l = 0; l < this.L; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const W = new Float32Array(nin * nout);
      const std = Math.sqrt(2 / nin);
      for (let i = 0; i < W.length; i++) W[i] = gauss() * std;
      this.W.push(W); this.b.push(new Float32Array(nout));
      this.gW.push(new Float32Array(nin * nout)); this.gb.push(new Float32Array(nout));
      this.mW.push(new Float32Array(nin * nout)); this.vW.push(new Float32Array(nin * nout));
      this.mb.push(new Float32Array(nout)); this.vb.push(new Float32Array(nout));
    }
    this.a = sizes.map((n) => new Float32Array(n));
    this.d = sizes.map((n) => new Float32Array(n));
    this.t = 0;
    this.samplesSeen = 0;
  }

  MLP.prototype.forward = function (x) {
    this.a[0].set(x);
    for (let l = 0; l < this.L; l++) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const inp = this.a[l], out = this.a[l + 1], W = this.W[l], b = this.b[l];
      const last = l === this.L - 1;
      for (let j = 0; j < nout; j++) {
        let s = b[j];
        const row = j * nin;
        for (let i = 0; i < nin; i++) s += W[row + i] * inp[i];
        out[j] = last ? 1 / (1 + Math.exp(-s)) : (s > 0 ? s : 0);
      }
    }
    return this.a[this.L][0];
  };

  // Call right after forward(). Accumulates gradients. Returns sample loss.
  MLP.prototype.backward = function (y) {
    const p = this.a[this.L][0];
    this.d[this.L][0] = p - y;
    for (let l = this.L - 1; l >= 0; l--) {
      const nin = this.sizes[l], nout = this.sizes[l + 1];
      const inp = this.a[l], dOut = this.d[l + 1], W = this.W[l];
      const gW = this.gW[l], gb = this.gb[l];
      const dIn = this.d[l];
      if (l > 0) dIn.fill(0);
      for (let j = 0; j < nout; j++) {
        const dj = dOut[j];
        if (dj === 0) continue;
        gb[j] += dj;
        const row = j * nin;
        for (let i = 0; i < nin; i++) {
          gW[row + i] += dj * inp[i];
          if (l > 0) dIn[i] += W[row + i] * dj;
        }
      }
      if (l > 0) for (let i = 0; i < nin; i++) if (inp[i] <= 0) dIn[i] = 0;
    }
    const eps = 1e-7;
    return -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  };

  MLP.prototype.step = function (lr, batch) {
    this.t++;
    const b1 = 0.9, b2 = 0.999, eps = 1e-8;
    const c1 = 1 - Math.pow(b1, this.t), c2 = 1 - Math.pow(b2, this.t);
    const upd = (P, g, m, v) => {
      for (let i = 0; i < P.length; i++) {
        const gi = g[i] / batch;
        m[i] = b1 * m[i] + (1 - b1) * gi;
        v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        P[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        g[i] = 0;
      }
    };
    for (let l = 0; l < this.L; l++) {
      upd(this.W[l], this.gW[l], this.mW[l], this.vW[l]);
      upd(this.b[l], this.gb[l], this.mb[l], this.vb[l]);
    }
    this.samplesSeen += batch;
  };

  MLP.prototype.clone = function () {
    const m = Object.create(MLP.prototype);
    m.sizes = this.sizes.slice(); m.L = this.L;
    const cp = (arr) => arr.map((x) => new Float32Array(x));
    m.W = cp(this.W); m.b = cp(this.b);
    m.gW = cp(this.gW); m.gb = cp(this.gb);
    m.mW = cp(this.mW); m.vW = cp(this.vW); m.mb = cp(this.mb); m.vb = cp(this.vb);
    m.a = this.sizes.map((n) => new Float32Array(n));
    m.d = this.sizes.map((n) => new Float32Array(n));
    m.t = this.t; m.samplesSeen = this.samplesSeen;
    return m;
  };

  MLP.prototype.paramCount = function () {
    let n = 0;
    for (let l = 0; l < this.L; l++) n += this.W[l].length + this.b[l].length;
    return n;
  };

  function createPredator() { return new MLP([INPUT_LEN, 64, 24, 1]); }

  // Trainer works in small chunks so the UI can animate the loss curve.
  //   preyPool(): returns a genome to use as a positive example
  function Trainer(net, hab, species, preyPool, opts) {
    opts = opts || {};
    this.net = net; this.hab = hab; this.species = species; this.pool = preyPool;
    this.batch = opts.batch || 32;
    this.lr = opts.lr || 0.0015;
    this.steps = opts.steps || 400;
    this.done = 0;
    this.losses = [];
    this.x = new Float32Array(INPUT_LEN);
    this.spriteCache = new Map();
  }

  Trainer.prototype.sprite = function (g) {
    let s = this.spriteCache.get(g);
    if (!s) { s = renderSprite(g, this.species); this.spriteCache.set(g, s); }
    return s;
  };

  Trainer.prototype.run = function (nSteps) {
    const { hab, net, x } = this;
    const maxX = hab.W - WIN, maxY = hab.H - WIN;
    let lastLoss = 0;
    for (let s = 0; s < nSteps && this.done < this.steps; s++) {
      let loss = 0;
      for (let k = 0; k < this.batch; k++) {
        const pos = k % 2 === 0;
        const x0 = randInt(maxX + 1), y0 = randInt(maxY + 1);
        if (pos) viewWithCreature(hab, x0, y0, this.sprite(this.pool()), randInt(4), 6, x);
        else viewWindow(hab.rgb, hab.W, x0, y0, x);
        net.forward(x);
        loss += net.backward(pos ? 1 : 0);
      }
      net.step(this.lr, this.batch);
      lastLoss = loss / this.batch;
      this.losses.push(lastLoss);
      this.done++;
    }
    return lastLoss;
  };

  Trainer.prototype.finished = function () { return this.done >= this.steps; };

  // ------------------------------------------------------------------
  // Genetic algorithm
  // ------------------------------------------------------------------
  let nextId = 1;
  function resetIds() { nextId = 1; }

  function makeIndividual(genome, gen, parents) {
    return { id: nextId++, g: genome, gen, parents: parents || null, p: 0, fitness: 0, sprite: null };
  }

  function Evolution(opts) {
    opts = opts || {};
    this.popSize = opts.popSize || 36;
    this.trials = opts.trials || 5;
    this.tournament = opts.tournament || 3;
    this.elite = opts.elite || 2;
    this.mutationRate = opts.mutationRate || 0.08;
    this.mutationSize = opts.mutationSize || 0.09;
    this.jitter = opts.jitter === undefined ? 5 : opts.jitter;
    this.looks = opts.looks || 3;
    this.generation = 0;
    this.pop = [];
    for (let i = 0; i < this.popSize; i++) this.pop.push(makeIndividual(randomGenome(), 0));
    this.x = new Float32Array(INPUT_LEN);
  }

  // Fitness = 1 - P(detected), averaged over several random spots in the
  // habitat. At each spot the predator gets a few looks at slightly different
  // window positions and keeps its strongest response, the way it does when it
  // scans a whole scene. Every individual faces the same spots and looks.
  Evolution.prototype.evaluate = function (net, hab, species) {
    const spots = [];
    const j = this.jitter;
    const off = () => Math.round((random() * 2 - 1) * j);
    for (let t = 0; t < this.trials; t++) {
      const looks = [];
      for (let k = 0; k < this.looks; k++) looks.push(k === 0 ? [0, 0] : [off(), off()]);
      spots.push([randInt(hab.W - WIN + 1), randInt(hab.H - WIN + 1), randInt(4), looks]);
    }
    for (const ind of this.pop) {
      if (!ind.sprite || ind.sprite.species !== species) {
        ind.sprite = renderSprite(ind.g, species);
        ind.sprite.species = species;
      }
      let sum = 0;
      for (const [x0, y0, rot, looks] of spots) {
        let best = 0;
        for (const [ox, oy] of looks) {
          viewAt(hab, x0, y0, ind.sprite, rot, ox, oy, this.x);
          const p = net.forward(this.x);
          if (p > best) best = p;
        }
        sum += best;
      }
      ind.p = sum / spots.length;
      ind.fitness = 1 - ind.p;
    }
    this.pop.sort((a, b) => b.fitness - a.fitness);
    return this.stats();
  };

  Evolution.prototype.stats = function () {
    let spotted = 0, sumP = 0;
    for (const ind of this.pop) { if (ind.p > 0.5) spotted++; sumP += ind.p; }
    return {
      generation: this.generation,
      detection: spotted / this.pop.length,
      meanP: sumP / this.pop.length,
      best: this.pop[0],
    };
  };

  Evolution.prototype.select = function () {
    let best = null;
    for (let k = 0; k < this.tournament; k++) {
      const c = this.pop[randInt(this.pop.length)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  };

  // 2D crossover: child = parent A with a rectangle of cells taken from B.
  function crossover(a, b) {
    const child = new Float32Array(a);
    const w = 2 + randInt(G - 2), h = 2 + randInt(G - 2);
    const cx = randInt(G - w + 1), cy = randInt(G - h + 1);
    for (let y = cy; y < cy + h; y++) {
      for (let x = cx; x < cx + w; x++) {
        const i = (y * G + x) * 3;
        child[i] = b[i]; child[i + 1] = b[i + 1]; child[i + 2] = b[i + 2];
      }
    }
    return child;
  }

  Evolution.prototype.mutate = function (g) {
    for (let i = 0; i < g.length; i++) {
      if (random() < this.mutationRate) g[i] = clamp01(g[i] + gauss() * this.mutationSize);
    }
    // occasional whole-body colour drift (a "regulatory" mutation)
    if (random() < 0.15) {
      const c = randInt(3), d = gauss() * 0.05;
      for (let i = c; i < g.length; i += 3) g[i] = clamp01(g[i] + d);
    }
    return g;
  };

  Evolution.prototype.nextGeneration = function () {
    const next = [];
    for (let e = 0; e < this.elite; e++) {
      const keep = makeIndividual(new Float32Array(this.pop[e].g), this.generation + 1, [this.pop[e].id]);
      keep.elite = true;
      next.push(keep);
    }
    while (next.length < this.popSize) {
      const A = this.select(), B = this.select();
      const g = this.mutate(random() < 0.85 ? crossover(A.g, B.g) : new Float32Array(A.g));
      next.push(makeIndividual(g, this.generation + 1, [A.id, B.id]));
    }
    this.pop = next;
    this.generation++;
  };

  // ------------------------------------------------------------------
  // Scene: creatures placed in a habitat, used by the lab and the hunt
  // ------------------------------------------------------------------
  function placeCreatures(hab, count, margin) {
    margin = margin || 4;
    const spots = [];
    let tries = 0;
    while (spots.length < count && tries < 5000) {
      tries++;
      const x = margin + randInt(hab.W - S - 2 * margin);
      const y = margin + randInt(hab.H - S - 2 * margin);
      if (spots.every((s) => Math.abs(s.x - x) > S + 6 || Math.abs(s.y - y) > S + 6)) {
        spots.push({ x, y, rot: randInt(4) });
      }
    }
    return spots;
  }

  function composeScene(hab, placed) {
    const img = new Float32Array(hab.rgb);
    for (const c of placed) stamp(img, hab.W, hab.H, c.sprite, c.x, c.y, c.rot);
    return img;
  }

  // Slide the predator's window over the scene. Returns a grid of P(prey).
  function scanScene(net, img, W, H, stride, rowStart, rowEnd, grid) {
    const cols = Math.floor((W - WIN) / stride) + 1;
    const rows = Math.floor((H - WIN) / stride) + 1;
    if (!grid) grid = { cols, rows, stride, p: new Float32Array(cols * rows) };
    const x = new Float32Array(INPUT_LEN);
    const r0 = rowStart || 0, r1 = Math.min(rows, rowEnd === undefined ? rows : rowEnd);
    for (let r = r0; r < r1; r++) {
      for (let c = 0; c < cols; c++) {
        viewWindow(img, W, c * stride, r * stride, x);
        grid.p[r * cols + c] = net.forward(x);
      }
    }
    return grid;
  }

  // Strongest response of the scan near a creature (window centre within reach).
  function creatureScore(grid, cx, cy, reach) {
    reach = reach || 9;
    let best = 0;
    for (let r = 0; r < grid.rows; r++) {
      const wy = r * grid.stride + WIN / 2;
      if (Math.abs(wy - cy) > reach) continue;
      for (let c = 0; c < grid.cols; c++) {
        const wx = c * grid.stride + WIN / 2;
        if (Math.abs(wx - cx) > reach) continue;
        const p = grid.p[r * grid.cols + c];
        if (p > best) best = p;
      }
    }
    return best;
  }

  // Detection rate of a set of genomes against a predator (fresh random spots).
  function detectionRate(net, hab, species, genomes, trials) {
    trials = trials || 4;
    const x = new Float32Array(INPUT_LEN);
    let spotted = 0, sumP = 0;
    for (const g of genomes) {
      const sp = renderSprite(g, species);
      let s = 0;
      for (let t = 0; t < trials; t++) {
        viewWithCreature(hab, randInt(hab.W - WIN + 1), randInt(hab.H - WIN + 1), sp, randInt(4), 0, x);
        s += net.forward(x);
      }
      s /= trials;
      sumP += s;
      if (s > 0.5) spotted++;
    }
    return { rate: spotted / genomes.length, meanP: sumP / genomes.length };
  }

  // False alarm rate: how often empty background is flagged as prey.
  function falseAlarmRate(net, hab, n) {
    n = n || 200;
    const x = new Float32Array(INPUT_LEN);
    let fa = 0;
    for (let i = 0; i < n; i++) {
      viewWindow(hab.rgb, hab.W, randInt(hab.W - WIN + 1), randInt(hab.H - WIN + 1), x);
      if (net.forward(x) > 0.5) fa++;
    }
    return fa / n;
  }

  // Average colour distance between a genome and the habitat (how close to
  // "perfect" colour matching evolution got).
  function habitatMean(hab) {
    const m = [0, 0, 0];
    const n = hab.W * hab.H;
    for (let i = 0; i < n; i++) { m[0] += hab.rgb[i * 3]; m[1] += hab.rgb[i * 3 + 1]; m[2] += hab.rgb[i * 3 + 2]; }
    return m.map((v) => v / n);
  }

  root.Camo = {
    seed, random, randInt, gauss,
    HABITATS, SPECIES, paintHabitat,
    S, G, GENOME_LEN, WIN, IN, INPUT_LEN,
    randomGenome, renderSprite, stamp, getBody,
    viewWindow, viewWithCreature, viewAt,
    MLP, createPredator, Trainer,
    Evolution, makeIndividual, resetIds, crossover,
    placeCreatures, composeScene, scanScene, creatureScore,
    detectionRate, falseAlarmRate, habitatMean,
  };
})(typeof window !== 'undefined' ? window : globalThis);
