'use strict';
/**
 * ============================================================================
 *  input.js — Captura de teclado y ratón (sólo lado local, depende del DOM).
 * ============================================================================
 *  InputManager únicamente registra el estado crudo de los dispositivos.
 *  La traducción a un InputPayload (formato de red) la hace
 *  KeyboardMouseController en controllers.js.
 * ============================================================================
 */
class InputManager {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this._pressed = new Set();       // teclas pulsadas desde la última consulta (flanco)
    this.mouse = { x: canvas.width / 2, y: canvas.height / 2, inside: false };
    this._fireQueued = false;
    this.mouseHeld = false;

    window.addEventListener('keydown', (e) => {
      // No capturar teclas mientras se escribe en un formulario (menú).
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (this._isGameKey(e.code)) e.preventDefault();
      if (!e.repeat) this._pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' && !e.repeat) this._fireQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseHeld = false; });

    window.addEventListener('mousemove', (e) => this._updateMouse(e));
    canvas.addEventListener('mousedown', (e) => {
      this._updateMouse(e);
      if (e.button === 0) {
        this._fireQueued = true;
        this.mouseHeld = true;
      }
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseHeld = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mouseenter', () => { this.mouse.inside = true; });
    canvas.addEventListener('mouseleave', () => { this.mouse.inside = false; });
  }

  _isGameKey(code) {
    return code === 'Space' || code.startsWith('Arrow');
  }

  /** Convierte coordenadas de pantalla a coordenadas del mundo (canvas escalado por CSS). */
  _updateMouse(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    this.mouse.x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
    this.mouse.y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
  }

  isDown(code) {
    return this.keys.has(code);
  }

  /** true una sola vez por pulsación (para toggles como pausa o debug). */
  consumePressed(code) {
    if (!this._pressed.has(code)) return false;
    this._pressed.delete(code);
    return true;
  }

  /** Devuelve true si hubo un clic de disparo pendiente y lo consume. */
  consumeFire() {
    const f = this._fireQueued;
    this._fireQueued = false;
    return f;
  }

  /** Descarta pulsaciones de flanco no consumidas (se llama al final del frame). */
  endFrame() {
    this._pressed.clear();
  }
}
