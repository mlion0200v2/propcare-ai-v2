"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function WorkspaceNav({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Workspace" className="flex gap-1 overflow-x-auto md:flex-col">
      {links.map((link) => {
        const active =
          pathname === link.href ||
          pathname.startsWith(`${link.href}/`) ||
          (link.href === "/dashboard" && pathname.startsWith("/tickets/")) ||
          (link.href === "/homes" && pathname.startsWith("/units/"));
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap px-3 py-2.5 text-sm ${
              active ? "bg-sage font-semibold text-pine" : "text-ink hover:bg-paper"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
