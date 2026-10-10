import Link from "next/link";

export const metadata = { title: "Not found", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4 py-10 text-center">
      <p className="font-[family-name:var(--font-display)] text-6xl text-bronze-400">404</p>
      <h1 className="text-2xl font-semibold text-parchment">Nothing observed here</h1>
      <p className="text-mist">
        This page does not exist, or no ForeverDB player has observed this entry yet. Missing data is common in an
        observation database — it does not mean the thing does not exist in game.
      </p>
      <div className="flex justify-center gap-2">
        <Link className="btn-gold" href="/database">Search the database</Link>
        <Link className="btn-ghost" href="/">Home</Link>
      </div>
    </div>
  );
}
