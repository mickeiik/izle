// @ts-check
// The admin page's one door to localStorage. In a private window, with blocked site data or a full quota every
// access can throw: then nothing is remembered and the page still works (the token stays in memory for the tab,
// see api.js).

/** @param {string} key */
export function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Remembers `value`; returns whether the browser kept it.
 * @param {string} key @param {string} value
 */
export function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function forgetStored(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing to forget
  }
}
