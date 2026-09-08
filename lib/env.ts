/**
 * Environment access, validated at the point of use.
 *
 * Deliberately not validated at module load: a missing variable should surface
 * as a clear error on the request that needed it, not as an opaque build-time
 * crash that makes the whole app unbootable.
 */
function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env.local and fill in your Supabase keys.`,
    );
  }
  return value;
}

export const supabaseUrl = () =>
  required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);

export const supabaseAnonKey = () =>
  required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

/** Server-only. Bypasses RLS, so it must never reach a browser bundle. */
export const supabaseServiceKey = () =>
  required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * The origin players' phones must reach, used to build the QR code.
 *
 * Falls back to Vercel's own URL so a preview or production deploy needs no
 * configuration. Running locally for a real room means setting this to the
 * laptop's LAN address — `localhost` in a QR code resolves to the phone itself,
 * which is the single most common way this fails at an event.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;

  return "http://localhost:3000";
}
