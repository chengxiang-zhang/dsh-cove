 /**
 * Shared WebView injection scripts used by the service screen.
 * Anchor-slice shared piece — consumers must reuse, not reimplement.
 */

// DSH requires a valid IANA timezone. Some Android WebViews report an empty/offset value.
export const TZ_PATCH = `
(function () {
  try {
    var dto = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      var r = dto.call(this);
      try {
        Object.defineProperty(r, 'timeZone', { value: 'Asia/Shanghai', configurable: true, enumerable: true });
      } catch (e) {}
      return r;
    };
  } catch (e) {}
})();
`;

// Older embedded WebView engines (e.g. some HarmonyOS/Android WebView builds)
// lack ES2024+ APIs that newer DSH client bundles rely on at module
// evaluation time (class-field initializers run immediately). Polyfill the
// missing primitives before any page script executes.
export const POLYFILL_PATCH = `
(function () {
  if (!Promise.withResolvers) {
    try {
      Promise.withResolvers = function () {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    } catch (e) {}
  }
  if (!Object.hasOwn) {
    try {
      Object.hasOwn = function (obj, key) {
        return Object.prototype.hasOwnProperty.call(Object(obj), key);
      };
    } catch (e) {}
  }
  if (!Array.prototype.at) {
    try {
      Array.prototype.at = function (index) {
        var len = this.length >>> 0;
        var k = index === undefined ? 0 : Number(index);
        if (k < 0) k = Math.max(len + k, 0); else k = Math.min(k, len - 1);
        return k < 0 || k >= len ? undefined : this[k];
      };
    } catch (e) {}
  }
  if (!Array.prototype.findLast) {
    try {
      Array.prototype.findLast = function (pred, thisArg) {
        for (var i = this.length - 1; i >= 0; i--) {
          if (pred.call(thisArg, this[i], i, this)) return this[i];
        }
        return undefined;
      };
    } catch (e) {}
  }
  if (!Array.prototype.toSorted) {
    try {
      Array.prototype.toSorted = function (compareFn) {
        var copy = Array.prototype.slice.call(this);
        copy.sort(compareFn);
        return copy;
      };
    } catch (e) {}
  }
  if (!Array.prototype.toReversed) {
    try {
      Array.prototype.toReversed = function () {
        var copy = Array.prototype.slice.call(this);
        copy.reverse();
        return copy;
      };
    } catch (e) {}
  }
  if (!Array.prototype.toSpliced) {
    try {
      Array.prototype.toSpliced = function (start, deleteCount) {
        var args = Array.prototype.slice.call(arguments, 2);
        var copy = Array.prototype.slice.call(this);
        var s = Number(start);
        if (s < 0) s = Math.max(this.length + s, 0);
        copy.splice(s, deleteCount === undefined ? this.length : Number(deleteCount), ...args);
        return copy;
      };
    } catch (e) {}
  }
  if (!String.prototype.at) {
    try {
      String.prototype.at = function (index) {
        var len = this.length >>> 0;
        var k = index === undefined ? 0 : Number(index);
        if (k < 0) k = Math.max(len + k, 0); else k = Math.min(k, len - 1);
        return k < 0 || k >= len ? undefined : this.charAt(k);
      };
    } catch (e) {}
  }
  if (!window.structuredClone) {
    try {
      window.structuredClone = function (value) {
        return JSON.parse(JSON.stringify(value));
      };
    } catch (e) {}
  }
})();
`;

// Official DSH voice input v0.2.0 owns microphone capture and draft insertion.
// This fallback WebView receives no Android-owned voice injection.
