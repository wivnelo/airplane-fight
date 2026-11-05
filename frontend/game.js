const API_BASE = window.location.protocol === "file:" ? "http://localhost:3000/api" : "/api";
const MAX_LEADERBOARD_ENTRIES = 10;

const DIFFICULTY = {
  rampDuration: 75000, // ms, time to reach max difficulty
  enemySpeed: {
    maxMultiplier: 3.4,
  },
  spawnInterval: {
    base: 880,
    min: 150,
  },
  bulletInterval: {
    base: 200,
    min: 100,
  },
};

const gameArea = document.getElementById("game-area");
const player = document.getElementById("player");
const startBtn = document.getElementById("start-btn");
const scoreEl = document.getElementById("score");
const overlay = document.getElementById("overlay");
const overlayText = document.getElementById("overlay-text");
const leaderboardList = document.getElementById("leaderboard-list");
const leaderboardStatus = document.getElementById("leaderboard-status");
const leaderboardBtn = document.getElementById("leaderboard-btn");
const backBtn = document.getElementById("back-btn");
const soundBtn = document.getElementById("sound-btn");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const gameStatus = document.getElementById("game-status");
const syncStatus = document.getElementById("sync-status");
const retryBtn = document.getElementById("retry-btn");
const pauseBtn = document.getElementById("pause-btn");
const screenTitle = document.getElementById("screen-title");
const resultScore = document.getElementById("result-score");
const recordLabel = document.getElementById("record-label");
const powerStatus = document.getElementById("power-status");
const leaderboardRetryBtn = document.getElementById("leaderboard-retry-btn");
const BEST_SCORE_KEY = "airplane.local-best.v1";
let localBest = 0;
try {
  const saved = Number(localStorage.getItem(BEST_SCORE_KEY));
  if (Number.isSafeInteger(saved) && saved > 0) localBest = saved;
} catch { /* Private browsing can disable storage; keep this session's best. */ }
const scoreClient = new ScoreClient(API_BASE, (message) => {
  syncStatus.textContent = message;
  retryBtn.hidden = scoreClient.pending.length === 0;
});

const PLAYER_WIDTH = 46;
const ENEMY_WIDTH = 40;
const BULLET_SPEED = 480; // px per second
const ENEMY_BASE_SPEED = 130; // px per second
const EXPLOSION_DURATION = 420; // ms
const BULLET_SPACING = 16;
const MAX_CLUSTER_SIZE = 3;
const POWER_UP_SIZE = 40;
const POWER_UP_FALL_SPEED = 140;
const POWER_UP_SPAWN_INTERVAL = 30000;
const POWER_UP_TYPES = [
  {
    id: "double",
    kind: "firepower",
    bulletCount: 2,
    duration: 20000,
    weight: 0.38,
    className: "powerup powerup--double",
    label: "×2",
  },
  {
    id: "triple",
    kind: "firepower",
    bulletCount: 3,
    duration: 15000,
    weight: 0.2,
    className: "powerup powerup--triple",
    label: "×3",
  },
  {
    id: "quad",
    kind: "firepower",
    bulletCount: 4,
    duration: 10000,
    weight: 0.12,
    className: "powerup powerup--quad",
    label: "×4",
  },
  {
    id: "shield",
    kind: "shield",
    duration: 5000,
    weight: 0.3,
    className: "powerup powerup--shield",
    label: "盾",
  },
];
const POWER_UP_TOTAL_WEIGHT = POWER_UP_TYPES.reduce((sum, type) => sum + type.weight, 0);

