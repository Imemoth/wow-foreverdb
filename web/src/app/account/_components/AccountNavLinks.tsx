"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/account", label: "Account" },
  { href: "/account/installations", label: "My Installations" },
  { href: "/account/devices", label: "Devices" },
  { href: "/account/guildbook", label: "Guildbook" },
];

export function AccountNavLinks() {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className="account-menu-item" aria-current={pathname === n.href ? "page" : undefined}>
          {n.label}
        </Link>
      ))}
    </>
  );
}
