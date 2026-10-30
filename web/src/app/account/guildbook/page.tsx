import { notFound } from "next/navigation";

export const metadata = { title: "Guildbook" };

// The Guildbook is stored only on the user's computer (Companion-local); the website never shows it.
export default function GuildbookPage(): never {
  notFound();
}