const state = {
  isRunning: false,
  isShooting: false,
  isPaused: false,
  pointerId: null,
  pointerShooting: false,
  keyboardShooting: false,
  gameTime: 1,
  run: null,
  bullets: [],
  enemies: [],
  powerUps: [],
  score: 0,
  lastEnemySpawn: 0,
  lastBulletFired: 0,
  animationFrame: null,
  playerX: 0,
  lastTime: 0,
  bounds: { width: 0, height: 0 },
  currentEnemyInterval: DIFFICULTY.spawnInterval.base,
  currentBulletInterval: DIFFICULTY.bulletInterval.base,
  enemySpeedMultiplier: 1,
  startTimestamp: null,
  leaderboard: [],
  statusTimer: null,
  audioContext: null,
  soundEnabled: true,
  difficultyProgress: 0,
  activeFirePower: null,
  firePowerExpiresAt: 0,
  hasShield: false,
  shieldExpiresAt: 0,
  lastPowerUpSpawn: 0,
  overlayMessage: "点击“开始游戏”",
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function updateBestScore() {
  document.getElementById("best-score").textContent = localBest;
  document.getElementById("leaderboard-best").textContent = localBest;
}

function setScreen(screen) {
  document.body.dataset.screen = screen;
  screenTitle.textContent = { menu: "打飞机", battle: "打飞机", paused: "稍作休息", report: "本局结束" }[screen];
  resultScore.hidden = screen !== "report";
  recordLabel.hidden = screen !== "report";
  pauseBtn.hidden = screen !== "battle";
}

function updatePowerStatus() {
  const effects = [];
  if (state.activeFirePower) effects.push(`${state.activeFirePower.bulletCount} 排火力`);
  if (state.hasShield) effects.push("护盾生效");
  powerStatus.textContent = effects.join(" · ");
  powerStatus.hidden = effects.length === 0;
}

function updateSoundButton() {
  if (!soundBtn) {
    return;
  }
  soundBtn.setAttribute("aria-pressed", state.soundEnabled ? "true" : "false");
  soundBtn.setAttribute("aria-label", state.soundEnabled ? "关闭音效" : "开启音效");
  soundBtn.classList.toggle("is-muted", !state.soundEnabled);
}

function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  if (state.soundEnabled) {
    primeAudioContext();
  }
  updateSoundButton();
}

function primeAudioContext() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (state.audioContext) {
    if (state.audioContext.state === "suspended") {
      state.audioContext.resume().catch(() => {
        /* ignored */
      });
    }
    return;
  }
  if (typeof AudioCtor !== "function") {
    return;
  }
  try {
    state.audioContext = new AudioCtor();
  } catch (error) {
    state.audioContext = null;
  }
}

function playHitSound() {
  if (!state.soundEnabled) {
    return;
  }
  primeAudioContext();
  const ctx = state.audioContext;
  if (!ctx) {
    return;
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {
      /* ignored */
    });
  }
  const now = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(640, now);
  oscillator.frequency.exponentialRampToValueAtTime(240, now + 0.22);
  gain.gain.setValueAtTime(0.18, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.3);
}

function spawnExplosion(x, y) {
  const explosion = document.createElement("div");
  explosion.className = "explosion";
  explosion.style.left = `${x}px`;
  explosion.style.top = `${y}px`;
  gameArea.appendChild(explosion);
  const remove = () => explosion.remove();
  explosion.addEventListener("animationend", remove, { once: true });
  window.setTimeout(remove, EXPLOSION_DURATION);
}

function selectPowerUpType() {
  const roll = Math.random() * POWER_UP_TOTAL_WEIGHT;
  let cumulative = 0;
  for (const type of POWER_UP_TYPES) {
    cumulative += type.weight;
    if (roll <= cumulative) {
      return type;
    }
  }
  return POWER_UP_TYPES[POWER_UP_TYPES.length - 1];
}

function spawnTimedPowerUp() {
  if (!state.bounds.width || !state.bounds.height) {
    updateBounds();
  }
  if (state.powerUps.length >= 2) {
    return;
  }
  const type = selectPowerUpType();
  const availableWidth = Math.max(state.bounds.width - POWER_UP_SIZE, 0);
  const centerX = POWER_UP_SIZE / 2 + Math.random() * availableWidth;
  const centerY = -POWER_UP_SIZE;
  spawnPowerUp(type, centerX, centerY);
}

