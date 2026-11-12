// FCA Memory Atlas — Unity WebGL bridge (Electron integration)
// Unity -> JavaScript status/ready notification + JavaScript -> Unity commands.
// Loaded only in WebGL player builds (Assets/Plugins/WebGL is a WebGL-only plugin folder).

mergeInto(LibraryManager.library, {
  // Sends a JSON string with the current nebula/graph state to the embedding page.
  // Electron listens for window 'message' events of type 'fca-unity-state'.
  FCABridge_PushState: function (jsonPtr) {
    var json = UTF8ToString(jsonPtr);
    try {
      var data = JSON.parse(json);
      window.__FCA_NEBULA_STATE__ = data;
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'fca-unity-state', payload: data }, '*');
      }
      try {
        window.dispatchEvent(new CustomEvent('fca-unity-state', { detail: data }));
      } catch (e) { /* older browsers */ }
    } catch (err) {
      console.error('[FCA] Failed to parse Unity state JSON', err, json);
    }
  },

  // Fired once the first real graph has been rendered (Electron can remove its
  // loading overlay). Also sets window.__FCA_READY__ for automation/acceptance.
  FCABridge_NotifyReady: function (jsonPtr) {
    var json = UTF8ToString(jsonPtr);
    var data = {};
    try { data = JSON.parse(json); } catch (e) { data = { raw: json }; }
    window.__FCA_READY__ = true;
    window.__FCA_NEBULA_READY__ = data;
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'fca-unity-ready', payload: data }, '*');
    }
    try {
      window.dispatchEvent(new CustomEvent('fca-unity-ready', { detail: data }));
    } catch (e) { /* older browsers */ }
  },

  // Same-origin screenshot helper used by the acceptance tooling: serialises the
  // Unity canvas to a data URL that the page can POST to its local server.
  FCABridge_GetCanvasDataUrl: function (mimePtr) {
    var mime = UTF8ToString(mimePtr);
    try {
      var canvas = Module.canvas || document.querySelector('#unity-canvas');
      if (!canvas) return 0;
      var url = canvas.toDataURL(mime || 'image/png');
      var buffer = _malloc(lengthBytesUTF8(url) + 1);
      stringToUTF8(url, buffer, lengthBytesUTF8(url) + 1);
      return buffer;
    } catch (e) {
      console.error('[FCA] canvas capture failed', e);
      return 0;
    }
  },

  FCABridge_FreeString: function (ptr) {
    if (ptr) _free(ptr);
  }
});
