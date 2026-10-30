import Link from "next/link";
import { PRIVACY_PATH } from "@/lib/privacy";

/**
 * One-line notice shown BEFORE a form that collects personal data (sign-up, sign-in, recovery, Companion linking). It is information, not a
 * consent request: these flows rest on providing the account the visitor asked for, so there is deliberately no checkbox. The link opens in a
 * new tab so a half-filled form is never lost, and says so for assistive technology.
 */
export function PrivacyNote({ children, anchor }: { children: React.ReactNode; anchor?: "companion" }) {
  return (
    <p className="text-xs text-mist" data-privacy-note>
      {children}{" "}
      <Link href={anchor ? `${PRIVACY_PATH}#${anchor}` : PRIVACY_PATH} target="_blank" rel="noopener noreferrer">
        privacy notice<span className="sr-only"> (opens in a new tab)</span>
      </Link>
      .
    </p>
  );
}