function spawnPowerUp(type, centerX, centerY) {
  if (!type) {
    return;
  }
  if (!state.bounds.width || !state.bounds.height) {
    updateBounds();
  }
  const element = document.createElement("div");
  element.className = type.className;
  element.dataset.type = type.id;
  if (type.label) {
    const label = document.createElement("span");
    label.className = "powerup-label";
    label.textContent = type.label;
    element.append(label);
  }
  element.setAttribute(
    "aria-label",
    type.kind === "shield" ? "护盾道具" : `火力道具 ${type.label || ""}`
  );
  const clampedX = clamp(
    centerX - POWER_UP_SIZE / 2,
    6,
    Math.max(state.bounds.width - POWER_UP_SIZE - 6, 6)
  );
  const clampedY = Math.max(centerY - POWER_UP_SIZE / 2, -POWER_UP_SIZE);
  const powerUp = {
    element,
    type,
    x: clampedX,
    y: clampedY,
    speed: POWER_UP_FALL_SPEED,
  };
  element.style.left = `${powerUp.x}px`;
  element.style.top = `${powerUp.y}px`;
  gameArea.appendChild(element);
  state.powerUps.push(powerUp);
}

function spawnPowerUpBurst(x, y) {
  const burst = document.createElement("div");
  burst.className = "powerup-burst";
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  gameArea.appendChild(burst);
  burst.addEventListener("animationend", () => burst.remove(), { once: true });
  window.setTimeout(() => burst.remove(), 420);
}

function applyPowerUp(type, timestamp) {
  if (!type) {
    return;
  }
  if (type.kind === "firepower") {
    state.activeFirePower = {
      id: type.id,
      bulletCount: Math.min(type.bulletCount || 1, 4),
    };
    state.firePowerExpiresAt = timestamp + type.duration;
    setStatus(`火力提升 ${type.label}`, true);
  } else if (type.kind === "shield") {
    state.hasShield = true;
    state.shieldExpiresAt = timestamp + type.duration;
    player.classList.add("player--shield");
    setStatus("护盾已激活", true);
  }
  updatePowerStatus();
}

function getActiveBulletCount() {
  return state.activeFirePower ? state.activeFirePower.bulletCount : 1;
}

function updateActivePowerUp(timestamp) {
  if (state.activeFirePower && timestamp >= state.firePowerExpiresAt) {
    state.activeFirePower = null;
    state.firePowerExpiresAt = 0;
    updatePowerStatus();
    setStatus("火力增益结束", true);
  }
  if (state.hasShield && timestamp >= state.shieldExpiresAt) {
    state.hasShield = false;
    state.shieldExpiresAt = 0;
    player.classList.remove("player--shield");
    updatePowerStatus();
    setStatus("护盾已消失", true);
  }
}

function updatePowerUps(delta) {
  for (const powerUp of state.powerUps) {
    powerUp.y += powerUp.speed * delta;
    powerUp.element.style.top = `${powerUp.y}px`;
  }
}

function detectPowerUpCollisions(containerBox, playerBox, timestamp) {
  state.powerUps.forEach((powerUp) => {
    const rect = powerUp.element.getBoundingClientRect();
    const centerX = rect.left - containerBox.left + rect.width / 2;
    const centerY = rect.top - containerBox.top + rect.height / 2;
    const collectedByBullet = state.bullets.some((bullet) => {
      const bulletRect = bullet.element.getBoundingClientRect();
      const overlapping =
        bulletRect.bottom >= rect.top &&
        bulletRect.top <= rect.bottom &&
        bulletRect.right >= rect.left &&
        bulletRect.left <= rect.right;
      if (overlapping) {
        bullet.hit = true;
      }
      return overlapping;
    });

    if (collectedByBullet) {
      powerUp.collected = true;
      applyPowerUp(powerUp.type, timestamp);
      spawnPowerUpBurst(centerX, centerY);
      return;
    }

    if (!powerUp.collected) {
      const overlapsPlayer =
        rect.bottom >= playerBox.top &&
        rect.top <= playerBox.bottom &&
        rect.right >= playerBox.left &&
        rect.left <= playerBox.right;

      if (overlapsPlayer) {
        powerUp.collected = true;
        applyPowerUp(powerUp.type, timestamp);
        spawnPowerUpBurst(centerX, centerY);
      }
    }

    if (rect.top > containerBox.bottom) {
      powerUp.outOfBounds = true;
    }
  });
}

