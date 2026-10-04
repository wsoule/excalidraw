export const getFullscreenElement = (): Element | null =>
  document.fullscreenElement || (document as any).webkitFullscreenElement;

/** must be called synchronously from a user gesture (click/tap/key) */
export const enterFullscreen = () => {
  const root = document.documentElement as any;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  try {
    // returns a promise in modern browsers, undefined in older Safari
    Promise.resolve(request?.call(root)).catch(() => {});
  } catch {
    // not supported/allowed (e.g. iPhone): present in the browser window
  }
};

export const exitFullscreen = () => {
  if (!getFullscreenElement()) {
    return;
  }
  const exit =
    document.exitFullscreen || (document as any).webkitExitFullscreen;
  try {
    Promise.resolve(exit?.call(document)).catch(() => {});
  } catch {}
};

/** false where pages can't go fullscreen (e.g. iPhone) */
export const isFullscreenSupported = () =>
  !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled);
