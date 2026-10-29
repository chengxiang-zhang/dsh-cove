// Decode the payload of a JWT without verifying its signature.
// The token is already TLS-fetched from the issuer, so signature verification
// is unnecessary for our purposes (extracting claims like email and account id).
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT: expected 3 segments");
  const segment = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  const json = Buffer.from(padded, "base64").toString("utf-8");
  const claims = JSON.parse(json);
  if (typeof claims !== "object" || claims === null) {
    throw new Error("Invalid JWT payload: not a JSON object");
  }
  return claims as Record<string, unknown>;
}