function cleanupPowerUps() {
  state.powerUps = state.powerUps.filter((powerUp) => {
    if (powerUp.collected || powerUp.outOfBounds) {
      powerUp.element.remove();
      return false;
    }
    return true;
  });
}

function showLeaderboard() {
  if (!leaderboardPanel || document.body.classList.contains("show-leaderboard")) {
    return;
  }
  pauseGame();
  document.body.classList.add("show-leaderboard");
  leaderboardPanel.setAttribute("aria-hidden", "false");
  backBtn.focus();
  fetchLeaderboard();
}

function hideLeaderboard() {
  if (!leaderboardPanel) {
    return;
  }
  document.body.classList.remove("show-leaderboard");
  leaderboardPanel.setAttribute("aria-hidden", "true");
  updateBounds();
  if (state.isPaused) startBtn.focus();
  else if (document.activeElement && leaderboardPanel.contains(document.activeElement)) startBtn.focus();
}

function setStatus(message = "", autoClear = false) {
  if (!gameStatus) {
    return;
  }
  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
  gameStatus.textContent = message;
  if (autoClear && message) {
    state.statusTimer = window.setTimeout(() => {
      gameStatus.textContent = "";
      state.statusTimer = null;
    }, 2200);
  }
}

function resetGame() {
  state.isRunning = false;
  state.isPaused = false;
  stopShooting();
  state.gameTime = 1;
  setStatus("");
  state.bullets.forEach((bullet) => bullet.element.remove());
  state.enemies.forEach((enemy) => enemy.element.remove());
  state.powerUps.forEach((powerUp) => powerUp.element.remove());
  state.bullets = [];
  state.enemies = [];
  state.powerUps = [];
  state.score = 0;
  scoreEl.textContent = "0";
  state.lastEnemySpawn = 0;
  state.lastBulletFired = 0;
  state.lastTime = 0;
  state.startTimestamp = null;
  state.currentEnemyInterval = DIFFICULTY.spawnInterval.base;
  state.currentBulletInterval = DIFFICULTY.bulletInterval.base;
  state.enemySpeedMultiplier = 1;
  state.difficultyProgress = 0;
  state.activeFirePower = null;
  state.firePowerExpiresAt = 0;
  state.hasShield = false;
  state.shieldExpiresAt = 0;
  state.lastPowerUpSpawn = 0;
  state.overlayMessage = "点击“开始游戏”";
  player.classList.remove("player--shield");
  gameArea.querySelectorAll(".explosion, .powerup-burst").forEach((el) => el.remove());
  if (state.animationFrame) {
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = null;
  }
  overlay.classList.remove("hidden");
  overlayText.textContent = "准备好，开始这次飞行。";
  if (syncStatus.textContent.startsWith("本局 0 分")) syncStatus.textContent = "";
  startBtn.disabled = false;
  startBtn.textContent = "开始游戏";
  setScreen("menu");
  updatePowerStatus();
}

function startGame() {
  if (state.isPaused) { resumeGame(); return; }
  resetGame();
  hideLeaderboard();
  primeAudioContext();
  updateBounds();
  overlay.classList.add("hidden");
  state.isRunning = true;
  setScreen("battle");
  state.run = scoreClient.begin();
  startBtn.disabled = true;
  state.playerX = state.bounds.width / 2 - PLAYER_WIDTH / 2;
  player.style.left = `${state.playerX}px`;
  state.animationFrame = requestAnimationFrame(update);
}

function pauseGame() {
  if (!state.isRunning || state.isPaused) return;
  state.isPaused = true;
  stopShooting();
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;
  state.lastTime = 0;
  overlayText.textContent = "已暂停，点击继续游戏";
  overlay.classList.remove("hidden");
  startBtn.textContent = "继续游戏";
  startBtn.disabled = false;
  setScreen("paused");
}

