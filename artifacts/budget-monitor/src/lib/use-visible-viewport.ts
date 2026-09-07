import { useLayoutEffect } from 'react';

/** Keep dialogs above mobile keyboards without disabling browser zoom. */
export function useVisibleViewport() {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      root.style.setProperty('--app-visible-height', `${viewport.height}px`);
      root.style.setProperty('--app-visible-top', `${viewport.offsetTop}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
      root.style.removeProperty('--app-visible-height');
      root.style.removeProperty('--app-visible-top');
    };
  }, []);
}