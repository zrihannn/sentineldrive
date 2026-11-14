const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm';
const EYES = { left: [362, 385, 387, 263, 373, 380], right: [33, 160, 158, 133, 153, 144] };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = values => { const sorted=[...values].sort((a,b)=>a-b); const mid=Math.floor(sorted.length/2); return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2; };
const distance = (a, b, width, height) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
const pointMean = points => ({ x: mean(points.map(p => p.x)), y: mean(points.map(p => p.y)) });

function ear(landmarks, width, height, indexes) {
  const [a,b,c,d,e,f] = indexes.map(index => landmarks[index]);
  const v1 = distance(b,f,width,height), v2 = distance(c,e,width,height), h = distance(a,d,width,height);
  return h ? (v1 + v2) / (2 * h) : 0;
}
function mar(landmarks, width, height) {
  const vertical = [distance(landmarks[81],landmarks[178],width,height),distance(landmarks[13],landmarks[14],width,height),distance(landmarks[311],landmarks[402],width,height)];
  const horizontal = distance(landmarks[78],landmarks[308],width,height);
  return horizontal ? mean(vertical) / horizontal : 0;
}
function poseFrom(result, landmarks) {
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (matrix?.length >= 16) {
    return {
      pitch: Math.atan2(matrix[6], matrix[10]) * 180 / Math.PI,
      yaw: Math.asin(clamp(-matrix[2], -1, 1)) * 180 / Math.PI,
      roll: Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI,
      source: 'facial transformation matrix'
    };
  }
  const eyeMid = pointMean([landmarks[33], landmarks[263]]);
  const nose = landmarks[1];
  const mouthMid = pointMean([landmarks[13], landmarks[14]]);
  const eyeWidth = Math.max(.001, Math.abs(landmarks[33].x - landmarks[263].x));
  const faceHeight = Math.max(.001, mouthMid.y - eyeMid.y);
  return {
    yaw: ((nose.x - eyeMid.x) / eyeWidth) * 65,
    pitch: ((nose.y - (eyeMid.y + mouthMid.y) / 2) / faceHeight) * 50,
    roll: 0,
    source: 'landmark estimate'
  };
}
function gazeFrom(landmarks) {
  const eyes = [
    { iris: landmarks[468], outer: landmarks[33], inner: landmarks[133] },
    { iris: landmarks[473], outer: landmarks[362], inner: landmarks[263] }
  ];
  return mean(eyes.map(({ iris, outer, inner }) => {
    const span = inner.x - outer.x;
    return span ? ((iris.x - (outer.x + inner.x) / 2) / Math.abs(span)) * 2 : 0;
  }));
}