function resumeGame() {
  if (!state.isRunning || !state.isPaused || document.hidden ||
      document.body.classList.contains("show-leaderboard")) return;
  // A user gesture must also restore audio suspended while the app was away.
  if (state.soundEnabled) primeAudioContext();
  updateBounds();
  state.isPaused = false;
  setScreen("battle");
  state.lastTime = 0;
  overlay.classList.add("hidden");
  startBtn.disabled = true;
  state.animationFrame = requestAnimationFrame(update);
}

function endGame(message) {
  if (!state.isRunning) return;
  state.isRunning = false;
  state.isPaused = false;
  stopShooting();
  if (state.animationFrame) {
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = null;
  }
  state.overlayMessage = message;
  overlayText.textContent = message;
  overlay.classList.remove("hidden");
  startBtn.disabled = false;
  startBtn.textContent = "再来一局";
  const isNewBest = state.score > localBest;
  localBest = Math.max(localBest, state.score);
  try { localStorage.setItem(BEST_SCORE_KEY, String(localBest)); } catch { /* Session best remains available. */ }
  updateBestScore();
  resultScore.textContent = state.score;
  recordLabel.textContent = isNewBest ? "本机新纪录" : "每一次起飞，都是新的机会";
  setScreen("report");
  state.activeFirePower = null;
  state.firePowerExpiresAt = 0;
  state.hasShield = false;
  state.shieldExpiresAt = 0;
  player.classList.remove("player--shield");
  state.powerUps.forEach((powerUp) => powerUp.element.remove());
  state.powerUps = [];
  updatePowerStatus();

  if (state.score > 0) {
    void scoreClient.finish(state.run, state.score, state.gameTime - 1);
  } else if (!scoreClient.pending.length && !scoreClient.waiting && !scoreClient.flushing) {
    syncStatus.textContent = "本局 0 分，无需提交；再来一次吧。";
  }
}

function updateBounds() {
  const width = gameArea.clientWidth;
  const height = gameArea.clientHeight;
  if (!width || !height) return; // Hidden leaderboard must not erase game geometry.
  state.bounds.width = width;
  state.bounds.height = height;
  state.playerX = clamp(state.playerX, 0, Math.max(0, width - PLAYER_WIDTH));
  player.style.left = `${state.playerX}px`;
}

function updateDifficulty(timestamp) {
  if (state.startTimestamp === null) {
    state.startTimestamp = timestamp;
  }
  const elapsed = timestamp - state.startTimestamp;
  const progress = clamp(elapsed / DIFFICULTY.rampDuration, 0, 1);
  const eased = Math.pow(progress, 1.35); // accelerate toward the end
  state.difficultyProgress = progress;

  state.enemySpeedMultiplier = 1 + eased * (DIFFICULTY.enemySpeed.maxMultiplier - 1);
  state.currentEnemyInterval =
    DIFFICULTY.spawnInterval.base -
    eased * (DIFFICULTY.spawnInterval.base - DIFFICULTY.spawnInterval.min);
  state.currentEnemyInterval = Math.max(state.currentEnemyInterval, DIFFICULTY.spawnInterval.min);
  state.currentBulletInterval =
    DIFFICULTY.bulletInterval.base -
    eased * (DIFFICULTY.bulletInterval.base - DIFFICULTY.bulletInterval.min);
  state.currentBulletInterval = Math.max(
    state.currentBulletInterval,
    DIFFICULTY.bulletInterval.min
  );
}

function spawnEnemy() {
  const progress = state.difficultyProgress || 0;
  const baseChance = 0.18 + progress * 0.45 + state.score / 300;
  let clusterSize = 1;
  for (let i = 0; i < MAX_CLUSTER_SIZE - 1; i++) {
    const chance = Math.max(0, Math.min(1, baseChance - i * 0.2));
    if (Math.random() < chance) {
      clusterSize += 1;
    }
  }
  clusterSize = Math.min(clusterSize, MAX_CLUSTER_SIZE);
  for (let i = 0; i < clusterSize; i++) {
    spawnSingleEnemy();
  }
}

