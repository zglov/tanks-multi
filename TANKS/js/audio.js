'use strict';
/**
 * ============================================================================
 *  audio.js — Efectos de sonido sintetizados con WebAudio (sin archivos).
 * ============================================================================
 *  Los navegadores exigen un gesto del usuario para iniciar el audio: Game
 *  llama a unlock() al pulsar "Jugar".
 * ============================================================================
 */
class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noise = null;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.25;
      this.master.connect(this.ctx.destination);
      // Buffer de ruido blanco reutilizable (explosiones).
      const len = this.ctx.sampleRate * 0.6;
      this._noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this._noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  _tone(type, f0, f1, duration, gain = 0.5) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + duration);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  _burst(duration, freq, gain = 0.8) {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration);
  }

  play(name) {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    switch (name) {
      case 'shot': this._tone('square', 520, 140, 0.09, 0.25); break;
      case 'bounce': this._tone('triangle', 1100, 700, 0.05, 0.25); break;
      case 'block': this._burst(0.18, 2500, 0.5); break;
      case 'clash': this._tone('sine', 1500, 300, 0.08, 0.3); break;
      case 'explosion': this._burst(0.55, 1200, 1.0); this._tone('sine', 120, 40, 0.4, 0.6); break;
      case 'round': this._tone('square', 440, 880, 0.25, 0.2); break;
      default: break;
    }
  }
}

