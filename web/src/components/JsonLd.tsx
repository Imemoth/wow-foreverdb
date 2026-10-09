/**
 * The ONLY place raw markup is emitted. Content is JSON built from validated
 * server data, with "<" escaped so it can never close the script element.
 */
export function JsonLd({ data, nonce }: { data: Record<string, unknown>; nonce: string | undefined }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // eslint-disable-next-line react/no-danger -- audited: escaped JSON-LD only
  return <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: json }} />;
}
