'use strict';
/**
 * ============================================================================
 *  config.js — Parámetros globales y "tunables" del juego.
 * ============================================================================
 *  Todo valor numérico que afecte a la jugabilidad vive aquí. Esto es
 *  importante para el multijugador: host y clientes DEBEN compartir la misma
 *  configuración, de lo contrario las simulaciones divergen.
 *
 *  Unidades: píxeles (px), segundos (s) y radianes (rad).
 *  Convención de ángulos: 0 rad = mirando a la derecha (+X), crecen en sentido
 *  horario porque el eje Y del canvas apunta hacia abajo.
 * ============================================================================
 */
const CONFIG = Object.freeze({
  /** Tamaño de cada celda del mapa en px. */
  TILE_SIZE: 40,

  /** Paso fijo de simulación (60 Hz). La lógica SIEMPRE avanza en pasos de este tamaño. */
  FIXED_DT: 1 / 60,

  /** Máximo dt real aceptado por frame (evita la "espiral de la muerte" tras cambiar de pestaña). */
  MAX_FRAME_DT: 0.25,

  /** Límite de jugadores concurrentes (local + bots + remotos). */
  MAX_PLAYERS: 10,

  /** Frecuencia (Hz) con la que el host emite snapshots del GameState por la red. */
  NET_SEND_RATE: 20,

  /** Segundos sin recibir inputs de un peer antes de considerarlo desconectado. */
  NET_PEER_TIMEOUT: 5,

  TANK: Object.freeze({
    RADIUS: 15,            // radio de colisión (círculo)
    BODY_LENGTH: 32,       // largo visual del chasis
    BODY_WIDTH: 26,        // ancho visual del chasis
    BARREL_LENGTH: 22,     // largo del cañón desde el centro
    MAX_SPEED: 130,        // px/s velocidad máxima (en cualquier dirección)
    REVERSE_FACTOR: 0.72,  // factor en marcha atrás (modo diferencial clásico)
    ACCELERATION: 560,     // px/s² al acelerar (respuesta ágil y progresiva)
    BRAKE: 780,            // px/s² al invertir la marcha o frenar
    FRICTION: 8.5,         // decaimiento exponencial suave al soltar teclas (1/s)
    LATERAL_GRIP: 14,      // agarre lateral de las orugas (reduce derrape al girar)
    MAX_TURN_SPEED: 3.4,   // rad/s de giro del chasis
    TURN_ACCEL: 24,        // rad/s² aceleración angular suave (sin latigazos)
    TURN_FRICTION: 18,     // amortiguación angular al soltar giro (1/s)
    TURN_RESPONSE: 12,     // 1/s tasa de respuesta angular (CORREGIDO: faltaba y producía NaN)
    TURRET_SLEW_SPEED: 16, // rad/s velocidad máxima de seguimiento de la torreta
    TURRET_SMOOTHING: 22,  // suavizado exponencial de la torreta hacia el cursor
    FIRE_COOLDOWN: 0.22,   // s entre disparos
    MAX_ACTIVE_BULLETS: 5, // balas simultáneas por tanque (como en Wii Tanks)
    /**
     * Modo de conducción por defecto:
     *  - 'omni' : W/A/S/D mueven en las 8 direcciones de pantalla (estilo Wii Tanks
     *             con Nunchuk/cruceta) y el chasis rota suavemente hacia el rumbo,
     *             con inversión inteligente de marcha si el destino queda detrás.
     *  - 'tank' : W/S avanzan/retroceden según el chasis y A/D rotan las orugas,
     *             con inercia rotacional y agarre lateral suave.
     *  Se puede alternar en vivo con la tecla C.
     */
    DEFAULT_DRIVE_MODE: 'omni',
  }),

  BULLET: Object.freeze({
    SPEED: 250,            // px/s, constante durante toda la vida del proyectil
    RADIUS: 4,
    DEFAULT_BOUNCES: 1,    // rebotes permitidos antes de destruirse (1 o 2)
    MAX_BOUNCES: 2,
    MAX_LIFETIME: 12,      // s, red de seguridad
    SUBSTEP_PX: 3,         // distancia máxima por sub-paso (anti-tunneling)
  }),

  ROUND: Object.freeze({
    RESTART_DELAY: 3,      // s entre el fin de una ronda y la siguiente
  }),

  /**
   * Paleta de 10 colores diferenciados: uno por "slot" de jugador.
   * El slot (0..9) determina color y punto de aparición → IDs únicos y colores
   * únicos para hasta 10 tanques simultáneos.
   */
  COLORS: Object.freeze([
    { name: 'Azul',     body: '#3b6fd8', dark: '#22448f', light: '#86a9f0' },
    { name: 'Rojo',     body: '#d8433b', dark: '#8f2620', light: '#f08c86' },
    { name: 'Verde',    body: '#3fa34d', dark: '#24652d', light: '#89d493' },
    { name: 'Amarillo', body: '#e3b62b', dark: '#9a7a12', light: '#f5d980' },
    { name: 'Morado',   body: '#8a4fd1', dark: '#55298c', light: '#bc95ec' },
    { name: 'Naranja',  body: '#ee7a26', dark: '#a14c0f', light: '#f6b27f' },
    { name: 'Cian',     body: '#25b5c4', dark: '#137782', light: '#80dbe4' },
    { name: 'Rosa',     body: '#e05aa8', dark: '#97306c', light: '#f0a1cf' },
    { name: 'Gris',     body: '#7d8590', dark: '#4a5058', light: '#b8bec6' },
    { name: 'Marrón',   body: '#9a6a3c', dark: '#5f3e1e', light: '#c9a07a' },
  ]),

  /**
   * Mapa cerrado (22 × 16 celdas → 880 × 640 px).
   *   '#' = bloque indestructible
   *   'x' = bloque destructible (se rompe con un impacto de bala)
   *   '.' = suelo
   * Los alumnos pueden editarlo libremente; el host lo envía en el snapshot.
   */
  MAP_LAYOUT: Object.freeze([
    '######################',
    '#....................#',
    '#....x..........x....#',
    '#..###..x....x..###..#',
    '#..#..............#..#',
    '#..#...##....##...#..#',
    '#.....x#......#x.....#',
    '#xx......x..x......xx#',
    '#xx......x..x......xx#',
    '#.....x#......#x.....#',
    '#..#...##....##...#..#',
    '#..#..............#..#',
    '#..###..x....x..###..#',
    '#....x..........x....#',
    '#....................#',
    '######################',
  ]),

  /** 10 puntos de aparición (en coordenadas de celda), uno por slot. */
  SPAWN_POINTS: Object.freeze([
    [1, 1], [20, 14], [20, 1], [1, 14], [10, 4],
    [11, 11], [5, 8], [16, 7], [6, 14], [15, 1],
  ]),
});

