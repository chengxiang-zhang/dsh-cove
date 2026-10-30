/**
 * The service catalogue: what this window is allowed to offer on the home page.
 *
 * A machine is a service whose address is that machine's own DSH entry, and those come
 * from the fleet reading. Anything else - Superset, a wiki, a dashboard - is an ordinary
 * internal address, and the transport already reaches it: the window's session proxy is
 * the helper's loopback proxy, which dials every request through NetBird and therefore
 * resolves anything NetBird's DNS answers. What was missing was a list to draw and a
 * tab that loads it, which is what this file and the `web` tab kind add.
 *
 * The list is a plain JSON file so a deployment can publish one and a person can edit
 * one; nothing here guesses names.
 */

/** The shape a catalogue entry takes once it has an id, a name and an address. */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const url = String(entry.url ?? '').trim();
  // Only http(s) is a page this window can load; anything else is refused here rather
  // than at navigation time, where the failure would look like a broken service.
  if (!/^https?:\/\//i.test(url)) {
    return null;
  }
  const name = String(entry.name ?? '').trim();
  if (name === '') {
    return null;
  }
  const id = String(entry.id ?? '').trim() || `web:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`;
  return {
    id,
    kind: 'web',
    name,
    subtitle: String(entry.subtitle ?? '').trim(),
    url,
    host: String(entry.host ?? new URL(url).host).trim(),
  };
}

/**
 * Normalizes a catalogue document.
 *
 * Tolerant by design: a deployment file that grows a field this client does not know
 * must still be usable, and one broken entry must not remove the rest.
 *
 * @param {unknown} document
 * @returns {Array<{id: string, kind: 'web', name: string, subtitle: string, url: string, host: string}>}
 */
export function normalizeServices(document) {
  const list = Array.isArray(document) ? document : Array.isArray(document?.services) ? document.services : [];
  const seen = new Set();
  const services = [];
  for (const [index, entry] of list.entries()) {
    const normalized = normalizeEntry(entry, index);
    if (!normalized || seen.has(normalized.id)) {
      continue;
    }
    seen.add(normalized.id);
    services.push(normalized);
  }
  return services;
}

/** Parses a JSON string; a malformed document is an empty catalogue, not a crash. */
export function parseServices(text) {
  try {
    return normalizeServices(JSON.parse(String(text ?? '')));
  } catch {
    return [];
  }
}
