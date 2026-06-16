(function() {
  "use strict";

  const existing = window.OnVRSpatialTrackerBridge;
  if (existing && existing.__onvrSpatialTrackerVersion) {
    return;
  }

  const States = {
    Unsupported: "Unsupported",
    Idle: "Idle",
    RequestingPermission: "RequestingPermission",
    Initializing: "Initializing",
    Scanning: "Scanning",
    Tracking: "Tracking",
    Limited: "Limited",
    Relocalizing: "Relocalizing",
    Lost: "Lost",
    Error: "Error"
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function median(values) {
    if (!values.length) {
      return 0;
    }
    const copy = values.slice().sort((a, b) => a - b);
    return copy[Math.floor(copy.length * 0.5)];
  }

  function quantile(values, q) {
    if (!values.length) {
      return 0;
    }
    const copy = values.slice().sort((a, b) => a - b);
    return copy[clamp(Math.floor(copy.length * q), 0, copy.length - 1)];
  }

  function makePose(x, y, z, yaw) {
    const half = (yaw || 0) * 0.5;
    return {
      position: { x, y, z },
      rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }
    };
  }

  function toGray(imageData) {
    const data = imageData.data;
    const gray = new Uint8ClampedArray(imageData.width * imageData.height);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
      gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    }
    return gray;
  }

  const bridge = {
    __onvrSpatialTrackerVersion: "0.1.0",
    receiverName: null,
    stream: null,
    video: null,
    canvas: null,
    ctx: null,
    frameWidth: 640,
    frameHeight: 360,
    running: false,
    raf: 0,
    frame: 0,
    state: States.Idle,
    prevGray: null,
    features: [],
    planes: [],
    anchors: {},
    nextAnchorId: 1,
    lastTimestamp: 0,
    fps: 0,
    limitedFrames: 0,
    lostFrames: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    cameraPosition: { x: 0, y: 0, z: 0 },
    lastMotionAt: 0,

    setUnityReceiver(receiverName) {
      this.receiverName = receiverName;
    },

    isSupported() {
      const secure = location.protocol === "https:" ||
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1";
      return secure && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    checkCapability() {
      this.sendState(this.isSupported() ? States.Idle : States.Unsupported,
        this.isSupported() ? "Tap Start AR to enable spatial tracking." : "Camera tracking requires Safari over HTTPS.");
    },

    async startTracker() {
      if (!this.isSupported()) {
        this.sendState(States.Unsupported, "Camera tracking requires Safari over HTTPS.");
        return;
      }

      this.stopTracker(false);
      this.sendState(States.RequestingPermission, "Requesting camera and motion permission...");

      try {
        await this.requestMotionPermission();
        this.ensureVideo();
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });

        this.video.srcObject = this.stream;
        this.video.style.display = "block";
        this.video.style.visibility = "visible";
        this.video.style.opacity = "1";
        await this.video.play();

        this.ensureTrackingCanvas();
        this.resetMap();
        this.running = true;
        this.sendState(States.Initializing, "Initializing visual tracker...");
        this.raf = requestAnimationFrame((time) => this.tick(time));
      } catch (error) {
        const name = error && error.name ? error.name : "";
        const permissionDenied = name === "NotAllowedError" || name === "PermissionDeniedError";
        this.sendState(permissionDenied ? States.Error : States.Error,
          permissionDenied ? "Camera or motion permission was denied." : ((error && error.message) || "Spatial tracker failed to start."));
      }
    },

    stopTracker(notify = true) {
      this.running = false;
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }

      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }

      if (this.video) {
        this.video.pause();
        this.video.srcObject = null;
        this.video.style.display = "none";
      }

      if (notify) {
        this.sendState(States.Idle, "Spatial tracking stopped.");
      }
    },

    resetTracker() {
      this.resetMap();
      this.sendAnchors();
      if (this.running) {
        this.sendState(States.Scanning, "Move slowly and aim at textured floor or table detail.");
      }
    },

    requestHitTest(screenX01, screenY01) {
      const hit = this.hitTest(screenX01, screenY01);
      this.send("OnSpatialHitTest", JSON.stringify(hit));
    },

    createAnchor(planeId, px, py, pz, rx, ry, rz, rw) {
      const anchorId = "anchor-" + this.nextAnchorId++;
      const plane = this.planes.find((candidate) => candidate.planeId === planeId) || this.planes[0] || null;
      this.anchors[anchorId] = {
        anchorId,
        trackingState: this.state === States.Lost ? States.Lost : States.Tracking,
        pose: {
          position: { x: px, y: py, z: pz },
          rotation: { x: rx, y: ry, z: rz, w: rw || 1 }
        },
        confidence: plane ? plane.confidence : 0.45,
        attachedPlaneId: plane ? plane.planeId : planeId,
        lastUpdatedFrame: this.frame
      };
      this.send("OnSpatialAnchorCreated", anchorId);
      this.sendAnchors();
    },

    removeAnchor(anchorId) {
      delete this.anchors[anchorId];
      this.sendAnchors();
    },

    async requestMotionPermission() {
      const orientationType = window.DeviceOrientationEvent;
      if (orientationType && typeof orientationType.requestPermission === "function") {
        const result = await orientationType.requestPermission();
        if (result !== "granted") {
          throw new Error("Motion permission was denied.");
        }
      }

      const motionType = window.DeviceMotionEvent;
      if (motionType && typeof motionType.requestPermission === "function") {
        const result = await motionType.requestPermission();
        if (result !== "granted") {
          throw new Error("Motion permission was denied.");
        }
      }

      if (!this.motionListenerAttached) {
        window.addEventListener("deviceorientation", (event) => {
          this.yaw = Number.isFinite(event.alpha) ? event.alpha * Math.PI / 180 : this.yaw;
          this.pitch = Number.isFinite(event.beta) ? event.beta * Math.PI / 180 : this.pitch;
          this.roll = Number.isFinite(event.gamma) ? event.gamma * Math.PI / 180 : this.roll;
          this.lastMotionAt = performance.now();
        }, true);
        this.motionListenerAttached = true;
      }
    },

    ensureVideo() {
      this.video = document.getElementById("onvr-spatial-video") || document.getElementById("onvr-webar-video");
      if (!this.video) {
        this.video = document.createElement("video");
        this.video.id = "onvr-spatial-video";
        document.body.insertBefore(this.video, document.body.firstChild);
      }

      this.video.setAttribute("autoplay", "");
      this.video.setAttribute("muted", "");
      this.video.setAttribute("playsinline", "");
      this.video.muted = true;
      this.video.playsInline = true;
      Object.assign(this.video.style, {
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        objectFit: "cover",
        background: "#000",
        display: "block",
        zIndex: "0"
      });
    },

    ensureTrackingCanvas() {
      if (!this.canvas) {
        this.canvas = document.createElement("canvas");
        this.canvas.width = this.frameWidth;
        this.canvas.height = this.frameHeight;
        this.canvas.style.display = "none";
        document.body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
      }
    },

    resetMap() {
      this.frame = 0;
      this.prevGray = null;
      this.features = [];
      this.planes = [];
      this.anchors = {};
      this.cameraPosition = { x: 0, y: 0, z: 0 };
      this.limitedFrames = 0;
      this.lostFrames = 0;
      this.state = States.Initializing;
    },

    tick(timestamp) {
      if (!this.running) {
        return;
      }

      this.raf = requestAnimationFrame((time) => this.tick(time));
      if (!this.video || this.video.readyState < 2) {
        return;
      }

      if (this.lastTimestamp) {
        const instantFps = 1000 / Math.max(1, timestamp - this.lastTimestamp);
        this.fps = this.fps ? this.fps * 0.9 + instantFps * 0.1 : instantFps;
      }
      this.lastTimestamp = timestamp;

      this.ctx.drawImage(this.video, 0, 0, this.frameWidth, this.frameHeight);
      const gray = toGray(this.ctx.getImageData(0, 0, this.frameWidth, this.frameHeight));
      let tracked = [];

      if (this.prevGray && this.features.length) {
        tracked = this.trackFeatures(this.prevGray, gray, this.features);
        this.applyCameraMotion(tracked);
        this.features = tracked.filter((feature) => feature.inlier);
      }

      if (this.features.length < 90 || this.frame % 12 === 0) {
        this.features = this.mergeFeatures(this.features, this.detectFeatures(gray));
      }

      this.updateTrackingState(tracked);
      this.updatePlanes();
      this.sendCameraPose();
      this.updateAnchors();
      this.sendStats(tracked);
      this.prevGray = gray;
      this.frame++;
    },

    detectFeatures(gray) {
      const width = this.frameWidth;
      const height = this.frameHeight;
      const cellSize = 24;
      const candidates = [];

      for (let cy = 1; cy < Math.floor(height / cellSize) - 1; cy++) {
        for (let cx = 1; cx < Math.floor(width / cellSize) - 1; cx++) {
          let bestScore = 0;
          let bestX = 0;
          let bestY = 0;
          const x0 = cx * cellSize;
          const y0 = cy * cellSize;

          for (let y = y0 + 3; y < y0 + cellSize - 3; y += 2) {
            for (let x = x0 + 3; x < x0 + cellSize - 3; x += 2) {
              const i = y * width + x;
              const gx = gray[i + 1] - gray[i - 1];
              const gy = gray[i + width] - gray[i - width];
              const gxx = Math.abs(gx);
              const gyy = Math.abs(gy);
              const score = Math.min(gxx, gyy) * 2 + Math.max(gxx, gyy);
              if (score > bestScore) {
                bestScore = score;
                bestX = x;
                bestY = y;
              }
            }
          }

          if (bestScore > 34) {
            candidates.push({ x: bestX, y: bestY, score: bestScore, age: 0, inlier: true });
          }
        }
      }

      return candidates.sort((a, b) => b.score - a.score).slice(0, 240);
    },

    mergeFeatures(existing, detected) {
      const merged = existing.slice(0, 180);
      for (const feature of detected) {
        let near = false;
        for (const current of merged) {
          const dx = current.x - feature.x;
          const dy = current.y - feature.y;
          if (dx * dx + dy * dy < 100) {
            near = true;
            break;
          }
        }
        if (!near) {
          merged.push(feature);
        }
        if (merged.length >= 220) {
          break;
        }
      }
      return merged;
    },

    trackFeatures(prev, next, features) {
      const width = this.frameWidth;
      const height = this.frameHeight;
      const patch = 4;
      const search = 7;
      const tracked = [];

      for (const feature of features) {
        if (feature.x < patch + search || feature.y < patch + search ||
          feature.x > width - patch - search - 1 || feature.y > height - patch - search - 1) {
          continue;
        }

        let bestError = Infinity;
        let bestDx = 0;
        let bestDy = 0;

        for (let dy = -search; dy <= search; dy += 2) {
          for (let dx = -search; dx <= search; dx += 2) {
            let error = 0;
            for (let py = -patch; py <= patch; py += 2) {
              const prevRow = (feature.y + py) * width;
              const nextRow = (feature.y + dy + py) * width;
              for (let px = -patch; px <= patch; px += 2) {
                error += Math.abs(prev[prevRow + feature.x + px] - next[nextRow + feature.x + dx + px]);
              }
            }
            if (error < bestError) {
              bestError = error;
              bestDx = dx;
              bestDy = dy;
            }
          }
        }

        if (bestError < 1700) {
          tracked.push({
            x: feature.x + bestDx,
            y: feature.y + bestDy,
            px: feature.x,
            py: feature.y,
            dx: bestDx,
            dy: bestDy,
            score: Math.max(1, feature.score * 0.985),
            age: (feature.age || 0) + 1,
            error: bestError,
            inlier: true
          });
        }
      }

      if (tracked.length < 6) {
        return tracked;
      }

      const mdx = median(tracked.map((feature) => feature.dx));
      const mdy = median(tracked.map((feature) => feature.dy));
      for (const feature of tracked) {
        const residual = Math.hypot(feature.dx - mdx, feature.dy - mdy);
        feature.inlier = residual < 5.5;
      }

      return tracked;
    },

    applyCameraMotion(tracked) {
      const inliers = tracked.filter((feature) => feature.inlier);
      if (inliers.length < 8) {
        return;
      }

      const dx = median(inliers.map((feature) => feature.dx));
      const dy = median(inliers.map((feature) => feature.dy));
      this.cameraPosition.x -= dx / this.frameWidth * 0.06;
      this.cameraPosition.z += dy / this.frameHeight * 0.05;
    },

    updateTrackingState(tracked) {
      const inlierCount = tracked.filter ? tracked.filter((feature) => feature.inlier).length : 0;
      const total = this.features.length;
      const ratio = total ? inlierCount / total : 0;
      let nextState = this.state;
      let message = "";

      if (this.frame < 8) {
        nextState = States.Initializing;
        message = "Initializing visual tracker...";
      } else if (total < 35) {
        nextState = States.Scanning;
        message = "Move slowly and aim at textured floor or table detail.";
      } else if (ratio > 0.44 && total > 65) {
        nextState = States.Tracking;
        message = "Surface found. Tap the reticle to place.";
        this.limitedFrames = 0;
        this.lostFrames = 0;
      } else if (ratio > 0.22 && total > 35) {
        nextState = States.Limited;
        message = "Limited tracking. Move slowly near textured detail.";
        this.limitedFrames++;
      } else {
        this.lostFrames++;
        nextState = this.lostFrames > 20 ? States.Lost : States.Relocalizing;
        message = nextState === States.Lost ? "Tracking lost. Return to the scanned area." : "Relocalizing...";
      }

      if (nextState !== this.state || this.frame % 30 === 0) {
        this.state = nextState;
        this.sendState(nextState, message);
      }
    },

    updatePlanes() {
      if (this.state !== States.Tracking && this.state !== States.Limited) {
        if (this.frame % 20 === 0) {
          this.sendPlanes();
        }
        return;
      }

      const stable = this.features.filter((feature) => feature.age > 6 && feature.inlier);
      if (stable.length < 35) {
        this.sendPlanes();
        return;
      }

      const ys = stable.map((feature) => feature.y / this.frameHeight);
      const lowerBand = ys.filter((value) => value > 0.46);
      const horizontalConfidence = clamp(lowerBand.length / 90, 0.25, 0.92);
      const spread = quantile(stable.map((feature) => feature.x), 0.85) - quantile(stable.map((feature) => feature.x), 0.15);
      const ext = clamp(spread / this.frameWidth * 2.5, 0.7, 2.8);
      const z = clamp(1.25 + (median(lowerBand.length ? lowerBand : ys) - 0.5) * 1.3, 0.8, 2.4);
      const plane = {
        planeId: "plane-horizontal-0",
        kind: "horizontal",
        pose: makePose(this.cameraPosition.x, -0.72, z + this.cameraPosition.z, 0),
        center: { x: this.cameraPosition.x, y: -0.72, z: z + this.cameraPosition.z },
        extents: { x: ext, y: ext },
        confidence: horizontalConfidence,
        lastUpdatedFrame: this.frame
      };

      const verticalFeatures = stable.filter((feature) => feature.y / this.frameHeight < 0.56);
      this.planes = [plane];
      if (verticalFeatures.length > 80) {
        this.planes.push({
          planeId: "plane-vertical-0",
          kind: "vertical",
          pose: makePose(this.cameraPosition.x, 0.15, 2.1 + this.cameraPosition.z, 0),
          center: { x: this.cameraPosition.x, y: 0.15, z: 2.1 + this.cameraPosition.z },
          extents: { x: 1.5, y: 1.0 },
          confidence: clamp(verticalFeatures.length / 170, 0.22, 0.65),
          lastUpdatedFrame: this.frame
        });
      }

      if (this.frame % 5 === 0) {
        this.sendPlanes();
      }
    },

    hitTest(screenX01, screenY01) {
      const plane = this.planes[0];
      if (!plane || plane.confidence < 0.35) {
        return { hit: false, planeId: "", pose: makePose(0, 0, 0, 0), extents: { x: 0, y: 0 }, confidence: 0 };
      }

      const aspect = Math.max(0.5, window.innerWidth / Math.max(1, window.innerHeight));
      const nx = clamp(screenX01, 0, 1) - 0.5;
      const ny = clamp(screenY01, 0, 1) - 0.5;
      const distance = plane.pose.position.z;
      const worldX = plane.pose.position.x + nx * aspect * distance * 1.35;
      const worldZ = plane.pose.position.z + ny * distance * 0.85;
      const extX = plane.extents.x * 0.5;
      const extZ = plane.extents.y * 0.5;
      const clampedX = clamp(worldX, plane.pose.position.x - extX, plane.pose.position.x + extX);
      const clampedZ = clamp(worldZ, plane.pose.position.z - extZ, plane.pose.position.z + extZ);
      const offPlane = Math.hypot(worldX - clampedX, worldZ - clampedZ);
      const confidence = clamp(plane.confidence - offPlane * 0.25, 0, 1);

      return {
        hit: confidence > 0.35,
        planeId: plane.planeId,
        pose: makePose(clampedX, plane.pose.position.y, clampedZ, 0),
        extents: plane.extents,
        confidence
      };
    },

    updateAnchors() {
      const ids = Object.keys(this.anchors);
      if (!ids.length || this.frame % 5 !== 0) {
        return;
      }

      for (const id of ids) {
        const anchor = this.anchors[id];
        anchor.trackingState = this.state === States.Lost || this.state === States.Relocalizing ? this.state : States.Tracking;
        anchor.confidence = this.state === States.Tracking ? 0.82 : (this.state === States.Limited ? 0.45 : 0.12);
        anchor.lastUpdatedFrame = this.frame;
      }
      this.sendAnchors();
    },

    sendState(state, message) {
      this.state = state;
      this.send("OnSpatialState", JSON.stringify({ state, message: message || "" }));
    },

    sendStats(tracked) {
      if (this.frame % 10 !== 0) {
        return;
      }

      const inlierCount = tracked && tracked.filter ? tracked.filter((feature) => feature.inlier).length : 0;
      this.send("OnSpatialStats", JSON.stringify({
        frame: this.frame,
        fps: this.fps || 0,
        featureCount: this.features.length,
        trackedFeatureCount: inlierCount,
        planeCount: this.planes.length,
        driftWarning: this.state === States.Limited ? 0.45 : (this.state === States.Lost ? 1 : 0),
        message: ""
      }));
    },

    sendPlanes() {
      this.send("OnSpatialPlanes", JSON.stringify({ planes: this.planes }));
    },

    sendCameraPose() {
      if (this.frame % 5 !== 0) {
        return;
      }

      this.send("OnSpatialCameraPose", JSON.stringify(makePose(
        this.cameraPosition.x,
        this.cameraPosition.y,
        this.cameraPosition.z,
        -this.yaw
      )));
    },

    sendAnchors() {
      this.send("OnSpatialAnchors", JSON.stringify({ anchors: Object.values(this.anchors) }));
    },

    send(methodName, payload) {
      if (!this.receiverName) {
        return;
      }

      if (typeof SendMessage === "function") {
        SendMessage(this.receiverName, methodName, payload || "");
        return;
      }

      if (window.uarGameInstance && typeof window.uarGameInstance.SendMessage === "function") {
        window.uarGameInstance.SendMessage(this.receiverName, methodName, payload || "");
      }
    }
  };

  window.OnVRSpatialTrackerBridge = bridge;
})();
