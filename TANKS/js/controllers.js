'use strict';
/**
 * ============================================================================
 *  controllers.js — Fuentes de input intercambiables.
 * ============================================================================
 *  Un "controlador" es cualquier objeto con:
 *        getInput(state: GameState, dt: number) → InputPayload
 *
 *  El GameState no distingue si un tanque lo maneja un humano local, una IA o
 *  un jugador remoto: todos producen exactamente el mismo InputPayload.
 *  Esto es la clave para añadir multijugador: un jugador remoto es sólo un
 *  RemoteController alimentado por paquetes de red.
 * ============================================================================
 */

/** Jugador local: teclado (W/A/S/D) + ratón (apuntar y disparar). */
class KeyboardMouseController {
  constructor(input, tankId) {
    this.input = input;
    this.tankId = tankId;
    this.seq = 0;
  }

  getInput(state) {
    const k = this.input;
    const tank = state.tanks.get(this.tankId);
    const throttle = (k.isDown('KeyW') || k.isDown('ArrowUp') ? 1 : 0) - (k.isDown('KeyS') || k.isDown('ArrowDown') ? 1 : 0);
    const turn = (k.isDown('KeyD') || k.isDown('ArrowRight') ? 1 : 0) - (k.isDown('KeyA') || k.isDown('ArrowLeft') ? 1 : 0);
    const aimAngle = tank ? Math.atan2(k.mouse.y - tank.y, k.mouse.x - tank.x) : 0;
    return {
      seq: ++this.seq,
      throttle,
      turn,
      aimAngle: MathUtil.round(aimAngle, 3),
      fire: k.consumeFire(),
    };
  }
}

/**
 * Jugador remoto: guarda el último InputPayload llegado por la red.
 * RETO ALUMNOS: alimentarlo desde Game._handleNetMessage() con los paquetes
 * NET_MSG.INPUT de cada peer (ya está cableado; sólo falta el transporte).
 */
class RemoteController {
  constructor(tankId) {
    this.tankId = tankId;
    this.lastInput = Object.assign({}, NEUTRAL_INPUT);
    this.lastSeq = 0;
    this.lastReceivedAt = 0;
    this._pendingFire = false;
  }

  /** Llamado al recibir un paquete INPUT. Descarta paquetes viejos/desordenados. */
  pushInput(payload, now) {
    this.lastReceivedAt = now;
    if (payload.fire) this._pendingFire = true; // no perder disparos aunque el paquete llegue tarde
    if (payload.seq <= this.lastSeq) return;    // UDP-like: paquetes fuera de orden
    this.lastSeq = payload.seq;
    this.lastInput = {
      seq: payload.seq,
      throttle: MathUtil.clamp(payload.throttle | 0, -1, 1), // ¡nunca confiar en el cliente!
      turn: MathUtil.clamp(payload.turn | 0, -1, 1),
      aimAngle: Number.isFinite(payload.aimAngle) ? payload.aimAngle : 0,
      fire: false,
    };
  }

  getInput() {
    const out = Object.assign({}, this.lastInput);
    out.fire = this._pendingFire;
    this._pendingFire = false;
    return out;
  }
}

/**
 * Bot sencillo para poder jugar en local: deambula, evita muros, apunta al
 * enemigo más cercano y dispara cuando tiene línea de visión.
 */
class AIController {
  constructor(tankId, { aimSpeed = 2.4, reaction = [0.7, 1.6] } = {}) {
    this.tankId = tankId;
    this.seq = 0;
    this.aimSpeed = aimSpeed;
    this.reaction = reaction;
    this.aim = 0;
    this.fireTimer = MathUtil.randRange(1, 2);
    this.wanderTimer = 0;
    this.wanderTurn = 0;
    this.wanderThrottle = 1;
    this.avoidDir = 1;
    this.stuckTime = 0;
    this.reverseTime = 0;
  }

  getInput(state, dt) {
    const me = state.tanks.get(this.tankId);
    if (!me || !me.isAlive) return { seq: ++this.seq, throttle: 0, turn: 0, aimAngle: this.aim, fire: false };

    // --- Objetivo: enemigo vivo más cercano ---
    let target = null, best = Infinity;
    for (const t of state.tanks.values()) {
      if (t === me || !t.isAlive) continue;
      const d2 = MathUtil.dist2(me.x, me.y, t.x, t.y);
      if (d2 < best) { best = d2; target = t; }
    }

    let fire = false;
    this.fireTimer -= dt;
    if (target) {
      const desired = Math.atan2(target.y - me.y, target.x - me.x);
      this.aim = MathUtil.wrapAngle(MathUtil.rotateTowards(this.aim, desired, this.aimSpeed * dt));
      const aligned = Math.abs(MathUtil.angleDiff(this.aim, desired)) < 0.09;
      if (aligned && this.fireTimer <= 0 && state.map.hasLineOfSight(me.x, me.y, target.x, target.y)) {
        fire = true;
        this.fireTimer = MathUtil.randRange(this.reaction[0], this.reaction[1]);
      }
    } else {
      this.aim = MathUtil.wrapAngle(this.aim + dt * 0.8);
    }

    // --- Movimiento: deambular ---
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = MathUtil.randRange(0.6, 2.0);
      const r = Math.random();
      this.wanderTurn = r < 0.3 ? -1 : r < 0.6 ? 1 : 0;
      this.wanderThrottle = Math.random() < 0.85 ? 1 : 0;
    }
    let throttle = this.wanderThrottle;
    let turn = this.wanderTurn;

    // --- Evitar muros: sonda delante del chasis ---
    const probe = CONFIG.TANK.RADIUS + 16;
    const px = me.x + Math.cos(me.chassisAngle) * probe;
    const py = me.y + Math.sin(me.chassisAngle) * probe;
    if (state.map.isSolidAt(px, py)) {
      turn = this.avoidDir;
      throttle = 0.4 > Math.random() ? 1 : 0;
    } else if (Math.random() < 0.005) {
      this.avoidDir = -this.avoidDir;
    }

    // --- Atascado: retroceder un momento ---
    if (throttle !== 0 && me.lastMoveDistance < 0.3) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.4) {
      this.reverseTime = 0.5;
      this.stuckTime = 0;
      this.avoidDir = Math.random() < 0.5 ? -1 : 1;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      throttle = -1;
      turn = this.avoidDir;
    }

    return { seq: ++this.seq, throttle, turn, aimAngle: MathUtil.round(this.aim, 3), fire };
  }
}

