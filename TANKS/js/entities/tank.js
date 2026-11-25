'use strict';
/**
 * ============================================================================
 *  entities/tank.js — Entidad Tanque.
 * ============================================================================
 *  Contiene SOLO estado y física local del tanque. No sabe dibujarse (eso es
 *  responsabilidad del Renderer) ni sabe de dónde vienen sus inputs (teclado,
 *  IA o red: ver controllers.js). Esta separación es la que permite que el
 *  mismo objeto funcione en el host (simulado) y en un cliente (replicado).
 *
 *  Formato de input que consume (InputPayload):
 *    {
 *      seq:      number,  // nº de secuencia incremental (útil para reconciliación)
 *      throttle: -1|0|1,  // W = +1 (avanzar), S = -1 (retroceder)
 *      turn:     -1|0|1,  // D = +1 (horario), A = -1 (antihorario)
 *      aimAngle: number,  // ángulo absoluto de la torreta en radianes
 *      fire:     boolean  // disparo (flanco: true sólo un tick)
 *    }
 * ============================================================================
 */

/** Input neutro (tanque quieto) — se usa cuando no hay input disponible. */
const NEUTRAL_INPUT = Object.freeze({ seq: 0, throttle: 0, turn: 0, aimAngle: 0, fire: false });

class Tank {
  /**
   * @param {object} opts
   * @param {string} opts.id         identificador único (p. ej. el peerId de red)
   * @param {string} opts.name       nombre visible
   * @param {number} opts.slot       0..9: define color y punto de aparición
   * @param {boolean} [opts.isBot]
   */
  constructor({ id, name, slot, isBot = false }) {
    this.id = id;
    this.name = name;
    this.slot = slot;
    this.colorIndex = slot % CONFIG.COLORS.length;
    this.isBot = isBot;

    // --- Estado replicado por red (ver serialize) ---
    this.x = 0;
    this.y = 0;
    this.chassisAngle = 0;
    this.turretAngle = 0;
    this.isAlive = true;

    // --- Estado de simulación (sólo lo necesita quien simula: el host) ---
    this.speed = 0;            // px/s a lo largo de chassisAngle (negativa = marcha atrás)
    this.angularVelocity = 0;  // rad/s
    this.fireCooldown = 0;
    this.maxBounces = CONFIG.BULLET.DEFAULT_BOUNCES;
    this.lastMoveDistance = 0; // px recorridos en el último tick (útil para la IA)

    // --- Puntuación / metadatos ---
    this.score = 0;  // bajas
    this.wins = 0;   // rondas ganadas

    // --- Interpolación de render (entre dos ticks fijos) ---
    this.prevX = 0;
    this.prevY = 0;
    this.prevChassisAngle = 0;
    this.prevTurretAngle = 0;

    // --- Objetivo de red (en clientes, ver deserialize/applyNetSmoothing) ---
    this.netTarget = null;
  }

  get color() {
    return CONFIG.COLORS[this.colorIndex];
  }

  /** Coloca el tanque en una posición y lo revive. */
  respawn(x, y, angle) {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.chassisAngle = this.prevChassisAngle = angle;
    this.turretAngle = this.prevTurretAngle = angle;
    this.speed = 0;
    this.angularVelocity = 0;
    this.fireCooldown = 0.5;
    this.isAlive = true;
    this.netTarget = null;
  }

  /** Guarda el estado anterior para interpolar el render entre ticks. */
  savePrevious() {
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevChassisAngle = this.chassisAngle;
    this.prevTurretAngle = this.turretAngle;
  }

  /**
   * Integra la física de movimiento (sin colisiones: las resuelve GameState).
   * Movimiento tipo "tanque": W/S avanzan/retroceden en la dirección del
   * chasis y A/D rotan el chasis, con aceleración y fricción suaves.
   */
  applyInput(input, dt) {
    const T = CONFIG.TANK;

    // 1) Rotación del chasis: la velocidad angular persigue a la deseada.
    // CORREGIDO: TURN_RESPONSE faltaba en config.js y producía NaN en el primer tick.
    const targetAngVel = MathUtil.clamp(input.turn, -1, 1) * T.MAX_TURN_SPEED;
    const turnResponse = (typeof T.TURN_RESPONSE === 'number' && isFinite(T.TURN_RESPONSE)) ? T.TURN_RESPONSE : 12;
    this.angularVelocity += (targetAngVel - this.angularVelocity) * Math.min(1, turnResponse * dt);
    this.chassisAngle = MathUtil.wrapAngle(this.chassisAngle + this.angularVelocity * dt);

    // 2) Velocidad lineal con aceleración / frenado / fricción.
    const throttle = MathUtil.clamp(input.throttle, -1, 1);
    if (throttle !== 0) {
      const maxSpeed = throttle > 0 ? T.MAX_SPEED : T.MAX_SPEED * T.REVERSE_FACTOR;
      const target = throttle * maxSpeed;
      const braking = Math.sign(target) !== Math.sign(this.speed) && this.speed !== 0;
      this.speed = MathUtil.approach(this.speed, target, (braking ? T.BRAKE : T.ACCELERATION) * dt);
    } else {
      this.speed *= Math.exp(-T.FRICTION * dt);
      if (Math.abs(this.speed) < 1) this.speed = 0;
    }

    // 3) Integración de posición.
    this.x += Math.cos(this.chassisAngle) * this.speed * dt;
    this.y += Math.sin(this.chassisAngle) * this.speed * dt;

    // 4) Torreta: independiente del chasis, apunta al ángulo solicitado.
    this.turretAngle = MathUtil.wrapAngle(input.aimAngle);

    // 5) Enfriamiento del arma.
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
  }

