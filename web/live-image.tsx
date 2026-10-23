import React, { useState, useRef, useEffect } from 'react';
export function LiveImage(props: {
  src: string;
  alt: string;
  className?: string;
  onLoad: () => void;
  onError: () => void;
}) {
  const [frame, setFrame] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const next = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFrame((n) => n + 1), delay);
  };
  return (
    <img
      className={props.className}
      alt={props.alt}
      src={`${props.src}${props.src.includes('?') ? '&' : '?'}frame=${frame}`}
      onLoad={() => {
        props.onLoad();
        next(500);
      }}
      onError={() => {
        props.onError();
        next(1500);
      }}
    />
  );
}
