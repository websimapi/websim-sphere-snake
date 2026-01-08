import * as THREE from 'three';

const GRID_LAT = 30;
const GRID_LON = 60;
const RADIUS = 15;
const TICK_MS = 100; // Faster tick for smoother response perception, interpolated visuals

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
    
    // Default Snake State
    this.snake = {
      segments: [], // Array of { lat, lon, visualPos(Vec3) }
      dir: { lat: 0, lon: 1 },
      nextDir: { lat: 0, lon: 1 },
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
    this.keys = { ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
    
    window.addEventListener('keydown', (e) => {
      if (this.keys.hasOwnProperty(e.code)) this.keys[e.code] = true;
      if (['w','a','s','d'].includes(e.key)) {
        const map = { w: 'ArrowUp', s: 'ArrowDown', a: 'ArrowLeft', d: 'ArrowRight' };
        this.keys[map[e.key]] = true;
      }
    });
    window.addEventListener('keyup', (e) => {
      if (this.keys.hasOwnProperty(e.code)) this.keys[e.code] = false;
      if (['w','a','s','d'].includes(e.key)) {
        const map = { w: 'ArrowUp', s: 'ArrowDown', a: 'ArrowLeft', d: 'ArrowRight' };
        this.keys[map[e.key]] = false;
      }
    });

    // Touch Swipe Logic
    let startX = 0, startY = 0;
    this.renderer.domElement.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, {passive: false});

    this.renderer.domElement.addEventListener('touchmove', (e) => {
      // Prevent scrolling
      e.preventDefault(); 
    }, {passive: false});

    this.renderer.domElement.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      
      if (Math.abs(dx) > 30 || Math.abs(dy) > 30) {
        if (Math.abs(dx) > Math.abs(dy)) {
          // Horizontal
          if (dx > 0) this._attemptTurn({ lat: 0, lon: 1 }); // Right
          else this._attemptTurn({ lat: 0, lon: -1 }); // Left
        } else {
          // Vertical
          if (dy > 0) this._attemptTurn({ lat: 1, lon: 0 }); // Down
          else this._attemptTurn({ lat: -1, lon: 0 }); // Up
        }
      }
    });
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
    
    // Init Player
    this.snake.dir = { lat: 0, lon: 1 };
    this.snake.nextDir = { lat: 0, lon: 1 };
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
    // 1. Move Player
    this.snake.dir = this.snake.nextDir;
    this._moveSnake(this.snake);

    // 2. Move CPU
    if (this.mode === MODES.CPU) {
      this._aiThink(this.cpuSnake);
      this._moveSnake(this.cpuSnake);
    }

    // 3. Collision Checks
    if (this._checkCollisions(this.snake)) {
      this.isRunning = false;
      this.onGameOver();
      return;
    }
    
    // CPU Collision check (CPU just dies, doesn't end game unless you hit it)
    if (this.mode === MODES.CPU && this._checkCollisions(this.cpuSnake, true)) {
       // Respawn CPU
       this._respawnCpu();
    }

    // 4. Food Logic
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

    // 5. Sync State for Visuals
    // Update 'prevPos' and 'currPos' for all segments for interpolation
    this._updateSegmentTargets(this.snake);
    if (this.mode === MODES.CPU) this._updateSegmentTargets(this.cpuSnake);

    // 6. Network
    this._sync();
  }

  _moveSnake(snake) {
    const head = snake.segments[0];
    const newLat = clamp(head.lat + snake.dir.lat, 0, GRID_LAT - 1);
    const newLon = (head.lon + snake.dir.lon + GRID_LON) % GRID_LON;
    
    // Shift body logic
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
    // Desktop Keys
    if (this.keys.ArrowUp) this._attemptTurn({ lat: 1, lon: 0 }); // Note: Lat increases UP?
    // Actually in 3D sphere:
    // Lat 0 = top, Lat Max = bottom? Or Lat 0 = North pole?
    // In our math: lat index 0..GRID_LAT.
    // Let's assume index 0 is North Pole (Top), GRID_LAT is South.
    // So "UP" key should DECREASE lat index.
    if (this.keys.ArrowUp) this._attemptTurn({ lat: 1, lon: 0 });
    if (this.keys.ArrowDown) this._attemptTurn({ lat: -1, lon: 0 });
    if (this.keys.ArrowLeft) this._attemptTurn({ lat: 0, lon: -1 });
    if (this.keys.ArrowRight) this._attemptTurn({ lat: 0, lon: 1 });
  }

  _attemptTurn(newDir) {
    // Prevent 180 reverses
    if (newDir.lat === -this.snake.dir.lat && newDir.lon === -this.snake.dir.lon) return;
    this.snake.nextDir = newDir;
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
    if (!this.snake.segments[0]) return;
    const headMesh = this.snake.group.children[0];
    if (!headMesh) return;

    const headPos = headMesh.position.clone();
    const normal = headPos.clone().normalize();
    
    // Position camera "above" and "behind"
    // We need a "forward" vector. 
    // Since we are on a sphere, "forward" is tangential.
    // We can approximate by taking (Head - PreviousHead).
    // Or just simply pull camera out along normal and add some lag.

    const targetCamPos = normal.multiplyScalar(RADIUS + 25);
    
    // Smooth camera
    this.camera.position.lerp(targetCamPos, 0.1);
    this.camera.lookAt(headPos); // Always look at head
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
  // Map grid to Sphere
  // Lat: 0 to GRID_LAT. 0 = North Pole? No, let's map 0..LAT to -PI/2 .. PI/2
  // Avoid poles slightly to prevent texture pinching if we had textures, but for grid it's fine.
  
  const phi = (latIdx / (GRID_LAT - 1)) * Math.PI; // 0 to PI
  const theta = (lonIdx / GRID_LON) * (Math.PI * 2); // 0 to 2PI

  // Spherical to Cartesian
  // y is up
  const x = r * Math.sin(phi) * Math.cos(theta);
  const z = r * Math.sin(phi) * Math.sin(theta);
  const y = r * Math.cos(phi);
  
  return new THREE.Vector3(x, y, z);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}