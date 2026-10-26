"use client";

// Small stroke icons shared by the Account dropdown and the dashboard (no icon dependency). Decorative: always aria-hidden.
function Svg({ className = "h-4 w-4", children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
type P = { className?: string };

export const PersonIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" /></Svg>
);
export const LogInIcon = (p: P) => (
  <Svg {...p}><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="m10 17 5-5-5-5" /><path d="M15 12H3" /></Svg>
);
export const LogOutIcon = (p: P) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></Svg>
);
export const UserPlusIcon = (p: P) => (
  <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></Svg>
);
export const InstallIcon = (p: P) => (
  <Svg {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M12 7v6m-3-3 3 3 3-3M12 17v4M8 21h8" /></Svg>
);
export const MonitorIcon = (p: P) => (
  <Svg {...p}><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8M12 17v4" /></Svg>
);
export const BookIcon = (p: P) => (
  <Svg {...p}><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></Svg>
);
export const ChevronDownIcon = (p: P) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
export const ArrowRightIcon = (p: P) => (
  <Svg {...p}><path d="M5 12h14m-7-7 7 7-7 7" /></Svg>
);
export const CircleUserIcon = (p: P) => (
  <Svg {...p}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="10" r="3" /><path d="M7 20.66V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.66" /></Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>
);
