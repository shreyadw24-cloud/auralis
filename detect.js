import {
  ObjectDetector,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs";

const MODEL_PATH = "./models/efficientdet_lite0.tflite";

const ALLOWED_LABELS = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "bus",
  "truck"
];

let detector = null;
let cameraStream = null;
let animationId = null;
let lastDetectionTime = 0;
let isRunning = false;

let activeVideoEl = null;
let activeCanvasEl = null;

// Create the MediaPipe detector with GPU and CPU fallback.
async function createDetector() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );

  const options = {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    scoreThreshold: 0.5,
    maxResults: 5
  };

  try {
    return await ObjectDetector.createFromOptions(vision, options);
  } catch (gpuError) {
    console.warn("GPU initialization failed. Trying CPU.", gpuError);

    options.baseOptions.delegate = "CPU";

    return await ObjectDetector.createFromOptions(vision, options);
  }
}

// Draw detection boxes and zone boundaries on the canvas.
function drawDetections(canvas, ctx, detections, width, height) {
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);

  // Draw left, centre and right zone boundaries.
  ctx.strokeStyle = "#00FFFF";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);

  ctx.beginPath();
  ctx.moveTo(width / 3, 0);
  ctx.lineTo(width / 3, height);
  ctx.moveTo((width * 2) / 3, 0);
  ctx.lineTo((width * 2) / 3, height);
  ctx.stroke();

  ctx.setLineDash([]);

  detections.forEach((item) => {
    const box = item.boundingBox;
    const label = item.categories?.[0]?.categoryName || "Object";

    ctx.strokeStyle = "#00FF66";
    ctx.lineWidth = 3;

    ctx.strokeRect(
      box.originX,
      box.originY,
      box.width,
      box.height
    );

    ctx.fillStyle = "#00FF66";
    ctx.font = "16px Arial";

    ctx.fillText(
      label,
      box.originX,
      Math.max(18, box.originY - 6)
    );
  });
}

// Start camera detection and report objects through the callback.
export async function startDetection(videoEl, canvasEl, onObjects) {
  // Stop any previous detection session.
  if (isRunning || cameraStream || detector) {
    stopDetection();
  }

  // Store the active video and canvas elements.
  activeVideoEl = videoEl;
  activeCanvasEl = canvasEl;

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not supported by this browser.");
    }

    detector = await createDetector();

    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: 640,
        height: 480
      },
      audio: false
    });

    videoEl.srcObject = cameraStream;
    videoEl.setAttribute("playsinline", "");
    videoEl.muted = true;

    await videoEl.play();

    const ctx = canvasEl.getContext("2d");

    if (!ctx) {
      throw new Error("Could not create the camera overlay.");
    }

    isRunning = true;
    lastDetectionTime = 0;

    // Process video frames at a maximum of five times per second.
    const detectFrame = (timestamp) => {
      if (!isRunning) return;

      animationId = requestAnimationFrame(detectFrame);

      if (
        videoEl.readyState < 2 ||
        timestamp - lastDetectionTime < 200
      ) {
        return;
      }

      lastDetectionTime = timestamp;

      try {
        const results = detector.detectForVideo(videoEl, timestamp);
        const objects = [];

        for (const detection of results.detections || []) {
          const category = detection.categories?.[0];

          if (!category) continue;

          const label = category.categoryName.toLowerCase();

          if (!ALLOWED_LABELS.includes(label)) continue;

          const box = detection.boundingBox;

          const centerX = box.originX + box.width / 2;
          const videoWidth = videoEl.videoWidth;
          const videoHeight = videoEl.videoHeight;

          let zone = "C";

          if (centerX < videoWidth / 3) {
            zone = "L";
          } else if (centerX > (videoWidth * 2) / 3) {
            zone = "R";
          }

          const areaRatio =
            (box.width * box.height) /
            (videoWidth * videoHeight);

          objects.push({
            label,
            score: category.score,
            zone,
            areaRatio
          });
        }

        drawDetections(
          canvasEl,
          ctx,
          results.detections || [],
          videoEl.videoWidth,
          videoEl.videoHeight
        );

        onObjects(objects);

      } catch (error) {
        console.error("Detection error:", error);
        onObjects([]);
      }
    };

    animationId = requestAnimationFrame(detectFrame);

  } catch (error) {
    stopDetection();

    console.error(error);

    throw new Error(
      "Camera could not be started. Allow camera permission in your browser and try again. " +
      error.message
    );
  }
}

// Stop detection and completely release the camera.
export function stopDetection() {
  isRunning = false;

  // Cancel the detection animation loop.
  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  // Stop all camera tracks.
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  // Stop and clear the video element.
  if (activeVideoEl) {
    activeVideoEl.pause();
    activeVideoEl.srcObject = null;
    activeVideoEl = null;
  }

  // Clear the detection canvas.
  if (activeCanvasEl) {
    const ctx = activeCanvasEl.getContext("2d");

    if (ctx) {
      ctx.clearRect(
        0,
        0,
        activeCanvasEl.width,
        activeCanvasEl.height
      );
    }

    activeCanvasEl = null;
  }

  // Close the MediaPipe detector.
  if (detector) {
    detector.close();
    detector = null;
  }

  lastDetectionTime = 0;
}