'use strict';
/**
 * ============================================================================
 *  skins.js — Personalización del tanque y el misil con imágenes del usuario.
 * ============================================================================
 *  Desde el menú ("Personalizar") el jugador puede subir una imagen para su
 *  tanque y otra para su misil. Las imágenes se guardan como data URL en
 *  localStorage, así la personalización sobrevive al recargar la página.
 *
 *  El Renderer consulta `window.TankSkins` en cada frame:
 *    - tank:    HTMLImageElement | null  → se dibuja girado hacia la torreta
 *    - missile: HTMLImageElement | null  → se dibuja girado hacia el rumbo
 *  Si alguna es null (o todavía no cargó), se usa el dibujo original.
 *
 *  Nota multijugador: la personalización es LOCAL. Cada jugador ve su propio
 *  tanque/misil personalizado en su pantalla; los demás se ven con el dibujo
 *  clásico. No se envía ninguna imagen por la red.
 * ============================================================================
 */

/** Imágenes activas (las usa renderer.js). */
const TankSkins = { tank: null, missile: null };
window.TankSkins = TankSkins;

const SKIN_STORAGE_KEYS = { tank: 'tanks-skin-tank-v1', missile: 'tanks-skin-missile-v1' };
const SKIN_MAX_BYTES = 2 * 1024 * 1024; // 2 MB máximo por imagen

function _loadSkinImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = dataUrl;
  });
}

async function _applySkin(kind, dataUrl) {
  const img = await _loadSkinImage(dataUrl);
  TankSkins[kind] = img;
  _updateSkinPreview(kind, dataUrl);
  try {
    if (dataUrl.length <= SKIN_MAX_BYTES * 1.4) {
      localStorage.setItem(SKIN_STORAGE_KEYS[kind], dataUrl);
    }
  } catch (_) { /* almacenamiento lleno o no disponible: no pasa nada */ }
}

function _clearSkin(kind) {
  TankSkins[kind] = null;
  try { localStorage.removeItem(SKIN_STORAGE_KEYS[kind]); } catch (_) {}
  _updateSkinPreview(kind, null);
}

function _updateSkinPreview(kind, dataUrl) {
  const img = document.getElementById(`skin-${kind}-preview`);
  if (!img) return;
  if (dataUrl) { img.src = dataUrl; img.classList.add('visible'); }
  else { img.removeAttribute('src'); img.classList.remove('visible'); }
}

function _onSkinFile(kind, file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Elige un archivo de imagen.'); return; }
  if (file.size > SKIN_MAX_BYTES) { alert('La imagen es muy pesada (máx. 2 MB).'); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try { await _applySkin(kind, reader.result); }
    catch (e) { alert('No se pudo cargar esa imagen.'); }
  };
  reader.readAsDataURL(file);
}

document.addEventListener('DOMContentLoaded', () => {
  // Restaurar la personalización guardada en sesiones anteriores.
  for (const kind of ['tank', 'missile']) {
    try {
      const saved = localStorage.getItem(SKIN_STORAGE_KEYS[kind]);
      if (saved) _applySkin(kind, saved).catch(() => {});
    } catch (_) {}
  }

  // Inputs del menú.
  const tankInput = document.getElementById('skin-tank');
  const missileInput = document.getElementById('skin-missile');
  if (tankInput) tankInput.addEventListener('change', () => _onSkinFile('tank', tankInput.files[0]));
  if (missileInput) missileInput.addEventListener('change', () => _onSkinFile('missile', missileInput.files[0]));

  const resetBtn = document.getElementById('btn-skins-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    _clearSkin('tank');
    _clearSkin('missile');
    if (tankInput) tankInput.value = '';
    if (missileInput) missileInput.value = '';
  });
});
