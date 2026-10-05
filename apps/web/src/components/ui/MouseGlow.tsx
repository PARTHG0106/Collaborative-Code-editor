import { useEffect, useRef } from 'react';

/** Decorative pointer feedback without re-rendering a page on every mouse move. */
export function MouseGlow() {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const preference = window.matchMedia('(prefers-reduced-motion: no-preference) and (pointer: fine)');
    let frame = 0;
    let x = 0;
    let y = 0;

    const move = (event: MouseEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        glowRef.current?.style.setProperty('--glow-x', `${x}px`);
        glowRef.current?.style.setProperty('--glow-y', `${y}px`);
      });
    };
    const update = () => {
      window.removeEventListener('mousemove', move);
      cancelAnimationFrame(frame);
      frame = 0;
      if (preference.matches) window.addEventListener('mousemove', move, { passive: true });
    };
    update();
    preference.addEventListener('change', update);
    return () => {
      preference.removeEventListener('change', update);
      window.removeEventListener('mousemove', move);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={glowRef} aria-hidden="true" className="mouse-glow fixed inset-0 pointer-events-none z-0" />;
}