function spawnSingleEnemy() {
  const enemy = document.createElement("div");
  enemy.className = "enemy";
  const speed =
    ENEMY_BASE_SPEED * state.enemySpeedMultiplier * (0.85 + Math.random() * 0.35);
  const maxX = Math.max(state.bounds.width - ENEMY_WIDTH, 0);
  const x = Math.random() * maxX;
  const enemyObj = { element: enemy, x, y: -44, speed };
  enemy.style.left = `${x}px`;
  enemy.style.top = `${enemyObj.y}px`;
  gameArea.appendChild(enemy);
  state.enemies.push(enemyObj);
}

function fireBullet() {
  const bulletCount = getActiveBulletCount();
  const maxWidth = Math.max(state.bounds.width - 6, 6);
  const centerX = state.playerX + PLAYER_WIDTH / 2 - 2;
  const startY = state.bounds.height - 60;

  for (let i = 0; i < bulletCount; i++) {
    const offsetIndex = i - (bulletCount - 1) / 2;
    const rawX = centerX + offsetIndex * BULLET_SPACING;
    const clampedX = clamp(rawX, 4, maxWidth);
    spawnBulletAt(clampedX, startY);
  }
}

function spawnBulletAt(x, y) {
  const bullet = document.createElement("div");
  bullet.className = "bullet";
  const bulletObj = { element: bullet, x, y };
  bullet.style.left = `${x}px`;
  bullet.style.top = `${y}px`;
  gameArea.appendChild(bullet);
  state.bullets.push(bulletObj);
}

function update(frameTime) {
  state.animationFrame = null;
  if (!state.isRunning || state.isPaused) {
    return;
  }

  const frameDelta = state.lastTime ? Math.max(0, frameTime - state.lastTime) : 0;
  state.lastTime = frameTime;
  // A suspended/blocked frame must not jump entities through collision bounds.
  if (frameDelta > 250) { pauseGame(); return; }
  state.gameTime += frameDelta;
  const timestamp = state.gameTime;
  const delta = frameDelta / 1000;
  updateDifficulty(timestamp);
  updateActivePowerUp(timestamp);

  if (!state.lastPowerUpSpawn) {
    state.lastPowerUpSpawn = timestamp;
  } else if (timestamp - state.lastPowerUpSpawn >= POWER_UP_SPAWN_INTERVAL) {
    spawnTimedPowerUp();
    state.lastPowerUpSpawn = timestamp;
  }

  if (timestamp - state.lastEnemySpawn > state.currentEnemyInterval) {
    spawnEnemy();
    state.lastEnemySpawn = timestamp;
  }

  if (state.isShooting && timestamp - state.lastBulletFired > state.currentBulletInterval) {
    fireBullet();
    state.lastBulletFired = timestamp;
  }

  const containerBox = gameArea.getBoundingClientRect();
  const playerBox = player.getBoundingClientRect();

  // Small collision steps prevent fast entities tunnelling past each other on a slow frame.
  const steps = Math.max(1, Math.ceil(delta * 60));
  for (let step = 0; step < steps; step++) {
    updateBullets(delta / steps);
    updateEnemies(delta / steps);
    updatePowerUps(delta / steps);
    detectCollisions(containerBox, playerBox);
    if (!state.isRunning) return;
    detectPowerUpCollisions(containerBox, playerBox, timestamp);
    cleanupEntities();
    cleanupPowerUps();
  }

  state.animationFrame = requestAnimationFrame(update);
}

function updateBullets(delta) {
  for (const bullet of state.bullets) {
    bullet.y -= BULLET_SPEED * delta;
    bullet.element.style.top = `${bullet.y}px`;
  }
}

function updateEnemies(delta) {
  for (const enemy of state.enemies) {
    enemy.y += enemy.speed * delta;
    enemy.element.style.top = `${enemy.y}px`;
  }
}