export class VisionEngine {
  constructor({ video, canvas, onMetrics = () => {}, onLost = () => {}, onStatus = () => {} }) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onMetrics = onMetrics;
    this.onLost = onLost;
    this.onStatus = onStatus;
    this.landmarker = null;
    this.stream = null;
    this.raf = 0;
    this.lastVideoTime = -1;
    this.lastFaceAt = 0;
    this.lastLostAt = 0;
    this.lastFrameAt = 0;
    this.fps = 0;
    this.fpsFrames = 0;
    this.fpsWindowAt = 0;
    this.frameCount = 0;
    this.inferenceTimes = [];
    this.signalWindow = [];
    this.lastMetrics = null;
    this.signalWindow = [];
    this.baseline = null;
    this.running = false;
    this.cameras = [];
    this.cameraId = null;
    this.processing = false;
  }

  async initialize() {
    if (this.landmarker) return;
    this.onStatus('LOADING FACE LANDMARKER');
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO', numFaces: 1,
      minFaceDetectionConfidence: .65,
      minFacePresenceConfidence: .65,
      minTrackingConfidence: .65,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true
    };
    try { this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options); }
    catch (gpuError) {
      options.baseOptions.delegate = 'CPU';
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, options);
      this.onStatus('FACE LANDMARKER READY · CPU MODE');
    }
    this.onStatus('FACE LANDMARKER READY');
  }

  async start(deviceId = null) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS in a supported browser.');
    if (this.stream) this.stop(false);
    await this.initialize();
    const constraints = { audio: false, video: { deviceId: deviceId ? { exact: deviceId } : undefined, facingMode: deviceId ? undefined : 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    await this.video.play();
    this.cameraId = this.stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
    this.cameras = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
    this.lastVideoTime = -1;
    this.lastFaceAt = 0;
    this.lastLostAt = 0;
    this.running = true;
    this.frameCount = 0;
    this.inferenceTimes = [];
    this.signalWindow = [];
    this.raf = requestAnimationFrame(this.loop);
    return { label: this.stream.getVideoTracks()[0]?.label || 'Camera', width: this.video.videoWidth, height: this.video.videoHeight, cameras: this.cameras };
  }

  stop(closeModel = false) {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const stream = this.stream;
    this.stream = null;
    stream?.getTracks().forEach(track => track.stop());
    this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastMetrics = null;
    this.cameraId = null;
    this.cameras = [];
    this.processing = false;
    if (closeModel && this.landmarker) { this.landmarker.close(); this.landmarker = null; }
    this.onLost();
    this.onStatus('ENGINE STANDBY');
  }

  async switchCamera() {
    if (this.cameras.length < 2) throw new Error('Only one camera is available.');
    const index = this.cameras.findIndex(camera => camera.deviceId === this.cameraId);
    const next = this.cameras[(index + 1) % this.cameras.length];
    return this.start(next.deviceId);
  }

  setBaseline(baseline) { this.baseline = baseline || null; }

  loop = (now) => {
    if (!this.running) return;
    if (this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime && !this.processing) {
      this.lastVideoTime = this.video.currentTime;
      this.processing = true;
      const started = performance.now();
      try {
        const result = this.landmarker.detectForVideo(this.video, now);
        const elapsed = performance.now() - started;
        this.inferenceTimes.push(elapsed);
        if (this.inferenceTimes.length > 90) this.inferenceTimes.shift();
        this.frameCount += 1;
        this.fpsFrames += 1;
        if (!this.fpsWindowAt) this.fpsWindowAt = now;
        if (now - this.fpsWindowAt >= 1000) { this.fps = this.fpsFrames * 1000 / (now - this.fpsWindowAt); this.fpsFrames = 0; this.fpsWindowAt = now; }
        const landmarks = result.faceLandmarks?.[0];
        if (landmarks?.length >= 478) {
          this.lastFaceAt = now;
          this.lastLostAt = 0;
          const metrics = this.analyze(result, landmarks, elapsed);
          this.lastMetrics = metrics;
          this.draw(landmarks);
          this.onMetrics(metrics);
        } else if (now - this.lastFaceAt > 350 && now - this.lastLostAt > 700) {
          this.lastLostAt = now;
          this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this.onLost();
        }
      } catch (error) {
        console.error('Face Landmarker inference failed:', error);
        this.onStatus('INFERENCE ERROR');
      } finally { this.processing = false; }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  analyze(result, landmarks, inferenceMs) {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    const leftEAR = ear(landmarks, width, height, EYES.left);
    const rightEAR = ear(landmarks, width, height, EYES.right);
    const raw = { ear: mean([leftEAR, rightEAR]), mar: mar(landmarks, width, height) };
    const rawPose = poseFrom(result, landmarks);
    raw.pitch = rawPose.pitch; raw.yaw = rawPose.yaw; raw.roll = rawPose.roll; raw.gazeX = gazeFrom(landmarks);
    this.signalWindow.push(raw);
    if (this.signalWindow.length > 3) this.signalWindow.shift();
    const filtered = key => median(this.signalWindow.map(sample => sample[key]));
    const eyeRatio = filtered('ear');
    const mouthRatio = filtered('mar');
    const pose = { pitch: filtered('pitch'), yaw: filtered('yaw'), roll: filtered('roll'), source: rawPose.source };
    const gazeX = filtered('gazeX');
    if (!this.baseline) this.baseline = { pitch: pose.pitch, yaw: pose.yaw, roll: pose.roll, gazeX, ear: eyeRatio, provisional: true };
    const base = this.baseline;
    const pitchDelta = pose.pitch - (base.pitch || 0);
    const yawDelta = pose.yaw - (base.yaw || 0);
    const rollDelta = pose.roll - (base.roll || 0);
    const gazeDelta = gazeX - (base.gazeX || 0);
    const poseDeviation = Math.max(Math.abs(pitchDelta), Math.abs(yawDelta), Math.abs(rollDelta) * .7);
    const gazeDeviation = Math.abs(gazeDelta);
    const box = this.bounds(landmarks);
    const faceArea = (box.width * box.height);
    const centrePenalty = Math.hypot(box.cx - .5, box.cy - .48);
    const sizePenalty = faceArea < .04 ? .45 : faceArea > .8 ? .35 : 0;
    const trackingQuality = Math.round(clamp(100 - centrePenalty * 100 - sizePenalty * 45, 35, 99));
    return {
      ear: eyeRatio, earRaw: raw.ear, leftEAR, rightEAR, mar: mouthRatio, marRaw: raw.mar,
      pitch: pose.pitch, yaw: pose.yaw, roll: pose.roll,
      pitchDelta, yawDelta, rollDelta, poseDeviation,
      gazeX, gazeDelta, gazeDeviation,
      landmarkCount: landmarks.length,
      poseSource: pose.source,
      trackingConfidence: trackingQuality,
      fps: this.fps,
      inferenceMs,
      eyesClosed: false,
      yawning: false,
      faceCount: 1,
      box
    };
  }

  bounds(landmarks) {
    const xs = landmarks.map(point => point.x), ys = landmarks.map(point => point.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    return { left, right, top, bottom, width: right-left, height: bottom-top, cx: (left+right)/2, cy: (top+bottom)/2 };
  }

  draw(landmarks) {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (!width || !height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    const ctx = this.ctx;
    ctx.clearRect(0,0,width,height);
    const trace = (points, color, lineWidth = 1.35, close = false) => {
      ctx.beginPath();
      points.forEach((index, position) => { const p = landmarks[index]; if (!p) return; const x=p.x*width,y=p.y*height; if (!position) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
      if (close) ctx.closePath(); ctx.strokeStyle=color; ctx.lineWidth=lineWidth; ctx.lineJoin='round'; ctx.stroke();
    };
    const outline=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];
    const leftEye=[362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
    const rightEye=[33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
    const lips=[61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95];
    trace(outline,'rgba(132,210,158,.88)',1.4,true);
    trace(leftEye,'rgba(179,225,190,.95)',1.35,true); trace(rightEye,'rgba(179,225,190,.95)',1.35,true);
    trace(lips,'rgba(229,184,133,.9)',1.25,true);
    trace([168,6,197,195,5,4,1,19,94,2,164],'rgba(140,194,157,.5)',1.05,false);
    ctx.fillStyle='rgba(170,221,183,.58)';
    for(let i=0;i<landmarks.length;i+=5){const p=landmarks[i];ctx.beginPath();ctx.arc(p.x*width,p.y*height,1,0,Math.PI*2);ctx.fill();}
    [468,473].forEach(index=>{const p=landmarks[index];ctx.beginPath();ctx.arc(p.x*width,p.y*height,4,0,Math.PI*2);ctx.fillStyle='#eff9ef';ctx.fill();ctx.beginPath();ctx.arc(p.x*width,p.y*height,2,0,Math.PI*2);ctx.fillStyle='#4c9b69';ctx.fill();});
  }

  get streamActive() { return Boolean(this.stream); }
  get telemetry() { return { frames: this.frameCount, averageInference: mean(this.inferenceTimes), fps: this.fps, cameras: this.cameras }; }
}
