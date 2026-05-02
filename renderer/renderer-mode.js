// Selects which character backend to use. 'vrm' = three.js + three-vrm,
// 'svg' = the original drawn 2D version. Set BEFORE app.js loads.
window.RENDERER = 'vrm';

// Face-debugging mode: when true, the camera frames just the head so we can
// see the face features clearly. Toggle off for normal full-body rendering.
// Icon-capture flag. Triggers HEAD_ZOOM with a custom frame size that
// fits Claude's whole head + mane silhouette, then exits.
const _params = new URLSearchParams(location.search);
window.CAPTURE_ICON  = _params.get('capture') === 'icon';
window.HEAD_ZOOM     = window.CAPTURE_ICON;
// Vertical extent in world meters of what HEAD_ZOOM frames. Default
// 0.5 fits just the head sphere; 1.6 fits the whole mane including
// petals. Override here only when capturing the icon.
window.HEAD_ZOOM_FIT = window.CAPTURE_ICON ? 1.05 : 0.5;
