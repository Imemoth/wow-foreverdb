/** Original ForeverDB mark: an hourglass-rune inside a faceted shield (no third-party art). */
export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="fdb-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f3d38a" />
          <stop offset="1" stopColor="#a8703c" />
        </linearGradient>
      </defs>
      <path d="M20 2 35 9v11c0 9-6.3 15.4-15 18C11.3 35.4 5 29 5 20V9z" fill="#141821" stroke="url(#fdb-g)" strokeWidth="2" />
      <path d="M13 11h14l-7 9 7 9H13l7-9z" fill="none" stroke="url(#fdb-g)" strokeWidth="2" strokeLinejoin="round" />
      <path d="M17 26h6" stroke="#e6b95c" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
