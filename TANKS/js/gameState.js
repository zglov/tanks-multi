'use strict';
/**
 * ============================================================================
 *  gameState.js — Estado centralizado y simulación autoritativa.
 * ============================================================================
 *  GameState es la "fuente de verdad" del juego:
 *     tanks   : Map<id, Tank>
 *     bullets : Map<id, Bullet>
 *     map     : TileMap
 *     round   : estado de la ronda
 *
 *  Dos modos de funcionamiento:
 *   - isAuthority = true  (HOST / modo local): simula física, colisiones,
 *                         muertes y rondas a partir de los inputs recibidos.
 *   - isAuthority = false (CLIENTE): NO simula reglas; sólo refleja los
 *                         snapshots del host (applySnapshot) e interpola.
 *
 *  Nada aquí toca el DOM ni el canvas → se podría ejecutar tal cual en un
 *  servidor Node.js (opción WebSockets con servidor autoritativo).
 *
 *  Comunicación hacia fuera mediante EVENTOS (this.events): explosiones,
 *  disparos, rebotes... El Renderer y el audio los consumen para efectos, y
 *  la capa de red puede reenviarlos a los clientes (van en el snapshot).
 * ============================================================================
 */
class GameState {
  constructor({ isAuthority = true } = {}) {
    this.isAuthority = isAuthority;
    this.map = new TileMap(CONFIG.MAP_LAYOUT);

    /** @type {Map<string, Tank>} */
    this.tanks = new Map();
    /** @type {Map<number, Bullet>} */
    this.bullets = new Map();
    /** @type {Map<string, object>} último InputPayload recibido por tanque */
    this.inputs = new Map();

    this.tick = 0;
    this.time = 0;
    this.round = { number: 1, phase: 'playing', timer: 0, winnerId: null };

    /** Eventos para efectos locales (Renderer / audio). Se vacían cada frame. */
    this.events = [];
    /** Eventos pendientes de enviar por red (se vacían al serializar). */
    this.netEvents = [];

    this._nextBulletId = 1;

    // Callbacks que la bala usa para notificar sucesos (evita acoplarla a GameState).
    this._bulletHooks = {
      onBounce: (b) => this.emit('bounce', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) }),
      onExpire: (b) => this.emit('bulletDestroyed', { x: MathUtil.round(b.x), y: MathUtil.round(b.y) }),
      onBlockDestroyed: (b, tx, ty) => this.emit('blockDestroyed', { tx, ty, x: MathUtil.round(b.x), y: MathUtil.round(b.y) }),
    };
  }

  // ==========================================================================
  //  GESTIÓN DE ENTIDADES
  // ==========================================================================

  /** Primer slot libre (0..9) o -1 si la partida está llena. */
  getFreeSlot() {
    const used = new Set();
    for (const t of this.tanks.values()) used.add(t.slot);
    for (let s = 0; s < CONFIG.MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return -1;
  }

  /**
   * Añade un tanque con un ID único. El slot asigna color y punto de spawn.
   * @returns {Tank|null} null si no hay hueco.
   */
  addTank({ id, name, isBot = false, slot }) {
    if (this.tanks.has(id)) return this.tanks.get(id);
    const s = slot !== undefined ? slot : this.getFreeSlot();
    if (s < 0) return null;
    const tank = new Tank({ id, name: name || CONFIG.COLORS[s].name, slot: s, isBot });
    this.tanks.set(id, tank);
    this._placeAtSpawn(tank);
    // Si se une a mitad de ronda, entra muerto y aparece en la siguiente.
    if (this.isAuthority && this.round.phase !== 'playing') tank.isAlive = false;
    this.emit('playerJoined', { id, slot: s });
    return tank;
  }

  removeTank(id) {
    if (!this.tanks.delete(id)) return;
    this.inputs.delete(id);
    for (const b of this.bullets.values()) if (b.ownerId === id) b.alive = false;
    this.emit('playerLeft', { id });
  }

  /** Registra el último input de un tanque (local, IA o recibido por red). */
  setInput(id, input) {
    this.inputs.set(id, input);
  }

  /** Coloca un tanque en su punto de aparición (rota cada ronda para variar). */
  _placeAtSpawn(tank) {
    const sp = CONFIG.SPAWN_POINTS;
    const [stx, sty] = sp[(tank.slot + this.round.number - 1) % sp.length];
    const free = this.map.findNearestFreeTile(stx, sty);
    const c = this.map.tileCenter(free.tx, free.ty);
    // Orientar el chasis hacia el centro del mapa.
    const angle = Math.atan2(this.map.height / 2 - c.y, this.map.width / 2 - c.x);
    tank.respawn(c.x, c.y, angle);
  }

  /** Registra un evento para efectos locales y para la red. */
  emit(type, data = {}) {
    const ev = Object.assign({ type }, data);
    this.events.push(ev);
    this.netEvents.push(ev);
    if (this.netEvents.length > 128) this.netEvents.shift(); // tope por si nadie los consume
  }

  /** Devuelve y vacía la cola de eventos locales. */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ==========================================================================
  //  BUCLE DE SIMULACIÓN (paso fijo)
  // ==========================================================================

  /** Avanza la simulación un paso fijo `dt`. */
  update(dt) {
    this.tick++;
    this.time += dt;

    for (const t of this.tanks.values()) t.savePrevious();
    for (const b of this.bullets.values()) b.savePrevious();

    if (!this.isAuthority) {
      this._updateReplica(dt);
      return;
    }

    this._updateTanks(dt);
    this._updateBullets(dt);
    this._updateRound(dt);
  }

  /** Cliente: sin reglas, sólo suavizado hacia los snapshots y extrapolación. */
  _updateReplica(dt) {
    for (const t of this.tanks.values()) t.applyNetSmoothing(dt);
    for (const b of this.bullets.values()) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    if (this.round.phase === 'ending') this.round.timer = Math.max(0, this.round.timer - dt);
  }

  _updateTanks(dt) {
    const R = CONFIG.TANK.RADIUS;

    // 1) Movimiento + colisión con el mapa + disparo.
    for (const tank of this.tanks.values()) {
      if (!tank.isAlive) continue;
      const input = this.inputs.get(tank.id) || NEUTRAL_INPUT;
      const ox = tank.x, oy = tank.y;

      tank.applyInput(input, dt);
      this.map.resolveCircle(tank, R);

      tank.lastMoveDistance = Math.hypot(tank.x - ox, tank.y - oy);

      if (input.fire) {
        this._tryFire(tank);
        // Consumir el disparo: si el siguiente input se retrasa (red), no se
        // repite el disparo con el input antiguo.
        input.fire = false;
      }
    }

    // 2) Colisión tanque-tanque (separación de círculos). O(n²) con n ≤ 10: trivial.
    const list = Array.from(this.tanks.values()).filter((t) => t.isAlive);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const minD = R * 2;
        if (d2 >= minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        this.map.resolveCircle(a, R);
        this.map.resolveCircle(b, R);
      }
    }
  }

  _tryFire(tank) {
    if (tank.fireCooldown > 0) return false;

    let active = 0;
    for (const b of this.bullets.values()) if (b.ownerId === tank.id && b.alive) active++;
    if (active >= CONFIG.TANK.MAX_ACTIVE_BULLETS) return false;

    const muzzle = tank.getMuzzlePosition();
    // Si la punta del cañón está dentro de un muro, no se dispara (evita atravesarlo).
    if (this.map.queryCircle(muzzle.x, muzzle.y, CONFIG.BULLET.RADIUS)) return false;
    if (!this.map.hasLineOfSight(tank.x, tank.y, muzzle.x, muzzle.y, 3)) return false;

    const bullet = new Bullet({
      id: this._nextBulletId++,
      ownerId: tank.id,
      x: muzzle.x,
      y: muzzle.y,
      angle: tank.turretAngle,
      bounces: tank.maxBounces,
    });
    this.bullets.set(bullet.id, bullet);
    tank.fireCooldown = CONFIG.TANK.FIRE_COOLDOWN;
    this.emit('shot', {
      ownerId: tank.id,
      x: MathUtil.round(muzzle.x),
      y: MathUtil.round(muzzle.y),
      angle: MathUtil.round(tank.turretAngle, 3),
    });
    return true;
  }

  _updateBullets(dt) {
    const tankR = CONFIG.TANK.RADIUS;

    for (const b of this.bullets.values()) {
      if (!b.alive) continue;

      // 1) Movimiento + rebotes contra el mapa.
      b.update(dt, this.map, this._bulletHooks);
      if (!b.alive) continue;

      // 2) Impacto contra tanques (un solo impacto destruye el tanque).
      for (const t of this.tanks.values()) {
        if (!t.isAlive) continue;
        const hitDist = tankR + b.radius;
        const d2 = MathUtil.dist2(b.x, b.y, t.x, t.y);

        if (t.id === b.ownerId && b.ownerSafe) {
          // La bala "se arma" cuando sale del cuerpo de su dueño.
          if (d2 > hitDist * hitDist) b.ownerSafe = false;
          continue;
        }
        if (d2 < hitDist * hitDist) {
          this._destroyTank(t, b.ownerId);
          b.alive = false;
          break;
        }
      }
    }

    // 3) Bala contra bala: ambas se anulan (como en Wii Tanks).
    const list = Array.from(this.bullets.values());
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const c = list[j];
        if (!c.alive) continue;
        const r = a.radius + c.radius;
        if (MathUtil.dist2(a.x, a.y, c.x, c.y) < r * r) {
          a.alive = c.alive = false;
          this.emit('bulletClash', { x: MathUtil.round((a.x + c.x) / 2), y: MathUtil.round((a.y + c.y) / 2) });
          break;
        }
      }
    }

    // 4) Limpieza.
    for (const [id, b] of this.bullets) if (!b.alive) this.bullets.delete(id);
  }

  _destroyTank(victim, killerId) {
    victim.isAlive = false;
    victim.speed = 0;
    const killer = this.tanks.get(killerId);
    if (killer && killer !== victim) killer.score++;
    this.emit('tankDestroyed', {
      victimId: victim.id,
      killerId,
      x: MathUtil.round(victim.x),
      y: MathUtil.round(victim.y),
      colorIndex: victim.colorIndex,
    });
  }

  _updateRound(dt) {
    const r = this.round;
    if (r.phase === 'playing') {
      let alive = 0, last = null;
      for (const t of this.tanks.values()) if (t.isAlive) { alive++; last = t; }
      const total = this.tanks.size;
      const over = total >= 2 ? alive <= 1 : total === 1 && alive === 0;
      if (over) {
        r.phase = 'ending';
        r.timer = CONFIG.ROUND.RESTART_DELAY;
        r.winnerId = total >= 2 && last ? last.id : null;
        if (r.winnerId) last.wins++;
        this.emit('roundEnd', { winnerId: r.winnerId });
      }
    } else if (r.phase === 'ending') {
      r.timer -= dt;
      if (r.timer <= 0) this.resetRound(true);
    }
  }

  /** Reinicia la ronda: mapa original, sin balas, todos reaparecen. */
  resetRound(advance = true) {
    if (advance) this.round.number++;
    this.round.phase = 'playing';
    this.round.timer = 0;
    this.round.winnerId = null;
    this.map.reset();
    this.bullets.clear();
    for (const t of this.tanks.values()) this._placeAtSpawn(t);
    this.emit('roundStart', { round: this.round.number });
  }

  // ==========================================================================
  //  SERIALIZACIÓN DEL ESTADO COMPLETO (snapshot de red)
  // ==========================================================================

  /**
   * Genera un snapshot serializable a JSON.
   * @param {object} [opts]
   * @param {boolean} [opts.includeMap=false] incluir el mapa completo (sólo
   *        cuando cambió o para un peer recién llegado).
   * @param {boolean} [opts.flushEvents=true] adjuntar y vaciar los eventos de red.
   */
  serialize({ includeMap = false, flushEvents = true } = {}) {
    const snap = {
      v: 1,
      tick: this.tick,
      time: MathUtil.round(this.time, 3),
      round: {
        number: this.round.number,
        phase: this.round.phase,
        timer: MathUtil.round(this.round.timer, 2),
        winnerId: this.round.winnerId,
      },
      mapRevision: this.map.revision,
      meta: [],
      tanks: [],
      bullets: [],
      events: [],
    };
    for (const t of this.tanks.values()) {
      snap.meta.push(t.serializeMeta());
      snap.tanks.push(t.serialize());
    }
    for (const b of this.bullets.values()) snap.bullets.push(b.serialize());
    if (includeMap) snap.map = this.map.serialize();
    if (flushEvents) {
      snap.events = this.netEvents;
      this.netEvents = [];
    }
    return snap;
  }

  /**
   * Aplica un snapshot recibido del host (lado CLIENTE).
   * Crea/actualiza/elimina tanques y balas para reflejar el estado remoto.
   */
  applySnapshot(snap) {
    this.tick = snap.tick;
    this.time = snap.time;

    // Ronda
    const prevRound = this.round.number;
    this.round.number = snap.round.number;
    this.round.phase = snap.round.phase;
    this.round.timer = snap.round.timer;
    this.round.winnerId = snap.round.winnerId;

    // Mapa (sólo viene cuando cambió)
    if (snap.map) this.map.deserialize(snap.map);

    // Tanques: metadatos primero (crea los que no existan).
    const seen = new Set();
    for (const meta of snap.meta) {
      let t = this.tanks.get(meta.id);
      if (!t) {
        t = new Tank({ id: meta.id, name: meta.name, slot: meta.slot, isBot: meta.isBot });
        this.tanks.set(meta.id, t);
        t._fresh = true;
      }
      t.deserializeMeta(meta);
      seen.add(meta.id);
    }
    for (const data of snap.tanks) {
      const t = this.tanks.get(data.id);
      if (!t) continue;
      const snapNow = t._fresh || prevRound !== snap.round.number;
      t.deserialize(data, !snapNow);
      t._fresh = false;
    }
    for (const id of Array.from(this.tanks.keys())) if (!seen.has(id)) this.tanks.delete(id);

    // Balas: reemplazo con reutilización de instancias.
    const seenBullets = new Set();
    for (const bd of snap.bullets) {
      const b = this.bullets.get(bd.id);
      if (b) b.deserialize(bd);
      else this.bullets.set(bd.id, Bullet.fromSnapshot(bd));
      seenBullets.add(bd.id);
    }
    for (const id of Array.from(this.bullets.keys())) if (!seenBullets.has(id)) this.bullets.delete(id);

    // Eventos remotos → efectos locales.
    if (snap.events) for (const ev of snap.events) this.events.push(ev);
  }
}

