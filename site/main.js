// The hero's two-button remote: OK plays, Back returns home, like on the TV.
const home = /** @type {HTMLImageElement} */ (document.getElementById('screen-home'));
const player = /** @type {HTMLImageElement} */ (document.getElementById('screen-player'));
const caption = /** @type {HTMLElement} */ (document.getElementById('demo-caption'));

/** @param {boolean} playing */
function show(playing) {
  home.hidden = playing;
  player.hidden = !playing;
  caption.textContent = playing ? 'Playing. Back always returns home.' : 'Press OK on the remote.';
}

document.getElementById('key-ok')?.addEventListener('click', () => show(true));
document.getElementById('key-back')?.addEventListener('click', () => show(false));
