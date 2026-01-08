import { SphereSnakeGame } from './sphereGame.js';

const appEl = document.getElementById('app');
const scoreEl = document.getElementById('score-val');
const bestEl = document.getElementById('best-val');
const finalScoreEl = document.getElementById('final-score');
const gameOverModal = document.getElementById('game-over-modal');
const restartBtn = document.getElementById('restart-btn');

const btnCpu = document.getElementById('btn-cpu');
const btnMulti = document.getElementById('btn-multi');

// Game instance
const game = new SphereSnakeGame({
  container: appEl,
  onScore: (s) => {
    if (scoreEl) scoreEl.textContent = s;
    if (finalScoreEl) finalScoreEl.textContent = s;
  },
  onBest: (b) => {
    if (bestEl) bestEl.textContent = b;
  },
  onGameOver: () => {
    gameOverModal.classList.add('visible');
  }
});

// UI Logic
btnCpu.addEventListener('click', () => {
  btnCpu.classList.add('active');
  btnMulti.classList.remove('active');
  game.setMode('cpu');
  resetUI();
});

btnMulti.addEventListener('click', () => {
  btnMulti.classList.add('active');
  btnCpu.classList.remove('active');
  game.setMode('realtime');
  resetUI();
});

restartBtn.addEventListener('click', () => {
  game.restart();
  resetUI();
});

function resetUI() {
  gameOverModal.classList.remove('visible');
}

window.addEventListener('resize', () => game.resize());

game.start();