/** Original AzerDex mark: an eight-point arcane compass rose around a central rune diamond (no third-party art). */
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="azx-violet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c3aef2" />
          <stop offset="1" stopColor="#6c41c7" />
        </linearGradient>
        <linearGradient id="azx-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0dfae" />
          <stop offset="1" stopColor="#c29a52" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="17.5" fill="#11133b" stroke="url(#azx-violet)" strokeWidth="2" />
      <g stroke="url(#azx-violet)" strokeWidth="1.25" strokeLinecap="round" opacity="0.9">
        <path d="M20 5v4.2M20 30.8V35M5 20h4.2M30.8 20H35" />
        <path d="M9.6 9.6l3 3M27.4 27.4l3 3M30.4 9.6l-3 3M12.6 27.4l-3 3" />
      </g>
      <path d="M20 10 27 20 20 30 13 20z" fill="none" stroke="url(#azx-violet)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M20 14 24 20 20 26 16 20z" fill="url(#azx-gold)" />
    </svg>
  );
}
