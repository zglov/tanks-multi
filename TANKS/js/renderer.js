'use strict';
/**
 * ============================================================================
 *  renderer.js — Dibujo del GameState en un <canvas> 2D.
 * ============================================================================
 *  El Renderer es de SOLO LECTURA respecto al GameState: nunca modifica la
 *  simulación. Todo lo que mantiene (partículas, huellas de orugas, sacudida
 *  de cámara) es puramente cosmético y local a cada máquina.
 *
 *  Optimización para 60 FPS:
 *   - Capa estática (suelo + bloques) pre-renderizada en un canvas offscreen;
 *     sólo se regenera cuando cambia map.revision (al romperse un bloque).
 *   - Capa de "decals" (huellas) persistente: dibujar una huella cuesta O(1).
 *   - Interpolación (alpha) entre el estado anterior y actual de cada tick
 *     fijo → movimiento suave también en monitores de 120/144 Hz.
 * ============================================================================
 */
class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.state = null;

    this.staticLayer = document.createElement('canvas');
    this.staticCtx = this.staticLayer.getContext('2d');
    this.decalLayer = document.createElement('canvas');
    this.decalCtx = this.decalLayer.getContext('2d');

    this._mapRevision = -1;
    this._roundNumber = -1;
    this._roundBanner = 0;
    this._decalFade = 0;
    this.shake = 0;
    this.time = 0;

    /** Partículas cosméticas. layer 0 = bajo los tanques, 1 = encima. */
    this.particles = [];
    this.rings = [];
    /** Estado cosmético por tanque (fase de orugas, última huella). */
    this.tankFx = new Map();
    /** Imágenes personalizadas de otros jugadores: tankId -> {tank, missile}. */
    this.remoteSkins = new Map();
    this._localTankId = null;
  }

  /** Asocia el GameState a dibujar. */
  setState(state) {
    this.state = state;
    this._mapRevision = -1;
    this._roundNumber = -1;
    this.particles.length = 0;
    this.rings.length = 0;
    this.tankFx.clear();
    this._ensureSize();
    this.decalCtx.clearRect(0, 0, this.decalLayer.width, this.decalLayer.height);
  }

  _ensureSize() {
    const { width, height } = this.state.map;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    for (const c of [this.staticLayer, this.decalLayer]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
  }

  // ==========================================================================
  //  EVENTOS DEL JUEGO → EFECTOS VISUALES
  // ==========================================================================
  handleEvent(ev) {
    switch (ev.type) {
      case 'shot': {
        const c = Math.cos(ev.angle), s = Math.sin(ev.angle);
        for (let i = 0; i < 6; i++) {
          const a = ev.angle + MathUtil.randRange(-0.5, 0.5);
          const sp = MathUtil.randRange(40, 140);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.15, MathUtil.randRange(2, 3.5), '#ffd75e', 1, 8);
        }
        for (let i = 0; i < 3; i++) {
          this._particle(ev.x + c * 4, ev.y + s * 4, c * 20 + MathUtil.randRange(-10, 10), s * 20 + MathUtil.randRange(-10, 10),
            MathUtil.randRange(0.4, 0.7), 4, 'rgba(200,200,200,1)', 1, 3, 10);
        }
        break;
      }
      case 'bounce':
        for (let i = 0; i < 5; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(30, 90);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.2, 2, '#fff3b0', 1, 6);
        }
        break;
      case 'bulletDestroyed':
      case 'bulletClash':
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(20, 80);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.25, 0.5), 3,
            i % 2 ? '#ffffff' : '#bdbdbd', 1, 5, 4);
        }
        break;
      case 'blockDestroyed': {
        const ts = CONFIG.TILE_SIZE;
        const cx = (ev.tx + 0.5) * ts, cy = (ev.ty + 0.5) * ts;
        for (let i = 0; i < 22; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(40, 180);
          this._particle(cx + MathUtil.randRange(-12, 12), cy + MathUtil.randRange(-12, 12), Math.cos(a) * sp, Math.sin(a) * sp,
            MathUtil.randRange(0.4, 0.9), MathUtil.randRange(2, 5), i % 3 ? '#d9b97c' : '#9c7a45', 1, 4);
        }
        for (let i = 0; i < 6; i++) {
          this._particle(cx, cy, MathUtil.randRange(-30, 30), MathUtil.randRange(-30, 30), MathUtil.randRange(0.6, 1.1), 8,
            'rgba(190,170,140,1)', 1, 2, 14);
        }
        this.shake = Math.max(this.shake, 3);
        break;
      }
      case 'tankDestroyed': {
        const color = CONFIG.COLORS[ev.colorIndex] || CONFIG.COLORS[0];
        this.rings.push({ x: ev.x, y: ev.y, life: 0.4, max: 0.4, maxR: 55 });
        const fire = ['#fff2a8', '#ffc94a', '#ff8a2a', '#ff4d1f'];
        for (let i = 0; i < 28; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(50, 230);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.3, 0.75),
            MathUtil.randRange(3, 7), fire[i % fire.length], 1, 4, -4);
        }
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(10, 60);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.9, 1.6),
            MathUtil.randRange(6, 10), 'rgba(90,90,90,1)', 1, 1.5, 12);
        }
        for (let i = 0; i < 10; i++) {
          const a = Math.random() * TAU, sp = MathUtil.randRange(80, 200);
          this._particle(ev.x, ev.y, Math.cos(a) * sp, Math.sin(a) * sp, MathUtil.randRange(0.5, 0.9), 3.5, color.body, 1, 3);
        }
        this.shake = Math.max(this.shake, 9);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Crea una partícula.
   * @param {number} life  duración en s
   * @param {number} size  radio inicial
   * @param {number} drag  amortiguación de velocidad (1/s)
   * @param {number} grow  crecimiento del radio (px/s, puede ser negativo)
   */
  _particle(x, y, vx, vy, life, size, color, layer = 1, drag = 3, grow = 0) {
    if (this.particles.length > 900) return;
    this.particles.push({ x, y, vx, vy, life, max: life, size, color, layer, drag, grow });
  }

  _updateParticles(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size = Math.max(0.5, p.size + p.grow * dt);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  // ==========================================================================
  //  RENDER PRINCIPAL
  // ==========================================================================
  /**
   * @param {number} alpha   fracción [0,1) entre el tick anterior y el actual
   * @param {number} frameDt dt real del frame (para efectos cosméticos)
   * @param {object} view    { localTankId, mouse, mirrorState, paused, waitingForHost }
   */
  render(alpha, frameDt, view) {
    const ctx = this.ctx;
    const state = this.state;
    this.time += frameDt;
    this._ensureSize();

    if (state.map.revision !== this._mapRevision) this._buildStaticLayer();
    if (state.round.number !== this._roundNumber) {
      this._roundNumber = state.round.number;
      this._roundBanner = 1.8;
      this.tankFx.clear();
      this.decalCtx.clearRect(0, 0, this.decalLayer.width, this.decalLayer.height);
    }
    if (!view.paused) {
      this._updateParticles(frameDt);
      this._spawnBulletSmoke(frameDt, alpha);
    }
    this._roundBanner = Math.max(0, this._roundBanner - frameDt);
    this._updateDecals(alpha, frameDt);
    this._localTankId = view.localTankId;

    // --- Mundo (con sacudida de cámara) ---
    ctx.save();
    if (this.shake > 0) ctx.translate(MathUtil.randRange(-1, 1) * this.shake, MathUtil.randRange(-1, 1) * this.shake);
    ctx.drawImage(this.staticLayer, 0, 0);
    ctx.drawImage(this.decalLayer, 0, 0);

    for (const t of state.tanks.values()) if (!t.isAlive) this._drawWreck(ctx, t);
    this._drawParticles(ctx, 0);

    for (const t of state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      const ca = MathUtil.lerpAngle(t.prevChassisAngle, t.chassisAngle, alpha);
      const ta = MathUtil.lerpAngle(t.prevTurretAngle, t.turretAngle, alpha);
      const fx = this.tankFx.get(t.id);
      this._drawTank(ctx, x, y, ca, ta, t.color, fx ? fx.phase : 0, this._skinFor(t.id, 'tank'));
    }

    for (const b of state.bullets.values()) this._drawBullet(ctx, b, alpha, state, this._skinFor(b.ownerId, 'missile'));

    this._drawParticles(ctx, 1);
    this._drawRings(ctx);

    if (view.mirrorState) this._drawMirror(ctx, view.mirrorState, alpha);

    this._drawLabels(ctx, alpha, view.localTankId);
    ctx.restore();

    // --- Interfaz sobre el mundo (sin sacudida) ---
    this._drawAim(ctx, alpha, view);
    this._drawBanners(ctx, view);
  }

  // ==========================================================================
  //  CAPA ESTÁTICA: SUELO Y BLOQUES
  // ==========================================================================
  _buildStaticLayer() {
    const g = this.staticCtx;
    const map = this.state.map;
    const ts = map.tileSize;
    this._mapRevision = map.revision;

    // Suelo de madera clara
    g.fillStyle = '#ead6a9';
    g.fillRect(0, 0, map.width, map.height);
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        const n = MathUtil.hashNoise(tx, ty);
        g.fillStyle = `rgba(150,110,50,${0.03 + n * 0.05})`;
        g.fillRect(tx * ts, ty * ts, ts, ts);
      }
    }
    g.strokeStyle = 'rgba(140,100,45,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    for (let tx = 0; tx <= map.cols; tx++) { g.moveTo(tx * ts + 0.5, 0); g.lineTo(tx * ts + 0.5, map.height); }
    for (let ty = 0; ty <= map.rows; ty++) { g.moveTo(0, ty * ts + 0.5); g.lineTo(map.width, ty * ts + 0.5); }
    g.stroke();

    // Sombras proyectadas por los bloques
    g.fillStyle = 'rgba(70,45,20,0.28)';
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        if (map.isSolid(tx, ty)) g.fillRect(tx * ts + 6, ty * ts + 7, ts, ts);
      }
    }

    // Bloques
    for (let ty = 0; ty < map.rows; ty++) {
      for (let tx = 0; tx < map.cols; tx++) {
        const type = map.get(tx, ty);
        if (type === TILE.WALL) this._drawWallTile(g, tx, ty, ts);
        else if (type === TILE.BREAKABLE) this._drawBreakableTile(g, tx, ty, ts);
      }
    }
  }

  _drawWallTile(g, tx, ty, ts) {
    const x = tx * ts, y = ty * ts;
    const side = 7;
    g.fillStyle = '#8c6236';           // cara frontal (pseudo-3D)
    g.fillRect(x, y, ts, ts);
    g.fillStyle = '#c4935a';           // cara superior
    g.fillRect(x, y, ts, ts - side);
    g.fillStyle = '#dcae74';           // bisel
    g.fillRect(x, y, ts, 3);
    // Vetas de madera
    g.strokeStyle = 'rgba(110,70,30,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i <= 3; i++) {
      const yy = y + i * ((ts - side) / 4) + (MathUtil.hashNoise(tx * 3 + i, ty) - 0.5) * 3;
      g.moveTo(x + 2, yy);
      g.lineTo(x + ts - 2, yy + (MathUtil.hashNoise(tx, ty * 5 + i) - 0.5) * 2);
    }
    g.stroke();
    g.strokeStyle = 'rgba(60,35,10,0.55)';
    g.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
  }

  _drawBreakableTile(g, tx, ty, ts) {
    const x = tx * ts, y = ty * ts;
    const side = 6;
    g.fillStyle = '#b08a52';
    g.fillRect(x + 1, y + 1, ts - 2, ts - 2);
    g.fillStyle = '#e2c487';
    g.fillRect(x + 1, y + 1, ts - 2, ts - 2 - side);
    // Textura de corcho (moteado determinista)
    for (let i = 0; i < 16; i++) {
      const px = x + 4 + MathUtil.hashNoise(tx * 31 + i, ty * 17) * (ts - 8);
      const py = y + 4 + MathUtil.hashNoise(tx * 13, ty * 29 + i) * (ts - side - 8);
      g.fillStyle = i % 2 ? 'rgba(140,100,50,0.55)' : 'rgba(255,240,200,0.6)';
      g.fillRect(px, py, 2, 2);
    }
    // Marco discontinuo = pista visual de "destructible"
    g.strokeStyle = 'rgba(110,75,30,0.7)';
    g.setLineDash([4, 3]);
    g.strokeRect(x + 4.5, y + 4.5, ts - 9, ts - 9 - side);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(80,55,20,0.6)';
    g.strokeRect(x + 1.5, y + 1.5, ts - 3, ts - 3);
  }

  // ==========================================================================
  //  DECALS: huellas de orugas que se desvanecen
  // ==========================================================================
  _updateDecals(alpha, dt) {
    const g = this.decalCtx;
    this._decalFade += dt;
    if (this._decalFade > 0.5) {
      this._decalFade = 0;
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.fillRect(0, 0, this.decalLayer.width, this.decalLayer.height);
      g.globalCompositeOperation = 'source-over';
    }

    const half = CONFIG.TANK.BODY_WIDTH / 2;
    g.fillStyle = 'rgba(105,75,35,0.22)';
    for (const t of this.state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      let fx = this.tankFx.get(t.id);
      if (!fx) {
        fx = { lastX: x, lastY: y, markX: x, markY: y, phase: 0 };
        this.tankFx.set(t.id, fx);
      }
      const dx = x - fx.lastX, dy = y - fx.lastY;
      const moved = Math.hypot(dx, dy);
      if (moved > 40) { // teletransporte (respawn / corrección de red)
        fx.markX = x; fx.markY = y;
      }
      const forward = dx * Math.cos(t.chassisAngle) + dy * Math.sin(t.chassisAngle) >= 0 ? 1 : -1;
      fx.phase += moved * forward;
      fx.lastX = x;
      fx.lastY = y;

      if (MathUtil.dist2(x, y, fx.markX, fx.markY) >= 36) {
        const c = Math.cos(t.chassisAngle), s = Math.sin(t.chassisAngle);
        g.setTransform(c, s, -s, c, x, y);
        g.fillRect(-2, -half + 0.5, 4, 6);
        g.fillRect(-2, half - 6.5, 4, 6);
        g.setTransform(1, 0, 0, 1, 0, 0);
        fx.markX = x;
        fx.markY = y;
      }
    }
  }

  // ==========================================================================
  //  ENTIDADES
  // ==========================================================================
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Imagen personalizada para un tanque/bala, o null si usa el dibujo clásico.
   * Primero la propia (TankSkins, local); si no, la compartida por la red.
   */
  _skinFor(tankId, kind) {
    if (tankId === this._localTankId) {
      const img = window.TankSkins && window.TankSkins[kind];
      if (img && img.complete && img.naturalWidth > 0) return img;
    }
    const entry = this.remoteSkins.get(tankId);
    const img = entry && entry[kind];
    if (img && img.complete && img.naturalWidth > 0) return img;
    return null;
  }

  _drawTank(ctx, x, y, chassis, turret, color, treadPhase, skinImage) {
    const T = CONFIG.TANK;
    const L = T.BODY_LENGTH, W = T.BODY_WIDTH;
    const treadH = 7;

    // --- Skin personalizada: imagen subida por el usuario (propia o remota) ---
    const skin = skinImage;
    if (skin) {
      ctx.save();
      ctx.translate(x, y);
      // Sombra
      ctx.fillStyle = 'rgba(50,30,10,0.3)';
      ctx.beginPath();
      ctx.ellipse(3, 4, L / 2 + 2, W / 2 + 2, 0, 0, TAU);
      ctx.fill();
      // La imagen se gira hacia la torreta (hacia donde apuntas) y se ajusta
      // conservando su proporción dentro del tamaño del tanque.
      ctx.rotate(turret);
      const maxW = L + 10, maxH = W + 10;
      const s = Math.min(maxW / skin.naturalWidth, maxH / skin.naturalHeight);
      const dw = skin.naturalWidth * s, dh = skin.naturalHeight * s;
      ctx.drawImage(skin, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.translate(x, y);

    // --- Chasis ---
    ctx.save();
    ctx.rotate(chassis);
    // Sombra
    ctx.fillStyle = 'rgba(50,30,10,0.3)';
    this._roundRect(ctx, -L / 2 + 3, -W / 2 + 4, L, W, 5);
    ctx.fill();
    // Orugas (con franjas animadas según la distancia recorrida)
    const off = ((treadPhase % 5) + 5) % 5;
    for (const ty of [-W / 2, W / 2 - treadH]) {
      ctx.fillStyle = '#2a2a2a';
      this._roundRect(ctx, -L / 2, ty, L, treadH, 2.5);
      ctx.fill();
      ctx.fillStyle = '#5a5a5a';
      for (let sx = -L / 2 + off; sx < L / 2 - 1; sx += 5) ctx.fillRect(sx, ty + 1, 1.6, treadH - 2);
    }
    // Carrocería
    ctx.fillStyle = color.body;
    this._roundRect(ctx, -L / 2 + 2, -W / 2 + 5, L - 4, W - 10, 3);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.dark;
    ctx.stroke();
    ctx.fillStyle = color.light;
    ctx.fillRect(-L / 2 + 5, -W / 2 + 6.5, L - 12, 2);
    // Indicador frontal
    ctx.fillStyle = color.dark;
    ctx.fillRect(L / 2 - 6, -3, 3, 6);
    ctx.restore();

    // --- Torreta (rotación independiente) ---
    ctx.rotate(turret);
    ctx.fillStyle = color.dark;
    ctx.fillRect(0, -3.6, T.BARREL_LENGTH, 7.2);
    ctx.fillStyle = color.body;
    ctx.fillRect(2, -2.2, T.BARREL_LENGTH - 4, 4.4);
    ctx.fillStyle = color.dark;
    ctx.fillRect(T.BARREL_LENGTH - 4, -4.4, 5, 8.8);

    ctx.beginPath();
    ctx.arc(0, 0, 8.5, 0, TAU);
    ctx.fillStyle = color.body;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color.dark;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-2.2, -2.2, 3, 0, TAU);
    ctx.fillStyle = color.light;
    ctx.fill();

    ctx.restore();
  }

  /** Tanque destruido: marca en "X" como en Wii Tanks. */
  _drawWreck(ctx, t) {
    const s = 11;
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, TAU);
    ctx.fillStyle = 'rgba(40,25,10,0.18)';
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = t.color.dark;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(-s, -s); ctx.lineTo(s, s);
    ctx.moveTo(s, -s); ctx.lineTo(-s, s);
    ctx.stroke();
    ctx.restore();
  }

  _drawBullet(ctx, b, alpha, state, skinImage) {
    const x = MathUtil.lerp(b.prevX, b.x, alpha);
    const y = MathUtil.lerp(b.prevY, b.y, alpha);
    const a = Math.atan2(b.vy, b.vx);
    const owner = state.tanks.get(b.ownerId);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    // Estela
    const grad = ctx.createLinearGradient(-18, 0, 0, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(255,255,255,0.7)');
    ctx.fillStyle = grad;
    ctx.fillRect(-18, -2, 18, 4);
    // Skin personalizada: imagen subida por el usuario (propia o remota)
    const skin = skinImage;
    if (skin) {
      const maxW = 20, maxH = 12;
      const s = Math.min(maxW / skin.naturalWidth, maxH / skin.naturalHeight);
      const dw = skin.naturalWidth * s, dh = skin.naturalHeight * s;
      ctx.drawImage(skin, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
      return;
    }
    // Cuerpo
    ctx.beginPath();
    ctx.ellipse(0, 0, 6, 3.6, 0, 0, TAU);
    ctx.fillStyle = '#3b3b3b';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = owner ? owner.color.body : '#000';
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(-1, -2, 4, 1.3);
    // Las balas con 2 rebotes restantes muestran un punto extra
    if (b.bouncesLeft >= 2) {
      ctx.fillStyle = '#ffcf3f';
      ctx.beginPath();
      ctx.arc(-3, 0, 1.4, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  _spawnBulletSmoke(dt, alpha) {
    const chance = dt * 25;
    for (const b of this.state.bullets.values()) {
      if (Math.random() > chance) continue;
      const x = MathUtil.lerp(b.prevX, b.x, alpha);
      const y = MathUtil.lerp(b.prevY, b.y, alpha);
      this._particle(x, y, MathUtil.randRange(-6, 6), MathUtil.randRange(-6, 6), 0.5, 2.2, 'rgba(235,235,235,1)', 0, 1, 5);
    }
  }

  _drawParticles(ctx, layer) {
    for (const p of this.particles) {
      if (p.layer !== layer) continue;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  _drawRings(ctx) {
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 4 * (1 - k) + 1;
      ctx.strokeStyle = '#fff6d0';
      ctx.beginPath();
      ctx.arc(r.x, r.y, 6 + k * r.maxR, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Réplica recibida por la red simulada (modo fantasma, tecla G). */
  _drawMirror(ctx, mirror, alpha) {
    const T = CONFIG.TANK;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 2;
    for (const t of mirror.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha);
      ctx.strokeStyle = t.color.dark;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t.chassisAngle);
      ctx.strokeRect(-T.BODY_LENGTH / 2, -T.BODY_WIDTH / 2, T.BODY_LENGTH, T.BODY_WIDTH);
      ctx.rotate(t.turretAngle - t.chassisAngle);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(T.BARREL_LENGTH + 4, 0);
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    for (const b of mirror.bullets.values()) {
      ctx.beginPath();
      ctx.arc(MathUtil.lerp(b.prevX, b.x, alpha), MathUtil.lerp(b.prevY, b.y, alpha), 6, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawLabels(ctx, alpha, localTankId) {
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    for (const t of this.state.tanks.values()) {
      if (!t.isAlive) continue;
      const x = MathUtil.lerp(t.prevX, t.x, alpha);
      const y = MathUtil.lerp(t.prevY, t.y, alpha) - 24;
      const isLocal = t.id === localTankId;
      const label = isLocal ? 'TÚ' : t.name;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(40,25,10,0.65)';
      ctx.strokeText(label, x, y);
      ctx.fillStyle = isLocal ? '#ffffff' : t.color.light;
      ctx.fillText(label, x, y);
      if (isLocal) {
        const bob = Math.sin(this.time * 6) * 2;
        ctx.fillStyle = t.color.body;
        ctx.beginPath();
        ctx.moveTo(x - 5, y - 16 + bob);
        ctx.lineTo(x + 5, y - 16 + bob);
        ctx.lineTo(x, y - 10 + bob);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Línea de puntería punteada + mira en el cursor (estilo Wii Tanks). */
  _drawAim(ctx, alpha, view) {
    if (!view.mouse || !view.mouse.inside) return;
    const local = this.state.tanks.get(view.localTankId);
    const color = local ? local.color : CONFIG.COLORS[0];
    const mx = view.mouse.x, my = view.mouse.y;

    if (local && local.isAlive && !view.paused) {
      const x = MathUtil.lerp(local.prevX, local.x, alpha);
      const y = MathUtil.lerp(local.prevY, local.y, alpha);
      const a = Math.atan2(my - y, mx - x);
      const d = CONFIG.TANK.BARREL_LENGTH + 6;
      ctx.save();
      ctx.setLineDash([3, 8]);
      ctx.lineDashOffset = -this.time * 20;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(70,45,20,0.35)';
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color.dark;
    ctx.beginPath();
    ctx.arc(mx, my, 9, 0, TAU);
    ctx.moveTo(mx - 14, my); ctx.lineTo(mx - 5, my);
    ctx.moveTo(mx + 5, my); ctx.lineTo(mx + 14, my);
    ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my - 5);
    ctx.moveTo(mx, my + 5); ctx.lineTo(mx, my + 14);
    ctx.stroke();
    ctx.fillStyle = color.body;
    ctx.beginPath();
    ctx.arc(mx, my, 2, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawBanner(ctx, title, subtitle, alpha = 1) {
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(30,20,10,0.55)';
    ctx.fillRect(0, h / 2 - 50, w, subtitle ? 100 : 80);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = '800 42px system-ui, sans-serif';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(30,20,10,0.8)';
    ctx.strokeText(title, w / 2, h / 2 - (subtitle ? 12 : -10));
    ctx.fillStyle = '#fff8e6';
    ctx.fillText(title, w / 2, h / 2 - (subtitle ? 12 : -10));
    if (subtitle) {
      ctx.font = '500 17px system-ui, sans-serif';
      ctx.fillStyle = '#f3dfb5';
      ctx.fillText(subtitle, w / 2, h / 2 + 28);
    }
    ctx.restore();
  }

  _drawBanners(ctx, view) {
    const state = this.state;
    if (view.waitingForHost) {
      this._drawBanner(ctx, 'Esperando al host…', 'Conectado al servidor. Esperando la primera instantánea del host…');
      return;
    }
    if (view.paused) {
      this._drawBanner(ctx, 'PAUSA', 'Pulsa P o Esc para continuar');
      return;
    }
    if (state.round.phase === 'ending') {
      const w = state.tanks.get(state.round.winnerId);
      const title = w ? `¡${w.id === view.localTankId ? 'Ganaste' : w.name + ' gana'}!` : 'Ronda terminada';
      this._drawBanner(ctx, title, `Siguiente ronda en ${Math.ceil(state.round.timer)}…`);
    } else if (this._roundBanner > 0) {
      this._drawBanner(ctx, `Ronda ${state.round.number}`, null, Math.min(1, this._roundBanner / 0.4));
    }
  }
}
