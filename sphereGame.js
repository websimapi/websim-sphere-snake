import * as THREE from 'three';

const GRID_LAT = 40;
const GRID_LON = 80;
const RADIUS = 25;
const TICK_MS = 110;

const MODES = {
  CPU: 'cpu',
  REALTIME: 'realtime',
};

/**
 * Visual Interpolation Helper
 * Since the game is grid-based, visual smoothness comes from interpolating
 * position between `lastGridPos` and `currentGridPos` over the `TICK_MS` duration.
 */

export class SphereSnakeGame {
  constructor({ container, onScore, onBest, onGameOver }) {
    this.container = container;
    this.onScore = onScore || (() => {});
    this.onBest = onBest || (() => {});
    this.onGameOver = onGameOver || (() => {});
    
    this.mode = MODES.CPU;
    this.score = 0;
    this.best = 0;
    this.isRunning = false;

    this._initScene();
    this._initLogic();
    this._initInput();
    this._initNetworking();
    this._initHighScore();
  }

  _initScene() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    // SCENE
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#030305');
    this.scene.fog = new THREE.FogExp2(0x030305, 0.015);

    // CAMERA
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
    this.camera.position.set(0, 0, 60);

    // RENDERER
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    // LIGHTING
    const ambient = new THREE.AmbientLight(0xffffff, 0.2);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xff0080, 0x0080ff, 0.3);
    this.scene.add(hemi);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(20, 30, 20);
    dirLight.castShadow = true;
    this.scene.add(dirLight);

    // PLANET
    const planetGeo = new THREE.SphereGeometry(RADIUS, 64, 64);
    const planetMat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0e,
      roughness: 0.6,
      metalness: 0.2,
    });
    this.planet = new THREE.Mesh(planetGeo, planetMat);
    this.planet.receiveShadow = true;
    this.scene.add(this.planet);

    // NEON GRID
    // We create a slightly larger wireframe sphere
    const gridGeo = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(RADIUS + 0.1, 4));
    const gridMat = new THREE.LineBasicMaterial({ color: 0x1f2b3e, opacity: 0.3, transparent: true });
    this.gridMesh = new THREE.LineSegments(gridGeo, gridMat);
    this.scene.add(this.gridMesh);

    // SNAKE CONTAINERS
    this.snakeGroup = new THREE.Group();
    this.scene.add(this.snakeGroup);
    
    this.opponentGroup = new THREE.Group();
    this.scene.add(this.opponentGroup);

    // FOOD
    const foodGeo = new THREE.OctahedronGeometry(0.5, 0);
    const foodMat = new THREE.MeshStandardMaterial({
      color: 0xff0055,
      emissive: 0xff0055,
      emissiveIntensity: 1,
    });
    this.foodMesh = new THREE.Mesh(foodGeo, foodMat);
    
    // Add point light to food
    this.foodLight = new THREE.PointLight(0xff0055, 2, 8);
    this.foodMesh.add(this.foodLight);
    this.scene.add(this.foodMesh);

    // Bind loop
    this._loop = this._loop.bind(this);
  }

  _initLogic() {
    this.clock = new THREE.Clock();
    this.tickTimer = 0;
    this.inputQueue = [];
    
    // Default Snake State
    this.snake = {
      segments: [], 
      dir: { lat: 0, lon: 1 },
      color: 0x00ffcc
    };
    
    // CPU Snake State
    this.cpuSnake = {
      segments: [],
      dir: { lat: 0, lon: 1 },
      color: 0xffaa00
    };
  }

  _initInput() {
    // Tap Zones
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const rect = this.renderer.domElement.getBoundingClientRect();
      const x = e.clientX - rect.left;
      
      // Tap Left half or Right half
      if (x < rect.width / 2) {
        this._queueTurn('left');
      } else {
        this._queueTurn('right');
      }
    });

    // Keys
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a') this._queueTurn('left');
      if (e.key === 'ArrowRight' || e.key === 'd') this._queueTurn('right');
    });
  }

  _queueTurn(action) {
    // Allow buffering up to 2 inputs to prevent sticky feel but avoid massive queues
    if (this.inputQueue.length < 2) {
      this.inputQueue.push(action);
    }
  }

  _initNetworking() {
    this.room = new WebsimSocket();
    this.room.initialize().then(() => {
      this.room.subscribePresence((p) => {
        if (this.mode === MODES.REALTIME) this._updateOpponents(p);
      });
      this._sync();
    });
  }

  _initHighScore() {
    this._loadHighScore();
  }

  /* ---------------- API ---------------- */

  start() {
    this.reset();
    this.isRunning = true;
    this.renderer.setAnimationLoop(this._loop);
  }

  restart() {
    this.reset();
    this.isRunning = true;
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  setMode(m) {
    this.mode = m;
    this.restart();
  }

  /* ---------------- LOOP ---------------- */

  _loop() {
    const dt = this.clock.getDelta();
    
    if (this.isRunning) {
      this.tickTimer += dt * 1000;
      
      // Fixed tick updates
      while (this.tickTimer >= TICK_MS) {
        this.tickTimer -= TICK_MS;
        this._tick();
      }
      
      // Interpolation factor (0 to 1)
      const alpha = this.tickTimer / TICK_MS;
      
      // Smooth movement updates
      this._updateVisuals(alpha);
      this._processInput();
      this._updateCamera();
    }
    
    // Rotate background/planet slightly
    this.gridMesh.rotation.y += dt * 0.05;

    this.renderer.render(this.scene, this.camera);
  }

  /* ---------------- LOGIC ---------------- */

  reset() {
    this.score = 0;
    this.onScore(0);
    this.tickTimer = 0;
    this.inputQueue = [];
    
    // Init Player
    this.snake.dir = { lat: 0, lon: 1 };
    this.snake.segments = [];
    
    const startLat = Math.floor(GRID_LAT / 2);
    const startLon = Math.floor(GRID_LON / 4);
    
    for (let i = 0; i < 5; i++) {
      this.snake.segments.push({
        lat: startLat,
        lon: (startLon - i + GRID_LON) % GRID_LON,
        visualPos: new THREE.Vector3(), // For interpolation
        currPos: new THREE.Vector3(),
        prevPos: new THREE.Vector3()
      });
    }

    // Init CPU
    this.cpuSnake.dir = { lat: 0, lon: -1 };
    this.cpuSnake.segments = [];
    const cpuLat = Math.floor(GRID_LAT / 2);
    const cpuLon = Math.floor(GRID_LON * 0.75);
    
    for (let i = 0; i < 5; i++) {
      this.cpuSnake.segments.push({
        lat: cpuLat,
        lon: (cpuLon + i) % GRID_LON,
        visualPos: new THREE.Vector3(),
        currPos: new THREE.Vector3(),
        prevPos: new THREE.Vector3()
      });
    }

    // Init visual meshes immediately
    this._rebuildMeshes(this.snake, this.snakeGroup);
    if (this.mode === MODES.CPU) {
      this._rebuildMeshes(this.cpuSnake, this.opponentGroup);
    } else {
      this.opponentGroup.clear();
    }

    this._spawnFood();
    this._sync();
  }

  _tick() {
    // 1. Process Input
    if (this.inputQueue.length > 0) {
      const turn = this.inputQueue.shift();
      this._applyRelativeTurn(this.snake, turn);
    }

    // 2. Move Player
    this._moveSnake(this.snake);

    // 3. Move CPU
    if (this.mode === MODES.CPU) {
      this._aiThink(this.cpuSnake);
      this._moveSnake(this.cpuSnake);
    }

    // 4. Collision Checks
    if (this._checkCollisions(this.snake)) {
      this.isRunning = false;
      this.onGameOver();
      return;
    }
    
    if (this.mode === MODES.CPU && this._checkCollisions(this.cpuSnake, true)) {
       this._respawnCpu();
    }

    // 5. Food Logic
    if (this._checkFood(this.snake)) {
      this._growSnake(this.snake);
      this.score++;
      this.onScore(this.score);
      this._saveHighScoreIfNeeded();
      this._spawnFood();
    }
    
    if (this.mode === MODES.CPU && this._checkFood(this.cpuSnake)) {
      this._growSnake(this.cpuSnake);
      this._spawnFood();
    }

    // 6. Sync Visuals
    this._updateSegmentTargets(this.snake);
    if (this.mode === MODES.CPU) this._updateSegmentTargets(this.cpuSnake);

    // 7. Network
    this._sync();
  }

  _applyRelativeTurn(snake, turn) {
    const { lat, lon } = snake.dir;
    // Relative logic:
    // Left: Lat-> -Lon, Lon-> Lat
    // Right: Lat-> Lon, Lon-> -Lat
    if (turn === 'left') {
      snake.dir = { lat: -lon, lon: lat };
    } else if (turn === 'right') {
      snake.dir = { lat: lon, lon: -lat };
    }
  }

  _moveSnake(snake) {
    const head = snake.segments[0];
    let newLat = head.lat + snake.dir.lat;
    let newLon = (head.lon + snake.dir.lon + GRID_LON) % GRID_LON;
    
    // Pole Crossing Logic
    // If we go off the top (Lat < 0) or bottom (Lat >= GRID_LAT), we cross to the other side
    // The "Other Side" is (Lon + GRID_LON/2)
    // And our Latitude direction flips (North becomes South)
    
    if (newLat < 0) {
      // Crossed North Pole
      newLat = 0;
      newLon = (newLon + GRID_LON / 2) % GRID_LON;
      snake.dir.lat = -snake.dir.lat; // Reverse Lat direction
      snake.dir.lon = -snake.dir.lon; // Reverse Lon direction? No, if (1,0) -> (-1,0). 
      // If we were moving North (-1, 0), we are now at Pole, moving South (1, 0) on opposite side.
      // So yes, lat dir flips. Lon dir?
      // If we hit pole diagonally? Not possible with current controls.
      // Simply: Flip Lat direction.
      snake.dir.lat = 1; // Force South
    } else if (newLat >= GRID_LAT) {
      // Crossed South Pole
      newLat = GRID_LAT - 1;
      newLon = (newLon + GRID_LON / 2) % GRID_LON;
      snake.dir.lat = -1; // Force North
    }

    // Shift body
    for (let i = snake.segments.length - 1; i > 0; i--) {
      snake.segments[i].lat = snake.segments[i-1].lat;
      snake.segments[i].lon = snake.segments[i-1].lon;
    }
    head.lat = newLat;
    head.lon = newLon;
  }

  _growSnake(snake) {
    const tail = snake.segments[snake.segments.length - 1];
    snake.segments.push({
      lat: tail.lat,
      lon: tail.lon,
      visualPos: tail.visualPos.clone(),
      currPos: tail.currPos.clone(),
      prevPos: tail.prevPos.clone()
    });
    // Add mesh
    const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const mat = new THREE.MeshStandardMaterial({
      color: snake.color,
      emissive: snake.color,
      emissiveIntensity: 0.5
    });
    const mesh = new THREE.Mesh(geo, mat);
    snake.group.add(mesh);
  }

  _checkCollisions(snake, isCpu = false) {
    const head = snake.segments[0];
    
    // Bounds (Lat only)
    if (head.lat < 0 || head.lat >= GRID_LAT) return true;

    // Self
    for (let i = 1; i < snake.segments.length; i++) {
      if (head.lat === snake.segments[i].lat && head.lon === snake.segments[i].lon) return true;
    }

    // Against Other
    if (!isCpu && this.mode === MODES.CPU) {
       for (let seg of this.cpuSnake.segments) {
         if (head.lat === seg.lat && head.lon === seg.lon) return true;
       }
    }
    
    return false;
  }

  _checkFood(snake) {
    const head = snake.segments[0];
    return head.lat === this.foodLat && head.lon === this.foodLon;
  }
  
  _spawnFood() {
    this.foodLat = Math.floor(Math.random() * GRID_LAT);
    this.foodLon = Math.floor(Math.random() * GRID_LON);
    const pos = getCellPosition(this.foodLat, this.foodLon, RADIUS);
    this.foodMesh.position.copy(pos);
    this.foodMesh.lookAt(new THREE.Vector3(0,0,0));
  }
  
  _respawnCpu() {
    // Simplified respawn
    this.cpuSnake.segments = [];
    const cpuLat = Math.floor(GRID_LAT / 2);
    const cpuLon = Math.floor(Math.random() * GRID_LON);
    for (let i = 0; i < 5; i++) {
      this.cpuSnake.segments.push({
        lat: cpuLat,
        lon: (cpuLon + i) % GRID_LON,
        visualPos: new THREE.Vector3(),
        currPos: new THREE.Vector3(),
        prevPos: new THREE.Vector3()
      });
    }
    this._rebuildMeshes(this.cpuSnake, this.opponentGroup);
  }

  /* ---------------- CONTROLS & AI ---------------- */

  _processInput() {
    // Replaced by queue system in _tick
  }

  _attemptTurn(newDir) {
    // Deprecated
  }

  _aiThink(snake) {
    // Simple greedy AI
    const head = snake.segments[0];
    const dLat = this.foodLat - head.lat;
    
    // Shortest path around longitude
    let dLon = this.foodLon - head.lon;
    if (dLon > GRID_LON/2) dLon -= GRID_LON;
    if (dLon < -GRID_LON/2) dLon += GRID_LON;

    const moves = [
      { lat: 1, lon: 0 }, { lat: -1, lon: 0 },
      { lat: 0, lon: 1 }, { lat: 0, lon: -1 }
    ];
    
    // Sort moves by distance to food
    moves.sort((a, b) => {
      // Just approximate distance
      const distA = Math.abs((head.lat + a.lat) - this.foodLat) + Math.abs(dLon - a.lon); // rough
      const distB = Math.abs((head.lat + b.lat) - this.foodLat) + Math.abs(dLon - b.lon);
      return distA - distB;
    });

    for (let m of moves) {
      if (m.lat === -snake.dir.lat && m.lon === -snake.dir.lon) continue;
      // Check collision
      const checkLat = head.lat + m.lat;
      const checkLon = (head.lon + m.lon + GRID_LON) % GRID_LON;
      
      let safe = true;
      if (checkLat < 0 || checkLat >= GRID_LAT) safe = false;
      
      // Self collision
      for (let s of snake.segments) {
        if (s.lat === checkLat && s.lon === checkLon) safe = false;
      }
      
      if (safe) {
        snake.dir = m;
        return;
      }
    }
  }

  /* ---------------- VISUALS ---------------- */

  _rebuildMeshes(snakeObj, group) {
    group.clear();
    snakeObj.group = group; // ref
    
    const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const mat = new THREE.MeshStandardMaterial({
      color: snakeObj.color,
      emissive: snakeObj.color,
      emissiveIntensity: 0.5,
      roughness: 0.2,
      metalness: 0.5
    });
    
    const headGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const headMat = mat.clone();
    headMat.emissiveIntensity = 1.0;

    snakeObj.segments.forEach((seg, i) => {
      const mesh = new THREE.Mesh(i===0 ? headGeo : geo, i===0 ? headMat : mat);
      group.add(mesh);
      
      // Init visual positions
      const pos = getCellPosition(seg.lat, seg.lon, RADIUS);
      seg.currPos.copy(pos);
      seg.prevPos.copy(pos);
      mesh.position.copy(pos);
      mesh.lookAt(new THREE.Vector3(0,0,0));
    });
  }

  _updateSegmentTargets(snake) {
    snake.segments.forEach(seg => {
      seg.prevPos.copy(seg.currPos); // The visual position from end of last tick
      const target = getCellPosition(seg.lat, seg.lon, RADIUS);
      seg.currPos.copy(target);
    });
  }

  _updateVisuals(alpha) {
    // Lerp meshes
    [this.snake, this.cpuSnake].forEach(s => {
      if (s.group) {
        s.group.children.forEach((mesh, i) => {
          if (s.segments[i]) {
            const seg = s.segments[i];
            // Slerp on sphere surface would be ideal, but lerp is okay for small steps
            mesh.position.lerpVectors(seg.prevPos, seg.currPos, alpha);
            mesh.lookAt(new THREE.Vector3(0,0,0));
            // Optional: Scale effect on food eat?
          }
        });
      }
    });

    if (this.mode === MODES.REALTIME) {
       this.opponentGroup.children.forEach(g => {
         // Interpolate opponent groups if we implemented full buffer...
         // For now, just snap or basic smoothing handled in _updateOpponents
       });
    }
  }

  _updateCamera() {
    if (this.snake.segments.length < 2) return;
    const headMesh = this.snake.group.children[0];
    const neckMesh = this.snake.group.children[1];
    if (!headMesh || !neckMesh) return;

    const headPos = headMesh.position.clone();
    const up = headPos.clone().normalize();
    
    // Determine forward direction from body trailing
    // This creates the "Follow" effect
    const forward = new THREE.Vector3().subVectors(headPos, neckMesh.position).normalize();
    
    if (forward.lengthSq() < 0.01) return; // Wait for movement

    // Camera Goal: Behind snake, slightly above
    const CAM_DIST = 35;
    const CAM_HEIGHT = 20;

    const targetPos = headPos.clone()
      .sub(forward.multiplyScalar(CAM_DIST)) // Behind
      .add(up.multiplyScalar(CAM_HEIGHT));   // Above

    // Smooth lerp
    this.camera.position.lerp(targetPos, 0.08);
    
    // Ensure camera up vector aligns with planet surface to prevent flipping
    this.camera.up.lerp(up, 0.1);
    this.camera.lookAt(headPos);
  }

  /* ---------------- HIGH SCORE & NET ---------------- */

  async _loadHighScore() {
    // ... reused logic ...
    try {
      const room = this.room || new WebsimSocket();
      this.hsCol = room.collection('sphere_snake_hs_v2'); // new version
      const records = await this.hsCol.getList();
      if (records.length) {
        this.hsId = records[0].id;
        this.best = records[0].score || 0;
      } else {
        const res = await this.hsCol.create({ score: 0 });
        this.hsId = res.id;
      }
      this.onBest(this.best);
    } catch(e) {}
  }

  async _saveHighScoreIfNeeded() {
    if (this.score > this.best && this.hsCol && this.hsId) {
      this.best = this.score;
      this.onBest(this.best);
      this.hsCol.update(this.hsId, { score: this.best });
    }
  }

  _sync() {
    if (!this.room) return;
    const data = this.snake.segments.map(s => ({ la: s.lat, lo: s.lon }));
    this.room.updatePresence({
      snake: data,
      mode: this.mode
    });
  }

  _updateOpponents(peers) {
    this.opponentGroup.clear();
    const myId = this.room.clientId;
    
    Object.entries(peers).forEach(([id, data]) => {
      if (id === myId) return;
      if (!data.snake || data.mode !== MODES.REALTIME) return;
      
      const group = new THREE.Group();
      const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
      const mat = new THREE.MeshStandardMaterial({ color: 0x5588ff, emissive: 0x2244aa });
      
      data.snake.forEach(seg => {
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(getCellPosition(seg.la, seg.lo, RADIUS));
        mesh.lookAt(new THREE.Vector3(0,0,0));
        group.add(mesh);
      });
      
      this.opponentGroup.add(group);
    });
  }
}

/* ---------------- HELPERS ---------------- */

function getCellPosition(latIdx, lonIdx, r) {
  // Map grid to Sphere with slight padding at poles to allow "crossing" over the cap
  const minPhi = 0.05;
  const maxPhi = Math.PI - 0.05;
  
  const phi = minPhi + (latIdx / (GRID_LAT - 1)) * (maxPhi - minPhi);
  const theta = (lonIdx / GRID_LON) * (Math.PI * 2);

  // Standard Physics convention: Y is Up/North Pole here
  // x = r sin(phi) cos(theta)
  // z = r sin(phi) sin(theta)
  // y = r cos(phi)
  
  const x = r * Math.sin(phi) * Math.cos(theta);
  const z = r * Math.sin(phi) * Math.sin(theta);
  const y = r * Math.cos(phi);
  
  return new THREE.Vector3(x, y, z);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}