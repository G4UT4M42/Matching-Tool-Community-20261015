/**
 * HTTP settings are an untrusted disclosure surface. Deny all raw values by
 * default rather than guessing which names may contain credentials or PII.
 */
const READABLE_SETTINGS = new Set(['paypal_sandbox']);

export function settingForHttp(key: string, value: string | null): {
  key: string;
  is_set: boolean;
  value?: string | null;
  masked: string | null;
} {
  const result = {
    key,
    is_set: value !== null,
    masked: value !== null ? '[configured]' : null,
  };
  if (READABLE_SETTINGS.has(key)) {
    return { ...result, value };
  }
  return result;
}
