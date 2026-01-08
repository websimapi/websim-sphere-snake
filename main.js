import { SphereSnakeGame } from './sphereGame.js';

const appEl = document.getElementById('app');
const scoreEl = document.getElementById('score-value');
const bestEl = document.getElementById('best-value');
const modeCpuBtn = document.getElementById('mode-cpu');
const modeRtBtn = document.getElementById('mode-rt');

const game = new SphereSnakeGame({
  container: appEl,
  onScoreChange: (score) => {
    if (scoreEl) scoreEl.textContent = String(score);
  },
  onBestChange: (best) => {
    if (bestEl) bestEl.textContent = String(best);
  },
});

modeCpuBtn.addEventListener('click', () => {
  modeCpuBtn.classList.add('active');
  modeRtBtn.classList.remove('active');
  game.setMode('cpu');
});

modeRtBtn.addEventListener('click', () => {
  modeRtBtn.classList.add('active');
  modeCpuBtn.classList.remove('active');
  game.setMode('realtime');
});

// Resize handling
window.addEventListener('resize', () => game.handleResize());

// Start
game.start();