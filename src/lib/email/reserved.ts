/**
 * Reserved example domains (RFC 2606 / 6761): example.com/.org/.net and the
 * .example, .test, .invalid, .localhost TLDs. Demo and test users use them;
 * the mailer never sends to them.
 */
export function isReservedAddress(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  return (
    domain === "example.com" ||
    domain === "example.org" ||
    domain === "example.net" ||
    /\.example\.(com|org|net)$/.test(domain) ||
    /\.(example|test|invalid|localhost)$/.test(domain)
  );
}
