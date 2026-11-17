/* Tiny test harness that runs both in the browser (tests/index.html) and in Node (tests/run-node.js). */
(function (global) {
  'use strict';

  const tests = [];
  function test(name, fn, opts) {
    tests.push({ name, fn, timeout: (opts && opts.timeout) || 20000 });
  }

  class AssertionError extends Error {}
  const fmt = (v) => {
    try {
      return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `Uint8Array(${x.length})` : x));
    } catch (e) {
      return String(v);
    }
  };
  const assert = {
    ok(v, msg) {
      if (!v) throw new AssertionError(msg || `expected truthy, got ${fmt(v)}`);
    },
    equal(a, b, msg) {
      if (a !== b) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(b)}, got ${fmt(a)}`);
    },
    deepEqual(a, b, msg) {
      if (fmt(a) !== fmt(b)) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(b)}, got ${fmt(a)}`);
    },
    bytes(a, b, msg) {
      if (!(a instanceof Uint8Array) || a.length !== b.length || a.some((x, i) => x !== b[i])) {
        throw new AssertionError(`${msg ? msg + ': ' : ''}bytes differ (got ${a && a.length}, expected ${b.length})`);
      }
    },
    async rejects(p, re, msg) {
      try {
        await p;
      } catch (e) {
        if (re && !re.test(e.message)) throw new AssertionError(`${msg ? msg + ': ' : ''}error "${e.message}" doesn't match ${re}`);
        return e;
      }
      throw new AssertionError(msg || 'expected a rejection');
    },
  };

  /** Deterministic random numbers for fault injection. */
  function seededRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
  }

  async function run(report) {
    let passed = 0;
    let failed = 0;
    const started = Date.now();
    for (const t of tests) {
      const t0 = Date.now();
      try {
        await Promise.race([
          Promise.resolve().then(t.fn),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${t.timeout} ms`)), t.timeout)),
        ]);
        passed++;
        report({ ok: true, name: t.name, ms: Date.now() - t0 });
      } catch (e) {
        failed++;
        report({ ok: false, name: t.name, ms: Date.now() - t0, error: (e && e.stack) || String(e) });
      }
    }
    return { passed, failed, total: tests.length, ms: Date.now() - started };
  }

  global.T = { test, assert, run, seededRng };
})(typeof window !== 'undefined' ? window : globalThis);
