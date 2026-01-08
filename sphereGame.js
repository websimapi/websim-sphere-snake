import * as THREE from 'three';

const GRID_LAT = 24;
const GRID_LON = 48;
const RADIUS = 11;
const TICK_MS = 120;

const MODES = {
  CPU: 'cpu',
  REALTIME: 'realtime',
};

export class SphereSnakeGame {
  constructor({ container, onScoreChange, onBestChange }) {
    this.container = container;
    this.onScoreChange = onScoreChange || (() => {});
    this.onBestChange = onBestChange || (() => {});
    this.mode = MODES.CPU;
    this.score = 0;
    this.best = 0;

    this._initScene();
    this._initLogic();
    this._initControls();
    this._initMultiplayer();
    this._initHighScore();
  }

  /* ---------- Core setup ---------- */

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#050608');

    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 160);
    this.camera.position.set(0, 18, 28);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    const ambient = new THREE.AmbientLight('#9fb8ff', 0.5);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight('#ffffff', 0.9);
    dir.position.set(4, 7, 2);
    this.scene.add(dir);

    // Sphere world
    const sphereGeo = new THREE.SphereGeometry(RADIUS, 48, 32);
    const sphereMat = new THREE.MeshStandardMaterial({
      color: '#111621',
      roughness: 0.9,
      metalness: 0.0,
      wireframe: false,
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    this.scene.add(sphere);
    this.worldSphere = sphere;

    // Subtle grid effect
    const gridLines = new THREE.Group();
    const gridMaterial = new THREE.LineBasicMaterial({ color: '#171c2a', linewidth: 1 });
    for (let i = 1; i < GRID_LAT; i++) {
      const lat = (i / GRID_LAT) * Math.PI - Math.PI / 2;
      const latGeo = new THREE.BufferGeometry();
      const segments = 64;
      const positions = [];
      for (let j = 0; j <= segments; j++) {
        const lon = (j / segments) * Math.PI * 2;
        const pos = latLonToVec3(lat, lon, RADIUS + 0.001);
        positions.push(pos.x, pos.y, pos.z);
      }
      latGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      gridLines.add(new THREE.Line(latGeo, gridMaterial));
    }
    for (let j = 0; j < GRID_LON; j++) {
      const lon = (j / GRID_LON) * Math.PI * 2;
      const lonGeo = new THREE.BufferGeometry();
      const segments = 64;
      const positions = [];
      for (let i = 0; i <= segments; i++) {
        const lat = (i / segments) * Math.PI - Math.PI / 2;
        const pos = latLonToVec3(lat, lon, RADIUS + 0.001);
        positions.push(pos.x, pos.y, pos.z);
      }
      lonGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      gridLines.add(new THREE.Line(lonGeo, gridMaterial));
    }
    this.scene.add(gridLines);

    // Snake group
    this.snakeGroup = new THREE.Group();
    this.scene.add(this.snakeGroup);

    // Food mesh
    const foodGeo = new THREE.SphereGeometry(0.25, 16, 12);
    const foodMat = new THREE.MeshStandardMaterial({
      color: '#ff4b6a',
      emissive: '#ff4b6a',
      emissiveIntensity: 0.5,
      roughness: 0.4,
      metalness: 0.2,
    });
    this.foodMesh = new THREE.Mesh(foodGeo, foodMat);
    this.scene.add(this.foodMesh);

    // Other players' snakes for realtime mode
    this.otherSnakesGroup = new THREE.Group();
    this.scene.add(this.otherSnakesGroup);

    this._renderLoop = this._renderLoop.bind(this);
  }

  _initLogic() {
    this.tickTimer = 0;
    this.lastTime = performance.now();

    this.direction = { lat: 0, lon: 1 }; // grid step
    this.pendingDir = { lat: 0, lon: 1 };

    this.snake = {
      segments: {}, // key: index -> { latIndex, lonIndex }
      length: 6,
      headLat: Math.floor(GRID_LAT / 2),
      headLon: Math.floor(GRID_LON / 4),
      color: '#2fffd2',
    };

    for (let i = 0; i < this.snake.length; i++) {
      this.snake.segments[String(i)] = {
        latIndex: this.snake.headLat,
        lonIndex: (this.snake.headLon - i + GRID_LON) % GRID_LON,
      };
    }

    this._rebuildSnakeMeshes();

    this._spawnFood();

    this.cpuSnake = {
      segments: {},
      length: 6,
      headLat: Math.floor(GRID_LAT / 2),
      headLon: Math.floor((3 * GRID_LON) / 4),
      color: '#ffcf40',
    };
    for (let i = 0; i < this.cpuSnake.length; i++) {
      this.cpuSnake.segments[String(i)] = {
        latIndex: this.cpuSnake.headLat,
        lonIndex: (this.cpuSnake.headLon + i) % GRID_LON,
      };
    }
    this._rebuildCpuSnakeMeshes();

    this.cpuDir = { lat: 0, lon: -1 };

    this.isDead = false;
  }

  _initControls() {
    this.keys = { w: false, a: false, s: false, d: false };
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(k)) {
        this.keys[k] = true;
        this._updateDirectionFromKeys();
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd'].includes(k)) {
        this.keys[k] = false;
      }
    });

    // Tap / click to change direction
    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      this._updateDirectionFromTap(event);
    });
  }

  _initMultiplayer() {
    this.room = new WebsimSocket();
    this.room.initialize().then(() => {
      this._subscribePresence();
      this._syncPresence();
    });
  }

  _subscribePresence() {
    this.room.subscribePresence((presence) => {
      if (this.mode !== MODES.REALTIME) return;
      this._updateOtherSnakesFromPresence(presence);
    });
  }

  _syncPresence() {
    if (!this.room) return;
    const packedSnake = packSnake(this.snake);
    this.room.updatePresence({
      mode: this.mode,
      snake: packedSnake,
      score: this.score,
    });
  }

  _initHighScore() {
    this.highScoreCollection = null;
    this.highScoreRecordId = null;
    this._loadHighScore();
  }

  async _loadHighScore() {
    try {
      const room = this.room || new WebsimSocket();
      await room.initialize?.();
      this.highScoreCollection = room.collection('sphere_snake_highscore_v1');

      const existing = this.highScoreCollection.getList();
      if (existing && existing.length > 0) {
        const record = existing[0];
        this.highScoreRecordId = record.id;
        this.best = record.bestScore || 0;
        this.onBestChange(this.best);
      } else {
        const record = await this.highScoreCollection.create({
          bestScore: 0,
          bestMode: MODES.CPU,
        });
        this.highScoreRecordId = record.id;
        this.best = 0;
        this.onBestChange(0);
      }

      this.highScoreCollection.subscribe((records) => {
        if (!records || records.length === 0) return;
        const rec = records[0];
        this.highScoreRecordId = rec.id;
        const val = rec.bestScore || 0;
        if (val !== this.best) {
          this.best = val;
          this.onBestChange(this.best);
        }
      });
    } catch (err) {
      console.error('High score init failed', err);
    }
  }

  async _saveHighScoreIfNeeded() {
    if (!this.highScoreCollection || !this.highScoreRecordId) return;
    if (this.score <= this.best) return;
    try {
      this.best = this.score;
      this.onBestChange(this.best);
      await this.highScoreCollection.update(this.highScoreRecordId, {
        bestScore: this.best,
        bestMode: this.mode,
      });
    } catch (err) {
      console.error('High score update failed', err);
    }
  }

  /* ---------- Public API ---------- */

  start() {
    this.lastTime = performance.now();
    requestAnimationFrame(this._renderLoop);
  }

  handleResize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._resetGame();
    this._syncPresence();
  }

  /* ---------- Game loop ---------- */

  _renderLoop(now) {
    const dt = now - this.lastTime;
    this.lastTime = now;
    this.tickTimer += dt;

    while (this.tickTimer >= TICK_MS) {
      this.tickTimer -= TICK_MS;
      this._tick();
    }

    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this._renderLoop);
  }

  _tick() {
    if (this.isDead) {
      this._resetGame();
      return;
    }

    // Apply pending direction
    this.direction = this.pendingDir;

    this._moveSnake(this.snake, this.direction);
    if (this.mode === MODES.CPU) {
      this._updateCpuDirection();
      this._moveSnake(this.cpuSnake, this.cpuDir);
    }

    // Food collection
    if (this._snakeHeadEqualsFood(this.snake)) {
      this.score += 1;
      this.onScoreChange(this.score);
      this.snake.length += 1;
      this._spawnFood();
      this._saveHighScoreIfNeeded();
    }

    if (this.mode === MODES.CPU && this._snakeHeadEqualsFood(this.cpuSnake)) {
      this.cpuSnake.length += 1;
      this._spawnFood();
    }

    // Collisions
    if (this._checkSelfCollision(this.snake) || this._checkOutOfBounds(this.snake)) {
      this.isDead = true;
    }

    if (this.mode === MODES.CPU) {
      if (this._checkSnakeCollision(this.snake, this.cpuSnake)) {
        this.isDead = true;
      }
    }

    this._updateSnakeMeshes();
    if (this.mode === MODES.CPU) {
      this._updateCpuSnakeMeshes();
    } else {
      this._updatePresenceSnakeOnly();
    }
  }

  _resetGame() {
    this.score = 0;
    this.onScoreChange(0);
    this.isDead = false;

    this.direction = { lat: 0, lon: 1 };
    this.pendingDir = { lat: 0, lon: 1 };

    this.snake.length = 6;
    this.snake.headLat = Math.floor(GRID_LAT / 2);
    this.snake.headLon = Math.floor(GRID_LON / 4);
    this.snake.segments = {};
    for (let i = 0; i < this.snake.length; i++) {
      this.snake.segments[String(i)] = {
        latIndex: this.snake.headLat,
        lonIndex: (this.snake.headLon - i + GRID_LON) % GRID_LON,
      };
    }

    this.cpuSnake.length = 6;
    this.cpuSnake.headLat = Math.floor(GRID_LAT / 2);
    this.cpuSnake.headLon = Math.floor((3 * GRID_LON) / 4);
    this.cpuSnake.segments = {};
    for (let i = 0; i < this.cpuSnake.length; i++) {
      this.cpuSnake.segments[String(i)] = {
        latIndex: this.cpuSnake.headLat,
        lonIndex: (this.cpuSnake.headLon + i) % GRID_LON,
      };
    }
    this.cpuDir = { lat: 0, lon: -1 };

    this._rebuildSnakeMeshes();
    this._rebuildCpuSnakeMeshes();
    this._spawnFood();
    this._syncPresence();
  }

  /* ---------- Snake logic ---------- */

  _moveSnake(snake, dir) {
    const newHeadLat = clamp(
      snake.headLat + dir.lat,
      0,
      GRID_LAT - 1
    );
    let newHeadLon = (snake.headLon + dir.lon + GRID_LON) % GRID_LON;

    const newHead = { latIndex: newHeadLat, lonIndex: newHeadLon };
    // Shift body
    const newSegments = {};
    newSegments['0'] = newHead;
    const maxIdx = snake.length - 1;
    for (let i = 1; i < snake.length; i++) {
      const from = snake.segments[String(i - 1)];
      if (!from) break;
      newSegments[String(i)] = { latIndex: from.latIndex, lonIndex: from.lonIndex };
    }
    snake.segments = newSegments;
    snake.headLat = newHeadLat;
    snake.headLon = newHeadLon;
  }

  _snakeHeadEqualsFood(snake) {
    return snake.headLat === this.foodLat && snake.headLon === this.foodLon;
  }

  _checkSelfCollision(snake) {
    for (let i = 1; i < snake.length; i++) {
      const seg = snake.segments[String(i)];
      if (!seg) continue;
      if (seg.latIndex === snake.headLat && seg.lonIndex === snake.headLon) {
        return true;
      }
    }
    return false;
  }

  _checkSnakeCollision(player, other) {
    for (let i = 0; i < other.length; i++) {
      const seg = other.segments[String(i)];
      if (!seg) continue;
      if (seg.latIndex === player.headLat && seg.lonIndex === player.headLon) {
        return true;
      }
    }
    return false;
  }

  _checkOutOfBounds(snake) {
    return snake.headLat < 0 || snake.headLat >= GRID_LAT;
  }

  _updateCpuDirection() {
    const dLat = Math.sign(this.foodLat - this.cpuSnake.headLat);
    const dLon = shortestLonDir(this.cpuSnake.headLon, this.foodLon, GRID_LON);

    let tryDir = { lat: 0, lon: 0 };
    if (Math.abs(dLat) > 0) {
      tryDir = { lat: dLat, lon: 0 };
    } else if (dLon !== 0) {
      tryDir = { lat: 0, lon: dLon };
    }

    if (!this._wouldCollide(this.cpuSnake, tryDir)) {
      this.cpuDir = tryDir;
    } else {
      const options = [
        { lat: 0, lon: 1 },
        { lat: 0, lon: -1 },
        { lat: 1, lon: 0 },
        { lat: -1, lon: 0 },
      ].filter((o) => !(o.lat === -this.cpuDir.lat && o.lon === -this.cpuDir.lon));

      for (const o of options) {
        if (!this._wouldCollide(this.cpuSnake, o)) {
          this.cpuDir = o;
          break;
        }
      }
    }
  }

  _wouldCollide(snake, dir) {
    const lat = snake.headLat + dir.lat;
    const lon = (snake.headLon + dir.lon + GRID_LON) % GRID_LON;
    if (lat < 0 || lat >= GRID_LAT) return true;
    for (let i = 0; i < snake.length; i++) {
      const seg = snake.segments[String(i)];
      if (!seg) continue;
      if (seg.latIndex === lat && seg.lonIndex === lon) {
        return true;
      }
    }
    return false;
  }

  _spawnFood() {
    this.foodLat = Math.floor(Math.random() * GRID_LAT);
    this.foodLon = Math.floor(Math.random() * GRID_LON);
    const pos = cellToWorld(this.foodLat, this.foodLon);
    this.foodMesh.position.copy(pos);
  }

  /* ---------- Input helpers ---------- */

  _updateDirectionFromKeys() {
    const { w, a, s, d } = this.keys;
    let dir = null;
    if (w) dir = { lat: -1, lon: 0 };
    else if (s) dir = { lat: 1, lon: 0 };
    else if (a) dir = { lat: 0, lon: -1 };
    else if (d) dir = { lat: 0, lon: 1 };
    if (!dir) return;
    if (dir.lat === -this.direction.lat && dir.lon === -this.direction.lon) return;
    this.pendingDir = dir;
  }

  _updateDirectionFromAngle(angleDeg) {
    // kept for potential future use; not used now
  }

  _updateDirectionFromTap(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;

    let dir = null;
    if (Math.abs(dx) > Math.abs(dy)) {
      // horizontal tap: left/right
      dir = dx > 0 ? { lat: 0, lon: 1 } : { lat: 0, lon: -1 };
    } else {
      // vertical tap: up/down
      dir = dy > 0 ? { lat: 1, lon: 0 } : { lat: -1, lon: 0 };
    }

    if (!dir) return;
    if (dir.lat === -this.direction.lat && dir.lon === -this.direction.lon) return;
    this.pendingDir = dir;
  }

  /* ---------- Mesh updates ---------- */

  _rebuildSnakeMeshes() {
    this.snakeGroup.clear();
    this.snakeMeshes = {};
    const mat = new THREE.MeshStandardMaterial({
      color: this.snake.color,
      emissive: this.snake.color,
      emissiveIntensity: 0.4,
      roughness: 0.3,
      metalness: 0.2,
    });
    const headMat = mat.clone();
    headMat.emissiveIntensity = 0.8;
    const geo = new THREE.SphereGeometry(0.32, 16, 12);

    for (let i = 0; i < this.snake.length; i++) {
      const segMesh = new THREE.Mesh(geo, i === 0 ? headMat : mat);
      this.snakeGroup.add(segMesh);
      this.snakeMeshes[String(i)] = segMesh;
    }
    this._updateSnakeMeshes();
  }

  _updateSnakeMeshes() {
    for (let i = 0; i < this.snake.length; i++) {
      const seg = this.snake.segments[String(i)];
      const mesh = this.snakeMeshes[String(i)];
      if (!seg || !mesh) continue;
      const pos = cellToWorld(seg.latIndex, seg.lonIndex);
      mesh.position.copy(pos);
    }
    this._syncPresence();
  }

  _rebuildCpuSnakeMeshes() {
    if (!this.cpuGroup) {
      this.cpuGroup = new THREE.Group();
      this.scene.add(this.cpuGroup);
    } else {
      this.cpuGroup.clear();
    }
    this.cpuMeshes = {};
    const mat = new THREE.MeshStandardMaterial({
      color: this.cpuSnake.color,
      emissive: this.cpuSnake.color,
      emissiveIntensity: 0.25,
      roughness: 0.6,
      metalness: 0.1,
    });
    const geo = new THREE.SphereGeometry(0.28, 12, 10);

    for (let i = 0; i < this.cpuSnake.length; i++) {
      const segMesh = new THREE.Mesh(geo, mat);
      this.cpuGroup.add(segMesh);
      this.cpuMeshes[String(i)] = segMesh;
    }
    this._updateCpuSnakeMeshes();
  }

  _updateCpuSnakeMeshes() {
    for (let i = 0; i < this.cpuSnake.length; i++) {
      const seg = this.cpuSnake.segments[String(i)];
      const mesh = this.cpuMeshes[String(i)];
      if (!seg || !mesh) continue;
      const pos = cellToWorld(seg.latIndex, seg.lonIndex);
      mesh.position.copy(pos);
    }
  }

  _updateCamera() {
    if (!this.snake) return;
    const headPos = cellToWorld(this.snake.headLat, this.snake.headLon);
    const normal = headPos.clone().normalize();
    const desiredPos = headPos.clone().add(normal.multiplyScalar(7));
    // smooth follow
    this.camera.position.lerp(desiredPos, 0.15);
    this.camera.lookAt(headPos);
  }

  /* ---------- Realtime presence rendering ---------- */

  _updatePresenceSnakeOnly() {
    if (!this.room) return;
    this._syncPresence();
  }

  _updateOtherSnakesFromPresence(presence) {
    if (!this.room) return;
    const clientId = this.room.clientId;
    this.otherSnakesGroup.clear();

    Object.entries(presence || {}).forEach(([id, p]) => {
      if (id === clientId) return;
      if (!p || p.mode !== MODES.REALTIME || !p.snake) return;
      const snakeObj = unpackSnake(p.snake);
      const group = new THREE.Group();
      const color = '#5b8cff';
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.25,
        roughness: 0.4,
      });
      const geo = new THREE.SphereGeometry(0.28, 12, 10);
      for (let i = 0; i < snakeObj.length; i++) {
        const seg = snakeObj.segments[String(i)];
        if (!seg) continue;
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(cellToWorld(seg.latIndex, seg.lonIndex));
        group.add(mesh);
      }
      this.otherSnakesGroup.add(group);
    });
  }
}