function detectCollisions(containerBox, playerBox) {
  const playerLeft = playerBox.left;
  const playerRight = playerBox.right;
  const playerTop = playerBox.top;

  state.enemies.forEach((enemy) => {
    if (!state.isRunning) return;
    const enemyRect = enemy.element.getBoundingClientRect();

    if (!enemy.hit) {
      const isHitByBullet = state.bullets.some((bullet) => {
        const bulletRect = bullet.element.getBoundingClientRect();
        const overlapping =
          bulletRect.bottom >= enemyRect.top &&
          bulletRect.top <= enemyRect.bottom &&
          bulletRect.right >= enemyRect.left &&
          bulletRect.left <= enemyRect.right;
        if (overlapping) {
          bullet.hit = true;
        }
        return overlapping;
      });

      if (isHitByBullet) {
        enemy.hit = true;
        state.score += 1;
        scoreEl.textContent = `${state.score}`;
        const centerX = enemyRect.left - containerBox.left + enemyRect.width / 2;
        const centerY = enemyRect.top - containerBox.top + enemyRect.height / 2;
        spawnExplosion(centerX, centerY);
        playHitSound();
      }
    }

    if (!enemy.hit) {
      const overlapsPlayer =
        enemyRect.bottom >= playerTop &&
        enemyRect.top <= playerTop + player.offsetHeight &&
        enemyRect.right >= playerLeft &&
        enemyRect.left <= playerRight;

      if (overlapsPlayer) {
        if (state.hasShield) {
          enemy.hit = true;
          state.score += 1;
          scoreEl.textContent = `${state.score}`;
          const centerX = enemyRect.left - containerBox.left + enemyRect.width / 2;
          const centerY = enemyRect.top - containerBox.top + enemyRect.height / 2;
          spawnExplosion(centerX, centerY);
          playHitSound();
        } else {
          endGame("被撞到了，下次再试！");
        }
      }
    }

    if (enemyRect.top > containerBox.bottom) {
      enemy.outOfBounds = true;
    }
  });
}

function cleanupEntities() {
  state.bullets = state.bullets.filter((bullet) => {
    if (bullet.hit || bullet.y < -20) {
      bullet.element.remove();
      return false;
    }
    return true;
  });

  state.enemies = state.enemies.filter((enemy) => {
    if (enemy.hit || enemy.outOfBounds) {
      enemy.element.remove();
      return false;
    }
    return true;
  });
}

function handlePointerMove(clientX) {
  if (!state.isRunning || state.isPaused) {
    return;
  }
  const rect = gameArea.getBoundingClientRect();
  const xWithin = clientX - rect.left - gameArea.clientLeft;
  const clamped = clamp(xWithin - PLAYER_WIDTH / 2, 0, state.bounds.width - PLAYER_WIDTH);
  state.playerX = clamped;
  player.style.left = `${clamped}px`;
}

function refreshShooting() {
  state.isShooting = state.isRunning && !state.isPaused &&
    (state.pointerShooting || state.keyboardShooting);
}

function handleKeyDown(event) {
  if (!state.isRunning || state.isPaused || event.code !== "Space" ||
      event.target.closest("button, input, textarea, select")) return;
  primeAudioContext();
  state.keyboardShooting = true;
  refreshShooting();
  event.preventDefault();
}

function handleKeyUp(event) {
  if (event.code === "Space") {
    state.keyboardShooting = false;
    refreshShooting();
  }
}

function stopShooting() {
  const pointerId = state.pointerId;
  state.pointerId = null;
  state.pointerShooting = false;
  state.keyboardShooting = false;
  state.isShooting = false;
  if (pointerId !== null && gameArea.hasPointerCapture(pointerId)) gameArea.releasePointerCapture(pointerId);
}

function releasePointer(event) {
  if (event.pointerId !== state.pointerId) return;
  state.pointerId = null;
  state.pointerShooting = false;
  refreshShooting();
}

