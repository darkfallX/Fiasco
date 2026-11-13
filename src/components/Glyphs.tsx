import React from "react";

type IconProps = {
  className?: string;
};

export function GlyphPlay({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4.5 3L12.5 8L4.5 13V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" />
    </svg>
  );
}

export function GlyphPause({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M5 3.5V12.5M11 3.5V12.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
    </svg>
  );
}

export function GlyphStep({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3.5 3.5L9.5 8L3.5 12.5V3.5Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.5V12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function GlyphFastForward({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 4L7.5 8L2.5 12V4Z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 4L13.5 8L8.5 12V4Z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function GlyphReset({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 8A5 5 0 1 0 4.8 4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M2.5 2.5V5.5H5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
    </svg>
  );
}

export function GlyphLock({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5A2.5 2.5 0 0 1 10.5 5V7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function GlyphAudio({ muted, className = "h-3.5 w-3.5" }: IconProps & { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M3 6.2H5.6L9 3.5V12.5L5.6 9.8H3V6.2Z" stroke="currentColor" strokeWidth="1.4" />
      {muted ? (
        <path d="M11.5 6L14 10M14 6L11.5 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      ) : (
        <path d="M11.3 5.7A3 3 0 0 1 11.3 10.3M13 4A5.2 5.2 0 0 1 13 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
      )}
    </svg>
  );
}

export function GlyphClose({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}

export function GlyphExternal({ className = "h-3 w-3" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6.5 3.5H12.5V9.5M12.5 3.5L5.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" />
      <path d="M10.5 11.5V13H3V5.5H4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" />
    </svg>
  );
}