  /** Punto de salida del proyectil (punta del cañón). */
  getMuzzlePosition() {
    const d = CONFIG.TANK.BARREL_LENGTH + CONFIG.BULLET.RADIUS;
    return {
      x: this.x + Math.cos(this.turretAngle) * d,
      y: this.y + Math.sin(this.turretAngle) * d,
    };
  }

  // ==========================================================================
  //  SERIALIZACIÓN (orientada a red)
  // ==========================================================================

  /**
   * Estado dinámico mínimo para replicar por red (se envía ~20 veces/seg).
   * Los números se redondean para reducir el tamaño del paquete.
   */
  serialize() {
    return {
      id: this.id,
      x: MathUtil.round(this.x, 1),
      y: MathUtil.round(this.y, 1),
      chassisAngle: MathUtil.round(this.chassisAngle, 3),
      turretAngle: MathUtil.round(this.turretAngle, 3),
      isAlive: this.isAlive,
    };
  }

  /** Metadatos que cambian poco (nombre, color, marcador). */
  serializeMeta() {
    return {
      id: this.id,
      name: this.name,
      slot: this.slot,
      isBot: this.isBot,
      score: this.score,
      wins: this.wins,
      maxBounces: this.maxBounces,
    };
  }

  /**
   * Aplica un estado recibido desde el exterior (red).
   * @param {object} data      resultado de serialize() de otro peer
   * @param {boolean} interpolate
   *    true  → se guarda como objetivo y applyNetSmoothing() se acerca a él
   *            suavemente en cada tick (oculta la baja frecuencia de snapshots).
   *    false → "snap": se refleja el estado inmediatamente.
   */
  deserialize(data, interpolate = true) {
    const wasAlive = this.isAlive;
    this.isAlive = data.isAlive;

    // Teletransporte (respawn) o primer paquete → no interpolar.
    const farAway = MathUtil.dist2(this.x, this.y, data.x, data.y) > 80 * 80;
    if (!interpolate || farAway || (!wasAlive && data.isAlive)) {
      this.x = this.prevX = data.x;
      this.y = this.prevY = data.y;
      this.chassisAngle = this.prevChassisAngle = data.chassisAngle;
      this.turretAngle = this.prevTurretAngle = data.turretAngle;
      this.netTarget = null;
      return;
    }
    this.netTarget = {
      x: data.x,
      y: data.y,
      chassisAngle: data.chassisAngle,
      turretAngle: data.turretAngle,
    };
  }

  /** Aplica metadatos recibidos por red. */
  deserializeMeta(meta) {
    this.name = meta.name;
    this.slot = meta.slot;
    this.colorIndex = meta.slot % CONFIG.COLORS.length;
    this.isBot = meta.isBot;
    this.score = meta.score;
    this.wins = meta.wins;
    this.maxBounces = meta.maxBounces;
  }

  /**
   * Interpolación exponencial hacia el último estado recibido por red.
   * Independiente del framerate gracias a 1 - e^(-k·dt).
   *
   * RETO ALUMNOS (avanzado): sustituir por "entity interpolation" con buffer
   * de snapshots y renderizar ~100 ms en el pasado (técnica de Valve/Source),
   * y para el tanque propio aplicar predicción + reconciliación usando `seq`.
   */
  applyNetSmoothing(dt) {
    if (!this.netTarget) return;
    const t = 1 - Math.exp(-15 * dt);
    this.x = MathUtil.lerp(this.x, this.netTarget.x, t);
    this.y = MathUtil.lerp(this.y, this.netTarget.y, t);
    this.chassisAngle = MathUtil.wrapAngle(MathUtil.lerpAngle(this.chassisAngle, this.netTarget.chassisAngle, t));
    // La torreta se refleja casi directamente para que el apuntado se sienta preciso.
    this.turretAngle = MathUtil.wrapAngle(MathUtil.lerpAngle(this.turretAngle, this.netTarget.turretAngle, Math.min(1, t * 2)));
  }
}