async function fetchLeaderboard() {
  if (!leaderboardList) {
    return;
  }
  if (leaderboardList.getAttribute("aria-busy") === "true") return;
  leaderboardList.setAttribute("aria-busy", "true");
  leaderboardRetryBtn.hidden = true;
  leaderboardStatus.textContent = state.leaderboard.length ? "正在刷新，当前显示上次取得的成绩…" : "排行榜加载中…";
  if (!state.leaderboard.length) {
    leaderboardList.replaceChildren();
    const loading = document.createElement("li");
    loading.className = "empty";
    loading.textContent = "正在获取飞行记录…";
    leaderboardList.append(loading);
  }
  try {
    const payload = await scoreClient.request("/leaderboard");
    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : Array.isArray(payload)
      ? payload
      : [];
    state.leaderboard = entries.slice(0, MAX_LEADERBOARD_ENTRIES);
    renderLeaderboard();
    leaderboardStatus.textContent = "";
  } catch (error) {
    if (!state.leaderboard.length) {
      renderLeaderboard();
      leaderboardList.firstElementChild.textContent = "飞行记录暂时不可用";
    }
    leaderboardStatus.textContent = state.leaderboard.length
      ? "刷新失败，正在显示上次取得的成绩，排名可能已变化。"
      : "暂时无法获取榜单，不影响你再飞一局。";
    leaderboardRetryBtn.hidden = false;
  } finally {
    leaderboardList.setAttribute("aria-busy", "false");
  }
}

function renderLeaderboard(entries = state.leaderboard) {
  if (!leaderboardList) {
    return;
  }
  leaderboardList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "暂无飞行记录，下一次突破从你开始。";
    leaderboardList.append(empty);
    return;
  }
  entries.forEach((entry, index) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "pilot-name";
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(index + 1).padStart(2, "0");
    const displayName = entry.displayName || entry.name || "匿名飞行员";
    label.textContent = displayName;
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = entry.score;
    li.append(rank, label, score);
    leaderboardList.append(li);
  });
}

startBtn.addEventListener("click", () => { startGame(); startBtn.blur(); });
pauseBtn.addEventListener("click", () => { pauseGame(); startBtn.focus(); });
document.getElementById("overlay-leaderboard-btn").addEventListener("click", showLeaderboard);
leaderboardRetryBtn.addEventListener("click", () => { void fetchLeaderboard(); });
gameArea.addEventListener("pointerdown", (event) => {
  if (!state.isRunning || state.isPaused || !event.isPrimary || event.button !== 0 ||
      event.target.closest("button")) return;
  event.preventDefault();
  state.pointerId = event.pointerId;
  state.pointerShooting = true;
  primeAudioContext();
  gameArea.setPointerCapture(event.pointerId);
  handlePointerMove(event.clientX);
  refreshShooting();
});
gameArea.addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse" || event.pointerId === state.pointerId) handlePointerMove(event.clientX);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  gameArea.addEventListener(type, releasePointer);
}
window.addEventListener("blur", pauseGame);
document.addEventListener("visibilitychange", () => { if (document.hidden) pauseGame(); });
window.addEventListener("online", () => { void scoreClient.flush(); });
retryBtn.addEventListener("click", () => { void scoreClient.flush(); });
window.addEventListener("beforeunload", (event) => {
  if (scoreClient.pending.length || scoreClient.waiting) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("resize", updateBounds);
window.addEventListener("keydown", handleKeyDown);
window.addEventListener("keyup", handleKeyUp);

if (leaderboardBtn) {
  leaderboardBtn.addEventListener("click", showLeaderboard);
}
if (backBtn) {
  backBtn.addEventListener("click", hideLeaderboard);
}
if (soundBtn) {
  soundBtn.addEventListener("click", toggleSound);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("show-leaderboard")) {
    hideLeaderboard();
  }
});

renderLeaderboard();
updateBestScore();
fetchLeaderboard();
updateSoundButton();
hideLeaderboard();
resetGame();

void scoreClient.flush();
