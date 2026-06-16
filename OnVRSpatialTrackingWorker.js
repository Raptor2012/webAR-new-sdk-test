// Reserved for moving optical flow off the main thread once the prototype passes
// camera-overlay and hit-test smoke gates. The first tracker is intentionally
// main-thread only so iPhone Safari permission and video behavior stay simple.
self.onmessage = function(event) {
  self.postMessage({ type: "unsupported-worker-path", id: event.data && event.data.id });
};