/* ---------- Helpers ---------- */

function latLonToVec3(latRad, lonRad, radius) {
  const y = Math.sin(latRad) * radius;
  const x = Math.cos(latRad) * Math.cos(lonRad) * radius;
  const z = Math.cos(latRad) * Math.sin(lonRad) * radius;
  return new THREE.Vector3(x, y, z);
}

function cellToWorld(latIndex, lonIndex) {
  const lat = ((latIndex + 0.5) / GRID_LAT) * Math.PI - Math.PI / 2;
  const lon = ((lonIndex + 0.5) / GRID_LON) * Math.PI * 2;
  return latLonToVec3(lat, lon, RADIUS + 0.02);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function shortestLonDir(from, to, max) {
  const diff = ((to - from + max) % max);
  if (diff === 0) return 0;
  return diff <= max / 2 ? 1 : -1;
}

function packSnake(snake) {
  const segmentsObj = {};
  Object.keys(snake.segments).forEach((k) => {
    const seg = snake.segments[k];
    segmentsObj[k] = { la: seg.latIndex, lo: seg.lonIndex };
  });
  return {
    length: snake.length,
    headLat: snake.headLat,
    headLon: snake.headLon,
    segments: segmentsObj,
  };
}

function unpackSnake(data) {
  const segments = {};
  Object.keys(data.segments || {}).forEach((k) => {
    const seg = data.segments[k];
    segments[k] = { latIndex: seg.la, lonIndex: seg.lo };
  });
  return {
    length: data.length,
    headLat: data.headLat,
    headLon: data.headLon,
    segments,
  };
}